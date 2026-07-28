#!/usr/bin/env python3
"""
Agent Mode — single web LLM with tool calling, ReAct loop, and compaction.

Usage:
  python3 agent_main.py "Your task"
  python3 agent_main.py --platform gemini "Your task"
  python3 agent_main.py --max-turns 20 --timeout 600 "Your task"
  python3 agent_main.py --tools bash,read_file,write_file "Your task"

Architecture:
  Chrome CDP → Playwright → BaseAdapter → AgentLoop (ReAct) → Tools
                                                      └→ Compactor
"""

import argparse, asyncio, json, logging, os, sys, time

from playwright.async_api import async_playwright

from common import cdp_url, setup_logging
from adapters import ADAPTER_REGISTRY, GeminiAdapter, DeepSeekAdapter
from agent_loop import AgentLoop, ToolRegistry, create_default_tools
from compactor import ContextCompactor, DEFAULT_CHAR_THRESHOLD

log = setup_logging("agent")

SHARED_CDP_PORT = "9222"
DEFAULT_TIMEOUT = 300
DEFAULT_MAX_TURNS = 15


async def run_agent(adapter, prompt: str, tools: ToolRegistry,
                    timeout_s: int, max_turns: int,
                    compact_threshold: int, shared_context) -> dict:
    """Run a single agent with ReAct loop."""
    name = adapter.name
    page = None
    try:
        page = await adapter.connect(context=shared_context)
        await adapter.ensure_fresh_conversation(page)

        # Platform-specific init
        if isinstance(adapter, GeminiAdapter):
            await adapter.ensure_pro_extended(page)
        if isinstance(adapter, DeepSeekAdapter):
            await adapter.ensure_expert_mode(page)
            await adapter.ensure_deep_think(page)

        await adapter.ensure_ready(page)

        compactor = ContextCompactor(adapter, char_threshold=compact_threshold)

        loop = AgentLoop(
            adapter, tools=tools, max_turns=max_turns,
            timeout_ms=timeout_s * 1000,
            on_tool_call=lambda n, a: log.info("[%s] Tool: %s(%s)", name, n,
                                               json.dumps(a, ensure_ascii=False)),
            on_text=lambda t: log.info("[%s] Text: %d chars", name, len(t)),
            compactor=compactor,
        )

        final_answer, state = await loop.run(
            page, task=prompt, compact_threshold=compact_threshold)

        return {
            "platform": name, "success": True,
            "answer": final_answer, "length": len(final_answer),
            "iterations": state.iteration,
            "tool_calls": state.tool_calls_made,
        }

    except asyncio.TimeoutError:
        log.error("[%s] TIMEOUT after %ds", name, timeout_s)
        return {"platform": name, "success": False, "error": "TIMEOUT"}
    except Exception as e:
        log.error("[%s] FAILED: %s", name, e)
        return {"platform": name, "success": False, "error": str(e)}
    finally:
        await adapter.cleanup()


async def main():
    parser = argparse.ArgumentParser(description="Web LLM Agent with tools + ReAct")
    parser.add_argument("prompt", nargs="?")
    parser.add_argument("--platform", type=str, default="gemini")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    parser.add_argument("--compact", type=int, default=DEFAULT_CHAR_THRESHOLD,
                        help=f"Compaction char threshold (default: {DEFAULT_CHAR_THRESHOLD})")
    parser.add_argument("--no-compact", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--tools", type=str, default="bash,read_file,write_file",
                        help="Comma-separated tool names (default: bash,read_file,write_file)")
    args = parser.parse_args()

    prompt = args.prompt
    if not prompt:
        if not sys.stdin.isatty():
            prompt = sys.stdin.read().strip()
        if not prompt:
            print("Usage: python3 agent_main.py 'your task'", file=sys.stderr)
            sys.exit(1)

    platform = args.platform.lower()
    if platform not in ADAPTER_REGISTRY:
        print(f"Unknown platform: {platform}. Available: {list(ADAPTER_REGISTRY.keys())}",
              file=sys.stderr)
        sys.exit(1)

    # Build tools
    all_tools = create_default_tools()
    requested = [t.strip() for t in args.tools.split(",") if t.strip()]
    tools = ToolRegistry()
    for name in requested:
        td = all_tools._tools.get(name)
        if td:
            tools.register(td.name, td.description, td.fn, td.parameters)
        else:
            log.warning("Unknown tool: %s", name)

    compact_threshold = 0 if args.no_compact else args.compact

    adapter = ADAPTER_REGISTRY[platform](cdp_port=SHARED_CDP_PORT)
    log.info("Agent: %s | tools=%s | max_turns=%d | compact=%d",
             platform, ",".join(tools._tools.keys()), args.max_turns, compact_threshold)
    log.info("Prompt: %s", prompt[:120])

    start = time.time()

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(cdp_url(SHARED_CDP_PORT))
        shared_context = browser.contexts[0]
        await shared_context.grant_permissions(["clipboard-read", "clipboard-write"])

        result = await run_agent(
            adapter, prompt, tools, args.timeout, args.max_turns,
            compact_threshold, shared_context)

    elapsed = time.time() - start

    if args.json:
        output = {
            "question": prompt, "elapsed_seconds": round(elapsed, 1),
            "platform": platform, "success": result["success"],
        }
        if result["success"]:
            output["answer"] = result["answer"]
            output["iterations"] = result["iterations"]
            output["tool_calls"] = result["tool_calls"]
        else:
            output["error"] = result.get("error", "unknown")
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        if result["success"]:
            print(f"\n{'='*60}")
            print(f"  {result['platform']} ({result['length']} chars, "
                  f"{result['iterations']} turns, {result['tool_calls']} tools)")
            print(f"{'='*60}")
            print(result["answer"])
        else:
            print(f"\n{'='*60}")
            print(f"  {result['platform']} ❌ FAILED: {result.get('error')}")
            print(f"{'='*60}")

    log.info("Done in %.0fs", elapsed)

    return result


if __name__ == "__main__":
    asyncio.run(main())
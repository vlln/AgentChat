#!/usr/bin/env python3
"""
ReAct execution loop and tool registry for web LLM agents.

Tool call format: <tool_call>{"name":"bash","args":{"cmd":"ls"}}</tool_call>
Tool result format: <tool_result>...output...</tool_result>

Designed to work with AgentChat's BaseAdapter (async Playwright).
"""

import asyncio, json, logging, re, subprocess, time
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger("agent_loop")

TOOL_CALL_RE = re.compile(r"<tool_call>(.*?)</tool_call>", re.DOTALL)
FINAL_ANSWER_RE = re.compile(
    r"<final_answer>(.*?)</final_answer>", re.DOTALL | re.IGNORECASE
)


# ── Tool Registry ────────────────────────────────────────────────────────────

@dataclass
class ToolDef:
    name: str
    description: str
    fn: Callable[..., str]
    parameters: dict[str, Any] = field(default_factory=dict)


class ToolRegistry:
    """Register and execute tools for web LLM agents."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolDef] = {}

    def register(self, name: str, description: str, fn: Callable[..., str],
                 parameters: dict[str, Any] | None = None) -> None:
        self._tools[name] = ToolDef(name=name, description=description, fn=fn,
                                     parameters=parameters or {})

    def unregister(self, name: str) -> None:
        self._tools.pop(name, None)

    def execute(self, name: str, args: dict[str, Any]) -> str:
        tool = self._tools.get(name)
        if tool is None:
            return f"Error: unknown tool '{name}'. Available: {list(self._tools.keys())}"
        try:
            return str(tool.fn(**args)) if args else str(tool.fn())
        except Exception as e:
            return f"Error executing tool '{name}': {e}"

    def format_tools_prompt(self) -> str:
        if not self._tools:
            return ""
        lines = [
            "## Available Tools",
            "",
            "To use a tool, output EXACTLY:",
            '<tool_call>{"name":"<tool_name>","args":{...}}</tool_call>',
            "The tool result will be injected as <tool_result>...</tool_result>.",
            "After receiving results, you may call more tools or give your final answer.",
            "When finished, wrap your final answer in <final_answer>...</final_answer>.",
            "",
            "Tools:",
        ]
        for name, tool in self._tools.items():
            params = ", ".join(f"{k}: {v.get('type','string')}"
                               for k, v in tool.parameters.items())
            lines.append(f"  - {name}({params}): {tool.description}")
        return "\n".join(lines)

    def has_tools(self) -> bool:
        return len(self._tools) > 0


# ── Default tools ────────────────────────────────────────────────────────────

def _default_bash(cmd: str) -> str:
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=60, cwd=".")
        out = r.stdout
        if r.stderr:
            out += "\n[stderr]\n" + r.stderr
        if r.returncode != 0:
            out += f"\n[exit code: {r.returncode}]"
        return out.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: command timed out after 60s"
    except Exception as e:
        return f"Error: {e}"


def _read_file(path: str) -> str:
    import os
    if not os.path.isfile(path):
        return f"Error: file not found: {path}"
    try:
        return open(path).read()
    except Exception as e:
        return f"Error reading {path}: {e}"


def _write_file(path: str, content: str) -> str:
    with open(path, "w") as f:
        f.write(content)
    return f"Wrote {len(content)} bytes to {path}"


def create_default_tools() -> ToolRegistry:
    r = ToolRegistry()
    r.register("bash", "Run a shell command and return output", _default_bash,
               {"cmd": {"type": "string", "description": "Shell command"}})
    r.register("read_file", "Read a file's contents", _read_file,
               {"path": {"type": "string", "description": "File path"}})
    r.register("write_file", "Write content to a file", _write_file,
               {"path": {"type": "string", "description": "File path"},
                "content": {"type": "string", "description": "Content to write"}})
    return r


# ── Agent Loop ────────────────────────────────────────────────────────────────

@dataclass
class LoopState:
    task: str
    iteration: int = 0
    tool_calls_made: int = 0
    total_tool_output: int = 0
    history: list[dict] = field(default_factory=list)


class AgentLoop:
    """ReAct execution loop for a web LLM via AgentChat adapters.

    Thought → Action → Observation → Thought → ... → Final Answer
    """

    def __init__(self, adapter, tools: ToolRegistry | None = None,
                 max_turns: int = 15, timeout_ms: int = 300_000,
                 on_tool_call: Callable | None = None,
                 on_text: Callable | None = None,
                 compactor=None):
        self._adapter = adapter
        self._tools = tools or ToolRegistry()
        self._max_turns = max_turns
        self._timeout_ms = timeout_ms
        self._on_tool_call = on_tool_call
        self._on_text = on_text
        self._compactor = compactor

    async def run(self, page, task: str, system_prompt: str = "",
                  compact_threshold: int = 0) -> tuple[str, LoopState]:
        """Run the ReAct loop to completion."""
        state = LoopState(task=task)

        # Build initial prompt
        parts = []
        if system_prompt:
            parts.append(system_prompt)
        if self._tools.has_tools():
            parts.append(self._tools.format_tools_prompt())
        parts.append(f"## Task\n{task}")
        full_prompt = "\n\n".join(parts)

        await self._adapter.clear_input(page)
        await self._adapter.inject_prompt(page, full_prompt)
        await self._adapter.trigger_send(page)

        while state.iteration < self._max_turns:
            state.iteration += 1

            response = await self._adapter.wait_response(
                page, timeout_ms=self._timeout_ms)
            if not response:
                continue

            if self._on_text:
                self._on_text(response)
            state.history.append({"role": "assistant", "content": response})

            # Check for final answer
            m = FINAL_ANSWER_RE.search(response)
            if m:
                log.info("[AgentLoop] Final answer at turn %d", state.iteration)
                return m.group(1).strip(), state

            # Check for tool calls
            tool_calls = TOOL_CALL_RE.findall(response)
            if not tool_calls:
                return response.strip(), state

            # Execute tools
            results = []
            for tc in tool_calls:
                try:
                    data = json.loads(tc)
                except json.JSONDecodeError:
                    results.append(
                        f"<tool_result>Error: invalid JSON: {tc[:200]}</tool_result>")
                    continue
                name = data.get("name", "")
                args = data.get("args", {})
                if self._on_tool_call:
                    self._on_tool_call(name, args)
                result = self._tools.execute(name, args)
                results.append(f"<tool_result>{result}</tool_result>")
                state.tool_calls_made += 1
                state.total_tool_output += len(result)

            tool_output = "\n".join(results)
            state.history.append({"role": "tool", "content": tool_output})

            await self._adapter.clear_input(page)
            await self._adapter.inject_prompt(page, tool_output)
            await self._adapter.trigger_send(page)

            # Compaction check
            if compact_threshold > 0 and self._compactor:
                if await self._compactor.should_compact(page):
                    await self._compactor.compact(page, state)

        return f"[Max turns ({self._max_turns})]\n{response}", state

    def _extract_final_answer(self, text: str) -> str | None:
        m = FINAL_ANSWER_RE.search(text)
        return m.group(1).strip() if m else None

    @staticmethod
    def is_tool_call(text: str) -> bool:
        return bool(TOOL_CALL_RE.search(text))

    @staticmethod
    def parse_tool_calls(text: str) -> list[dict[str, Any]]:
        results = []
        for m in TOOL_CALL_RE.finditer(text):
            try:
                results.append(json.loads(m.group(1)))
            except json.JSONDecodeError:
                results.append({"error": "invalid JSON", "raw": m.group(1)[:200]})
        return results
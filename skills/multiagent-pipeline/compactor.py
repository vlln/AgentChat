#!/usr/bin/env python3
"""
Context compaction and session handoff for web LLM agents.

When the conversation grows too large:
1. Ask LLM to self-summarize
2. Start a new conversation
3. Inject summary + task state as context
4. Continue execution
"""

import logging
from typing import Any

log = logging.getLogger("compactor")

CHARS_PER_TOKEN = 3
DEFAULT_TOKEN_THRESHOLD = 50_000
DEFAULT_CHAR_THRESHOLD = DEFAULT_TOKEN_THRESHOLD * CHARS_PER_TOKEN

COMPACTION_PROMPT = """\
## Context Compaction Request

The conversation has grown too long. Please summarize ALL key information below
into a structured context summary. The summary will be used to continue the work
in a new conversation.

Include:
- **Completed tasks**: what was done, with results
- **Current state**: exact progress, which step we're on
- **Pending tasks**: what still needs to be done
- **Key files**: file paths modified or created
- **Important findings**: errors, discoveries, decisions
- **Active tool outputs**: any critical data from tool executions

Format your response as a single concise summary — no <final_answer> or <tool_call> tags.
Just output the summary text directly.
"""


class ContextCompactor:
    """Compress conversation history and hand off to a new session."""

    def __init__(self, adapter, char_threshold: int = DEFAULT_CHAR_THRESHOLD):
        self._adapter = adapter
        self._char_threshold = char_threshold

    async def should_compact(self, page) -> bool:
        """Check if conversation exceeds the threshold."""
        try:
            total = await page.evaluate(
                """() => {
                    const area = document.querySelector(
                        'main, [role="main"], .conversation, .chat-content-list, [class*="chat"]'
                    );
                    return area ? (area.textContent || '').length : 0;
                }"""
            )
            return total > self._char_threshold
        except Exception:
            return False

    async def compact(self, page, loop_state: Any) -> bool:
        """Perform full compaction + handoff cycle."""
        log.info("[Compactor] Starting compaction...")

        await self._adapter.clear_input(page)
        await self._adapter.inject_prompt(page, COMPACTION_PROMPT)
        await self._adapter.trigger_send(page)

        try:
            summary = await self._adapter.wait_response(page, timeout_ms=120_000)
        except Exception as e:
            log.warning("[Compactor] Summary failed: %s", e)
            return False

        if not summary or len(summary) < 50:
            log.warning("[Compactor] Summary too short (%d chars)", len(summary))
            return False

        log.info("[Compactor] Summary extracted: %d chars", len(summary))

        # Start fresh conversation
        await self._adapter.ensure_fresh_conversation(page)
        await self._adapter.ensure_ready(page)

        # Build handoff
        handoff = self._build_handoff_prompt(summary, loop_state)

        await self._adapter.clear_input(page)
        await self._adapter.inject_prompt(page, handoff)
        await self._adapter.trigger_send(page)

        log.info("[Compactor] Handoff complete")
        return True

    @staticmethod
    def _build_handoff_prompt(summary: str, loop_state: Any) -> str:
        task = getattr(loop_state, "task", "Unknown")
        iteration = getattr(loop_state, "iteration", 0)
        tool_calls = getattr(loop_state, "tool_calls_made", 0)
        return (
            f"## Previous Session Context\n\n"
            f"The following is a summary of a previous conversation. "
            f"Please continue from where it left off.\n\n"
            f"### Summary\n{summary}\n\n"
            f"### Current Task\n{task}\n\n"
            f"### Progress\n"
            f"- Iterations: {iteration}\n"
            f"- Tool calls made: {tool_calls}\n\n"
            f"### Instructions\n"
            f"Continue working on the task. Use <tool_call> for tools, "
            f"<final_answer> when done.\n"
        )

    @staticmethod
    def estimate_tokens(text: str) -> int:
        return max(1, len(text) // CHARS_PER_TOKEN)

    @staticmethod
    def estimate_tokens_from_messages(messages: list[dict]) -> int:
        total = sum(len(m.get("content", "")) for m in messages)
        return ContextCompactor.estimate_tokens(" " * total)
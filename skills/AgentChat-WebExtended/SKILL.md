---
name: AgentChat-WebExtended
description: >-
  Multi-provider CDP bridge with automatic fallback
  (Gemini→ChatGPT→Claude→Qwen→Kimi→MiniMax→MiMo→DeepSeek→Doubao). Use for AI
  provider failover, fallback chain, multi-provider routing, or "send to any
  available AI". A run is proven by its `[receipt] AGENTCHAT_RUN` line on stderr
  — no receipt means no run happened.
license: MIT
metadata:
  author: vlln
  version: "0.1.0"
requires:
  bins:
    - node
---

# AgentChat-WebExtended — Multi-Provider CDP Bridge

Priority chain: Gemini (Pro Extended) → ChatGPT → Claude → Qwen → Kimi →
MiniMax → MiMo → DeepSeek → Doubao. First available provider wins; each step
falls through only on confirmed unavailability (quota/auth/model-degraded),
never on transient network errors.

`$_S` denotes this skill's own directory. Set it before running:
```bash
export _S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # or the skill's absolute path
```

## Contract

Input: prompt over argv or stdin. Output: AI response on stdout (success),
diagnostics on stderr. Every real run — including failures — emits a receipt
line on stderr:

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx","skill":"AgentChat-WebExtended","exit":0,"provider_used":"Gemini",...}
```

A run is proven by its receipt. `run_id` is random and persisted to
`data/receipts.jsonl`, so a fabricated receipt fails a `grep <run_id>` check.
If you (the caller AI) skip the run and answer from model knowledge instead,
there is no receipt — detectable, not a matter of trust. `--smoke` and
`--doctor` are the only modes that intentionally emit no receipt.

## Prerequisites

```bash
# Chrome with CDP on 9222, using a profile with AI logins.
cp .env.example .env   # set CHROMIUM_PATH to system Chrome + CHROME_PROFILE
bash scripts/start-chrome-debug.sh
node "$_S/index.js" --doctor   # confirm CDP reachable
```

One-time manual login per provider in that Chrome profile (Gemini, ChatGPT,
Claude, Qwen, Kimi, MiniMax, MiMo, DeepSeek, Doubao).

## Invocation

```bash
node "$_S/index.js" "Your prompt"
echo "Prompt from stdin" | node "$_S/index.js"
node "$_S/index.js" --from=ChatGPT "prompt"     # start from a provider
node "$_S/index.js" --only=Kimi "prompt"         # exactly one, no cascade
node "$_S/index.js" --timeout=600000 "long prompt..."
node "$_S/index.js" --smoke      # reachability of all providers
node "$_S/index.js" --doctor       # CDP only
```

| Flag | Meaning |
|------|---------|
| `--timeout=N` | total budget ms (all provider attempts), default 600000 |
| `--timeout-per-provider=N` | per-provider ceiling ms, default `timeout/2` or 180000 |
| `--from=NAME` | start from NAME, skip earlier chain entries (case-insensitive, abbreviation ok) |
| `--single` | try only the `--from` provider, no cascade; for callers owning their own fallback+locks |
| `--only=NAME` | `--from=NAME --single` combined; unknown NAME fails loudly |
| `--close` / `--close-browser` | close tabs/connection after run (default: keep) |

## Exit codes

| Exit | Meaning |
|------|---------|
| 0 | success — response on stdout |
| 1 | Chrome CDP unreachable |
| 2 | all providers auth-gated (not logged in) |
| 3 | safety filter rejected (tried all) |
| 4 | internal error |
| 5 | all providers rate-limited |
| 9 | all providers exhausted, mixed reasons |
| 10 | total timeout, no complete response |

## Fallback chain

```
Gemini → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek → Doubao
(Pro Extended)                                                                (last resort)
```

Each provider passes a 3-layer check before sending: reachability (page
loads / not auth-gated), usability (editor editable / not quota-hit), model
quality (Gemini-only: Pro Extended → Flash → degraded). Degradation triggers
live in each adapter's `quotaPatterns` — that file is the source of truth;
this doc keeps no second copy.

## Output

- stdout: AI response text on success.
- stderr: diagnostics, `[fallback]`-prefixed, plus the receipt line.
- telemetry: `data/fallback-telemetry.jsonl` (provider_used, providers_tried,
  fallback_reasons, prompt/response lengths, total_ms, exit_code).

## Gotchas

- A shared Chrome must be running on CDP 9222. `--doctor` does an HTTP probe;
  a flaky WS handshake (HTTP 502 on upgrade) is an environment issue — restart
  the Chrome daemon, don't treat it as a code bug.
- Every provider needs a one-time login in the Chrome profile. An auth-gated
  provider fails as `reason: 'auth'` within seconds of navigation.
- DOM scraping breaks when a provider rewrites its UI. Selector drift is the
  brittle edge; `dumpEditorDiagnostics`/`dumpResponseDiagnostics` make it a
  one-minute fix instead of a blind hunt.
- One file lock per provider key (`~/.local/state/agentchat/`). Two workers
  cannot run the same provider concurrently.
- `--keep-tabs` is the default — the process never closes the user's browser.

## When NOT to use

- Interactive multi-turn conversations needing cross-call context (each provider
  has independent session state per invocation).
- Tasks where provider identity matters and automatic fallback is unwanted —
  use `--only=NAME` to pin one.

For architecture, the adapter contract, layering, and how to add a provider,
see `DESIGN.md` (developer-facing, not needed to use this skill).

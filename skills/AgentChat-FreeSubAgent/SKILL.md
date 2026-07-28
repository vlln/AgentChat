---
name: AgentChat-FreeSubAgent
description: Parallel AI task decomposer — decompose a task into a DAG of subtasks, dispatch them concurrently across web AIs (one provider per worker), run quality gates + evidence arbitration. Use for parallel multi-model orchestration, task decomposition, or "ask multiple AIs at once". A run is proven by its `[receipt] AGENTCHAT_RUN` line on stdout; no receipt means no dispatch happened.
---

# AgentChat-FreeSubAgent — Parallel DAG Dispatch over Web AI

Decompose → write a JSON plan → concurrent dispatch (one subprocess per worker,
each pinning a single provider via `--only`/`--single`) → quality gates +
evidence arbitration. No provider implementation code lives here — every AI
call is a subprocess to `../AgentChat-WebExtended/index.js`.

## Contract

Input: a JSON DAG plan (argv or file). Output: a structured arbitration
report + each worker's full response + a receipt line on stdout:

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx","skill":"AgentChat-FreeSubAgent","exit":0,"nodes":4,"failed":0,"providers_used":{...}}
```

A dispatch is proven by its receipt. `run_id` is random and persisted to
`data/receipts.jsonl`, so a fabricated receipt fails a `grep <run_id>` check.
If you (the caller AI) skip the dispatch and answer by role-playing each
worker from model knowledge, there is no receipt — detectable, not trust.

## Flow

1. **Decompose** the task into complementary subtasks (no two AIs get the
   same angle). Write each prompt self-contained, demanding a direct answer
   (not "I will..."). Embed the per-AI instruction (table below).
2. **Write the JSON plan.**
3. **Dispatch** — run the command; it fans out workers in topological waves,
   pinning each to its primary provider with per-worker fallback.
4. **Read** the arbitration report + worker responses, present to the user,
   quote the receipt line.

## JSON plan

```json
{
  "subtasks": [
    { "id": "research", "role": "researcher", "primary": "kimi",
      "depends_on": [], "prompt": "...; list key facts as bullets; do not run code" },
    { "id": "analyze", "role": "depth_reasoner", "primary": "gemini",
      "depends_on": ["research"], "prompt": "..." }
  ]
}
```

Fields: `id`, `role`, `primary` (provider key), `depends_on` (array of subtask
ids; empty = no dependency), `prompt` (self-contained, with the embedded
instruction).

## Roles & embedded instructions

| AI | role | strength | embedded instruction |
|----|------|----------|----------------------|
| Kimi | researcher | long-form analysis, literature, detail | list key facts as bullets; do not run code |
| Gemini | depth_reasoner | multi-step logic, math, science | give the complete analysis directly |
| Qwen | reviewer_retriever | fact-check, Chinese web search | cite a source for each conclusion |
| ChatGPT | creative_builder | design, code, synthesis | output the complete report; don't explain methodology |

## Invocation

```bash
node skills/AgentChat-FreeSubAgent/index.js --timeout=900000 '<DAG_JSON>'
# or from a file:
node skills/AgentChat-FreeSubAgent/index.js --timeout=900000 "$(cat /tmp/plan.json)"
node skills/AgentChat-FreeSubAgent/index.js --smoke | --doctor   # env check
```

`--timeout` is milliseconds (900000 = 15 min, above WebExtended's 600000 default
to leave headroom for concurrent workers). `--keep-tabs` is hardcoded on
(policy: never close the user's Chrome).

## Fallback

Each worker's primary pins its provider; fallback is driven by this layer
(`executeWithFallback` + file locks), NOT inside the subprocess. The subprocess
always runs with `--single` (one provider attempt, no internal cascade) so the
locked provider matches the one actually used — two concurrent workers never
race the same provider tab.

Chain (strictly WebExtended's native order, no re-priority):
```
Gemini → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek → Doubao
```
Degradation is surfaced in the output (`provider_used ≠ primary_intended`).

## Gotchas

- `--timeout` is ms. Writing `--timeout=900` gives 0.9s — M2's floor saves it,
  but M1 (DAG decomposition) will time out and silently degrade to a rule
  template DAG. Use `900000`.
- Provider contention exists only WITHIN a wave; skip lists don't span the
  whole DAG, so fallback chains are less constrained than a global skip.
- `holdLockOnSuccess: true` here (unlike Workflow) — protects concurrent DAG
  workers from tab collisions; caller must release via `cleanupAllLocks` at
  wave boundaries / process exit.
- All workers failed (exit 2) still has a receipt. Quote it, state per-provider
  reasons, then you may proceed with model knowledge — labeled "web AI did not
  contribute".

## Code location

- `index.js` — thin orchestrator (DAG decompose / wave dispatch / arbitration);
  zero provider code
- `lib/execute.js` — `callProvider`/`runChain` subprocess executor
- `../AgentChat-WebExtended/index.js` — the leaf executor each worker spawns
- `lib/providers/chain.js` — fallback chain (shared source of truth)

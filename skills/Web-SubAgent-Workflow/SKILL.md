---
name: Web-SubAgent-Workflow
description: >-
  Sequential AI pipeline — plan→Kimi searches→(complex? Gemini reasons)→
  synthesize→ChatGPT reviews→fix. Use for tasks needing web research + deep
  reasoning + quality review. Each step's run is proven by a `receipt.run_id`
  in its JSON output; a step with no run_id was not executed.
license: MIT
metadata:
  author: vlln
  version: "0.1.0"
requires:
  bins:
    - node
  skills:
    - ../AgentChat-WebExtended
---

# Web-SubAgent-Workflow — Sequential 6-Step Pipeline

```
plan → [2.Kimi search] →{complex?}→ [3.Gemini reason] → [4.synthesize] → [5.ChatGPT review] → [6.fix] → output
                        └── simple: skip ──┘
```

The caller AI is the brain throughout; Steps 2/3/5 run
`node "$_S/index.js"`, which composes `lib/execute.js`'s `runChain` over the
per-step provider chain. `$_S` is this skill's own directory.

## Contract

Each `--search` / `--reason` / `--review` call returns JSON containing a
`receipt` field (and prints `[receipt] AGENTCHAT_RUN {...}` on stderr):

```json
"receipt": { "run_id": "ac-xxxxxxxxxxxx", "skill": "Web-SubAgent-Workflow", "mode": "search", "exit": 0, "provider_used": "kimi" }
```

A step is proven executed by its `receipt.run_id` in the JSON. `run_id` is
random and persisted to `data/receipts.jsonl`, so a fabricated id fails a
`grep <run_id>` check. A final report lists the run_id of each executed step
(Step 2 always; Step 3 if complex; Step 5 always). A step with no run_id was
not run — detectable, not trust.

## Pipeline

### Stage 1 — Plan
Understand the request, skim relevant local files, decide complexity (governs
Stage 3 only), write a search prompt that includes: the original request, a
summary of local findings, and the domain context to verify/supplement.
**Checkpoint:** complexity decided; search prompt self-contained.

### Stage 2 — Search (always)
```bash
node "$_S/index.js" --search "comprehensive search prompt"
```
Fallback Kimi → Qwen. `response` is the search result; extract key facts.
**Checkpoint:** `receipt.run_id` present for mode=search.

### Stage 3 — Reason (only if complex)
```bash
node "$_S/index.js" --reason "request: ... | search summary: ... | analyze from [angle], give complete reasoning" --timeout=300000
```
Fallback Gemini → ChatGPT → Claude. Skip on simple tasks (single fact, ≤50-line
mechanical code, format conversion). When unsure, treat as complex.
**Checkpoint (if run):** `receipt.run_id` for mode=reason.

### Stage 4 — Synthesize
Combine search facts + reasoning (if any) + original request into the
deliverable. Self-check: all facts incorporated? reasoning absorbed? request
points covered?

### Stage 5 — Review (always)
```bash
node "$_S/index.js" --review "request: ... | deliverable: ... | review for correctness, safety, performance, maintainability; list issues, don't rewrite"
```
Fallback ChatGPT → Claude → Qwen. Evaluate each review item: valid → Stage 6
fix / not applicable → note why / unclear → flag.
**Checkpoint:** `receipt.run_id` for mode=review.

### Stage 6 — Fix
Apply review items, output the final artifact.

## Complexity (Stage 1 → Stage 3 only)

Complex (≥2): multi-source synthesis, multi-step reasoning/math, non-trivial
architecture, domain expertise, user asked for "deep/full" analysis.
Simple: single fact, ≤50-line mechanical code, format conversion. Stages 2
and 5 run regardless.

## Per-step prompts

| Step | Provider | Embedded instruction |
|------|----------|----------------------|
| 2 | Kimi | list key facts as bullets; do not run code |
| 3 | Gemini | give the complete analysis directly; no new search needed |
| 5 | ChatGPT | review item by item, list problems + fixes; don't rewrite the whole thing |

## CLI

```bash
node "$_S/index.js" --search "query"      # Stage 2
node "$_S/index.js" --reason "prompt"     # Stage 3
node "$_S/index.js" --review "content"    # Stage 5
node "$_S/index.js" --smoke | --doctor      # env check
```

| Flag | Meaning |
|------|---------|
| `--search` / `--reason` / `--review` | step mode (one of) |
| `--provider=X` | override the step's default provider |
| `--timeout=N` | per-call budget ms (default 180000) |

## Fallback chains

| Step | Chain |
|------|-------|
| search | Kimi → Qwen |
| reason | Gemini → ChatGPT → Claude |
| review | ChatGPT → Claude → Qwen |

## Gotchas

- Prompt delivery is over stdin (not argv) — `--reason` with a huge prompt
  still works (no Windows ~32KB limit / `ps` leakage).
- `holdLockOnSuccess: false` here — steps are sequential, a provider is free
  again the moment its call returns (unlike FreeSubAgent's DAG workers).
- `no_cdp` (exit 1) aborts the whole chain — every step shares the same
  browser, so cascading just burns doomed subprocess launches.
- A failed step still has a receipt. Quote it, state the reason, then proceed
  with model knowledge for that step — labeled "web AI did not contribute".

## Dependencies

- `../AgentChat-WebExtended` — the leaf executor each call spawns (CDP bridge).
- Chrome CDP on port 9222 (managed by WebExtended).

For architecture and the orchestrator layering, see `DESIGN.md`.

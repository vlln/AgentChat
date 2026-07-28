---
name: Web-SubAgent-Workflow
description: Sequential AI pipeline — plan→Kimi searches→(complex? Gemini reasons)→synthesize→ChatGPT reviews→fix. Use for tasks needing web research + deep reasoning + quality review. Each step's run is proven by a `receipt.run_id` in its JSON output; a step with no run_id was not executed.
---

# Web-SubAgent-Workflow — Sequential 6-Step Pipeline

```
plan → [2.Kimi search] →{complex?}→ [3.Gemini reason] → [4.synthesize] → [5.ChatGPT review] → [6.fix] → output
                        └── simple: skip ──┘
```

Claude Code is the brain throughout; Steps 2/3/5 call
`node skills/Web-SubAgent-Workflow/index.js`, which composes
`lib/execute.js`'s `runChain` over the per-step provider chain.

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
not run — that is detectable, not a matter of trust.

## Steps

### Step 1 — Plan
Understand the request, skim relevant local files, decide complexity (governs
Step 3 only), write a search prompt that includes: the original request, a
summary of local findings, and the domain context to verify/supplement.

### Step 2 — Search (always)
```bash
node skills/Web-SubAgent-Workflow/index.js --search "comprehensive search prompt"
```
Fallback Kimi → Qwen. `response` is the search result; extract key facts.

### Step 3 — Reason (only if complex)
```bash
node skills/Web-SubAgent-Workflow/index.js --reason "request: ... | search summary: ... | analyze from [angle], give complete reasoning" --timeout=300000
```
Fallback Gemini → ChatGPT → Claude. Skip on simple tasks (single fact, ≤50-line
mechanical code, format conversion). When unsure, treat as complex.

### Step 4 — Synthesize
Combine search facts + reasoning (if any) + original request into the
deliverable. Self-check: all facts incorporated? reasoning absorbed? request
points covered?

### Step 5 — Review (always)
```bash
node skills/Web-SubAgent-Workflow/index.js --review "request: ... | deliverable: ... | review for correctness, safety, performance, maintainability; list issues, don't rewrite"
```
Fallback ChatGPT → Claude → Qwen. Evaluate each review item: valid → Step 6
fix / not applicable → note why / unclear → flag.

### Step 6 — Fix
Apply review items, output the final artifact.

## Complexity (Step 1 → Step 3 only)

Complex (≥2): multi-source synthesis, multi-step reasoning/math, non-trivial
architecture, domain expertise, user asked for "deep/full" analysis.
Simple: single fact, ≤50-line mechanical code, format conversion. Step 2 and
Step 5 run regardless.

## Per-step prompts

| Step | Provider | Embedded instruction |
|------|----------|----------------------|
| 2 | Kimi | list key facts as bullets; do not run code |
| 3 | Gemini | give the complete analysis directly; no new search needed |
| 5 | ChatGPT | review item by item, list problems + fixes; don't rewrite the whole thing |

## CLI

```bash
node skills/Web-SubAgent-Workflow/index.js --search "query"     # Step 2
node skills/Web-SubAgent-Workflow/index.js --reason "prompt"    # Step 3
node skills/Web-SubAgent-Workflow/index.js --review "content"   # Step 5
node skills/Web-SubAgent-Workflow/index.js --smoke | --doctor     # env check
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
- A failed step still has a receipt. Quote it, state the reason, then you may
  proceed with model knowledge for that step — labeled "web AI did not
  contribute to this step".

## Code location

- `index.js` — step dispatch (composes `lib/execute.js` `runChain`)
- `lib/execute.js` — `callProvider`/`runChain` subprocess executor
- `../AgentChat-WebExtended/index.js` — the leaf executor each call spawns

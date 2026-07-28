# AgentChat — Design

AgentChat does one thing: **bridge web AI to callable providers via CDP**, and
degrade across them when one is unavailable. Everything else (parallel
dispatch, sequential pipelines, fallback chains) is application logic composed
on top of that kernel.

Design ethos: Unix. Do one thing well. Orthogonal decoupling. Contracts over
magic. Few sharp primitives that compose. Honest docs that list constraints.

## Kernel boundary — `skills/lib/bridge/`

The CDP bridging kernel. DOM-free except where DOM is the job.

| module | role |
|--------|------|
| `contract.js` | The Adapter interface + `assertAdapter` (fail-fast validation of required data fields at runner-construction time). |
| `run.js` | `createProviderRunner` — the 10-step flow skeleton (navigate → auth → quota → overlays → prepare → findEditor → input → send → waitForCompletion → extract). Dispatches each step to the adapter's named method, falling back to bridge helpers. DOM-free. |
| `dom.js` | Composable DOM helpers: findEditor / inputText (clipboard·paste·keyboard) / clickSend / verifySendEffect / diagnostics. |
| `completion.js` | `waitForCompletion` + stability polling (stop-button → response-element → fingerprint-change detection, `stillGeneratingCheck` capped by `stillGeneratingMaxHoldMs`). |
| `overlays.js` | Modal/dialog detection + dismissal. The login regex here is negative-lookbehind guarded (退出登录/免登录/已登录 must NOT auth-block) — `tests/still_working.test.js` source-scans this file for it. |
| `extract.js` | Response text extraction + HTML→Markdown (turndown) + echo guard. |

The brittleness of web-AI DOM scraping lives inside `bridge/`'s helpers and the
adapters — it does NOT leak into the orchestration layer.

## Adapter contract

An adapter (`skills/lib/providers/<name>.js`) drives ONE web AI. It owns all
of its DOM coupling (selectors, send-button logic, completion detection).

**Required data** (validated by `assertAdapter`, fail-fast if missing):
`key`, `url`, `authDomains`, `editorSelectors`, `responseSelectors`.

Send is deliberately NOT required — an adapter may send via a button selector,
via `sendFallback` key alone (qwen: empty `sendSelectors` + Enter), or via a
`send()` override (kimi/mimo). Same for `sendFallback`.

**Optional behavioral methods** (runner provides bridge-helper defaults when
absent):
- `prepare(page)` — default no-op
- `findEditor(page)` — default `dom.findEditableElement(editorSelectors, validateEditor)`
- `input(page, editor, prompt)` — default `dom.defaultInput`
- `send(page, editor)` — default `dom.clickSend(sendSelectors, sendFallback)`

**Data hooks** read by the defaults (NOT promoted to methods — they stay data):
- `stillGeneratingCheck(page, info)` — read by `completion`; `undefined` → never hold.
- `postResponseHook(page, text)` + `responseFormat` + `minResponseLength` — read by `extract`.
- `validateEditor(loc)` — read by the default `findEditor`.

9 adapters: gemini, chatgpt, claude, qwen, kimi, minimax, mimo, deepseek, doubao.
Each is a self-contained module; adding a provider = adding one file that
implements the interface.

## Layering

```
Application skills   Workflow (sequential pipe) · FreeSubAgent (DAG dispatch + domain logic)
        ↑ compose
Orchestration         lib/execute.js — callProvider (call) · runChain (fallback)
        ↑ spawns subprocess
Leaf executor         AgentChat-WebExtended/index.js (in-process fallback OR --only --single target)
        ↑ runs
Kernel                bridge/run.js (createProviderRunner) + bridge/{dom,completion,overlays,extract}
        ↑ dispatches to
Adapters              providers/<name>.js — each owns its DOM coupling
```

WebExtended is the leaf executor. `execute.js`'s `callProvider` spawns
`node WebExtended/index.js --only=X --single` as a child process. Therefore
WebExtended cannot compose `execute.runChain` — that would spawn itself
recursively. The orchestration layer sits above the leaf; the leaf sits above
the kernel.

## Why no further primitive extraction

The orchestration layer is already orthogonal enough. Forcing more abstraction
would manufacture noise:

- `call` / `fallback` already live in `execute.js` and are already composed by
  Workflow and FreeSubAgent.
- `pipe` is already Workflow's current shape (185 lines: search→reason→review,
  each step a `runChain`, output forwarded). Extracting a `pipe` helper gains
  nothing — there's one consumer.
- `dispatch` (FreeSubAgent's wave fan-out) is tightly coupled to its DAG
  semantics (upstream-output injection, role-based skip lists). It has exactly
  one consumer. Extracting a generic `dispatch(tasks, workerFn, budgetMs)` would
  be a primitive with a single user — a false abstraction.
- WebExtended is a leaf executor, not an orchestration primitive.

Rule applied: extract a primitive only when it has (or will soon have)
multiple composable consumers. The current code has none pending, so we stop.

## Constraints (honest)

- A shared Chrome must be running with CDP on port 9222. `--doctor` checks
  reachability; a flaky WS handshake (HTTP 502 on upgrade) is an environment
  issue, not a code one.
- Every provider requires a one-time manual login in that Chrome profile.
  Auth-gated providers fail as `reason: 'auth'` within seconds of navigation.
- DOM scraping breaks when a provider rewrites its UI. Each adapter's selectors
  are the brittle edge; `dumpEditorDiagnostics` / `dumpResponseDiagnostics`
  exist to make selector drift a one-minute fix instead of a blind hunt.
- One provider lock per key (file lock in `~/.local/state/agentchat/`). A
  session cannot run a provider concurrently with another worker holding its
  lock.
- Subprocess model: prompt over stdin (never argv — Windows ~32KB limit +
  `ps` leakage). `--keep-tabs` policy: subprocesses never close the user's
  browser.

## Verification

- `npm test` — 19 assertions across `gemini_selectors` (selector/draft logic)
  and `still_working` (completion phases + login-regex source scan).
- `node skills/AgentChat-WebExtended/index.js --doctor` — CDP reachability.
- `node skills/AgentChat-WebExtended/index.js --smoke` — all providers.

## Provider quirks (developer reference)

Each adapter (`lib/providers/adapters/<name>.js`) owns its DOM coupling. The
non-obvious differences, for maintenance reference:

| Provider | Key difference |
|----------|----------------|
| Gemini | Pro Extended activation, bursty-output detection, 120s stop-btn extension, Action Toolbar completion anchor, dual-draft panel resolution |
| ChatGPT | 3-tier input (clipboard→simulated paste→keyboard), React send-button state verification, hidden fallback-textarea rejection |
| Claude | ProseMirror editor, "Thinking" placeholder filter, embedded search-block strip |
| Qwen | React SPA 3s delay, stop-btn detached mode (removed from DOM when done, not hidden), model-name prefix strip |
| Kimi | new-session per call, send-button-container disabled-class detection, adaptive stability window (tool-phase truncation fix) |
| MiniMax | TipTap/ProseMirror async mount 4s delay, `aria-label="发送消息"` non-button send element |
| MiMo | React SPA 4s delay, DOM-traversal send button (no stable CSS selector) |
| DeepSeek | standard pipeline, ds-markdown response |
| Doubao | React SPA 4s delay, Semi Design textarea, `#flow-end-msg-send` send button |

## Adding a provider

1. Create `lib/providers/adapters/<name>.js` exporting the Adapter interface:
   required data (`key`, `url`, `authDomains`, `editorSelectors`,
   `responseSelectors`) + optional methods (`prepare`/`findEditor`/`input`/
   `send`) overriding bridge-helper defaults. Add `validateEditor` /
   `postResponseHook` / `stillGeneratingCheck` as data hooks if needed.
2. Add the entry to `PROVIDER_CHAIN` in `lib/providers/chain.js` (key, name,
   url, authDomains, optional `recoveryHint` / `tabHosts`).
3. Add the key to `PROVIDER_KEYS` in `skills/AgentChat-WebExtended/index.js`
   (auto-registers a runner via `createProviderRunner`).
4. Validate: `assertAdapter` fails fast at load if required fields are missing;
   `npm test` covers shared patterns; `--only=<name> --single` exercises the
   dispatch path against a live Chrome.

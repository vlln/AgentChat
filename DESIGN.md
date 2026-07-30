# AgentChat — Design

AgentChat does one thing: **bridge web AI to a callable provider via CDP**.
One provider per invocation — the caller picks which one. No fallback, no
cascading, no orchestration. Everything else is application logic composed on
top of that kernel.

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
web-subagent   the skill: single-provider bridge (--only=NAME)
        ↑ also the leaf executor (CLI: one provider per invocation)
Kernel                  bridge/run.js (createProviderRunner) + bridge/{dom,completion,overlays,extract,contract}
        ↑ dispatches to
Adapters                providers/<name>.js — each owns its DOM coupling
```

web-subagent is the skill AND the leaf executor. It connects to the shared
Chrome and runs `createProviderRunner` per provider (`tryAllProviders`), or —
under `--only=X --single` — runs exactly one provider and returns. There is
no separate orchestration layer above it: application-level composition
(sequential pipelines, parallel DAG dispatch) is left to the caller. This
keeps the repo to exactly one thing — the CDP bridge — with no dead
orchestration code waiting for a consumer.

## Why no fallback or orchestration here

The bridge does one thing: send a prompt to one provider, get the answer back.
Fallback, parallel dispatch, chaining — those are caller concerns. Earlier
revisions carried a cascading fallback chain and two application skills; they
were removed. A future orchestration layer — if needed — should be built as a
separate concern on top of this bridge, not bundled into it.

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

- `npm test` — 154 assertions: contract validation (78), Gemini selector/draft
  logic (19), completion phases + overlay login-regex source scan (57).
- `node skills/web-subagent/scripts/index.js --doctor` — CDP reachability.
- `node skills/web-subagent/scripts/index.js --smoke` — all providers.

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
   optional `recoveryHint` / `tabHosts`). `url` and `authDomains` are hydrated
   from the adapter config — no duplication.
3. Add the key to `PROVIDER_KEYS` in `skills/web-subagent/scripts/index.js`
   (auto-registers a runner via `createProviderRunner`).
4. Validate: `assertAdapter` fails fast at load if required fields are missing;
   `npm test` covers shared patterns; `--only=<name> --single` exercises the
   dispatch path against a live Chrome.

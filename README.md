# AgentChat

Send a prompt to a web AI through a real browser — no API keys, no billing.

**How it works.** A Chrome browser controlled via CDP types your prompt into
the web UI, clicks send, waits for the response, and extracts the text.
9 providers available: Gemini, ChatGPT, Claude, Qwen, Kimi, MiniMax, MiMo,
DeepSeek, Doubao. You pick one per invocation with `--backends=NAME`.

**Design.** The project is a single bridge — no orchestration, no pipelines,
no multi-agent dispatch. One kernel (`bridge/`) handles the CDP protocol and
completion polling. Each provider is one adapter file that owns its DOM
coupling. Adding a provider is one file plus one line in the chain. Adding a
consumer that chains or dispatches is a separate concern, composed on top.

**Proof of execution.** Every run emits a receipt on stderr. `run_id` is
random and persisted to disk. No receipt means no run happened — grep-verifiable,
not a matter of trust.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

## Install

```bash
git clone https://github.com/vlln/AgentChat.git && cd AgentChat
npm install
cp skills/web-subagent/.env.example skills/web-subagent/.env
```

Set `CHROMIUM_PATH` and `CHROME_PROFILE` in `.env`, then:

```bash
bash skills/web-subagent/scripts/start-chrome-debug.sh
node skills/web-subagent/scripts/index.js --doctor
```

Log into the AI sites you want to use in that Chrome profile. One-time.

## Use

```bash
node skills/web-subagent/scripts/index.js --backends=Kimi "Your prompt"
echo "prompt" | node skills/web-subagent/scripts/index.js --backends=Gemini
node skills/web-subagent/scripts/index.js --help
```

## Docs

- `skills/web-subagent/SKILL.md` — full invocation reference, flags, exit codes, gotchas
- [DESIGN.md](DESIGN.md) — architecture, adapter contract, how to add a provider

## License

MIT © [vlln](https://github.com/vlln)
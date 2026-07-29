# AgentChat

Bridge web AI to callable providers via CDP, with automatic cross-provider
fallback. A Claude Code skill suite: one prompt in, one answer out — if a
provider is unavailable, the next one answers.

9 providers: Gemini, ChatGPT, Claude, Qwen, Kimi, MiniMax, MiMo, DeepSeek,
Doubao. First available wins; degradation is surfaced in the output.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Providers](https://img.shields.io/badge/Providers-9-orange.svg)](#skills)

## Skills

| Skill | What it does |
|-------|--------------|
| **agentchat-web-extended** | Send a prompt to one provider; auto-fallback across the chain if it's unavailable. The CDP bridge and leaf executor. |

Each skill's `SKILL.md` is the agent-facing contract (when to use, I/O,
gotchas). For architecture and the adapter contract, see [DESIGN.md](DESIGN.md).

## Prerequisites

- **Node.js 18+**
- **A Chrome** with remote debugging on port 9222, using a profile where you've
  logged into the AI sites you want to use. The repo ships a launcher:
  ```bash
  bash scripts/start-chrome-debug.sh
  ```
- One-time manual login per provider in that Chrome profile.

## Install

```bash
git clone https://github.com/vlln/AgentChat.git && cd AgentChat
npm install
cp .env.example .env   # set CHROMIUM_PATH to your system Chrome + CHROME_PROFILE
```

Verify the bridge reaches Chrome:
```bash
node skills/agentchat-web-extended/index.js --doctor
```

## Use

```bash
# One prompt, auto-fallback across the chain
/agentchat-web-extended write a Python script to parse CSV
```

A run is proven by its `[receipt] AGENTCHAT_RUN` line — `run_id` is persisted
and grep-verifiable, so a skipped run is detectable.

## License

MIT © [vlln](https://github.com/vlln)

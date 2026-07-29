/**
 * PROVIDER_CHAIN — provider priority order.
 *
 * Metadata (name, recoveryHint, tabHosts) lives here. url and authDomains
 * are sourced from each adapter config — no duplication, no drift.
 */

const PROVIDER_CHAIN = [
    { key: 'gemini',   name: 'Gemini',
      // Surfaced on reason='auth' failures — the ONE command that restores a
      // missing/logged-out Gemini tab in the shared Chrome (see connect-gemini.sh).
      recoveryHint: 'bash scripts/connect-gemini.sh  # 重连一次恢复 Gemini 登录态' },
    { key: 'chatgpt',  name: 'ChatGPT' },
    { key: 'claude',   name: 'Claude' },
    { key: 'qwen',     name: 'Qwen' },
    { key: 'kimi',     name: 'Kimi',     tabHosts: ['kimi.moonshot.cn', 'kimi.com'] },
    { key: 'minimax',  name: 'MiniMax' },
    { key: 'mimo',     name: 'MiMo' },
    { key: 'deepseek', name: 'DeepSeek' },
    { key: 'doubao',   name: 'Doubao' },
];

// Hydrate url + authDomains from adapter configs (single source of truth).
// Adapters are plain data objects — no playwright-core dependency.
for (const entry of PROVIDER_CHAIN) {
    try {
        const cfg = require(`./adapters/${entry.key}`);
        entry.url = cfg.url;
        entry.authDomains = cfg.authDomains;
    } catch (_) {
        // Adapter file missing or broken — caller will fail at runtime.
        // Keep entry in chain so the error is surfaced, not silently skipped.
    }
}

module.exports = { PROVIDER_CHAIN };
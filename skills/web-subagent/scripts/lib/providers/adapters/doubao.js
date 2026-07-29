/**
 * Doubao (豆包) provider adapter config.
 *
 * ByteDance's AI chatbot at doubao.com.
 * Uses a React SPA with CSS modules (Semi Design / custom design system).
 *
 * Key DOM structure:
 *   - Editor: textarea[placeholder*="发消息"] (Semi Design autosize textarea)
 *   - Send: #flow-end-msg-send button (only visible after typing), fallback Ctrl+Enter
 *   - Response: [class*="message-list"] [class*="md-box-root"]
 *     - User messages are in flex justify-end with bg-g-send-msg-bubble-bg
 *     - Assistant messages are left-aligned, same md-box-root container
 *     - Both have data-streaming="false" when complete
 *
 * Overrides (React controlled textarea — needs per-char events, not fill/insertText):
 *   - input: keyboard.type for React onChange
 *   - clearEditor: no-op (Ctrl+A disrupts React state)
 *   - send: custom click + wait for button hidden (editor ref detached after send)
 */

const { COMMON_DISMISS_PATTERNS, COMMON_CN_QUOTA_PATTERNS } = require('../../bridge/overlays');
const { inputViaSimulatedPaste, clickSend } = require('../../bridge/dom');

const DOUBAO_SEND_SELECTORS = [
    '#flow-end-msg-send',
    '#input-engine-container button:first-of-type',
    '#input-engine-container button',
];
const DOUBAO_SEND_FALLBACK = 'ControlOrMeta+Enter';

const RESPONSE_SELECTORS = [
    // v1: message-list → md-box-root is the semantic content container.
    // Both user and assistant use the same class; the factory's .last()
    // resolves to the most recent message. The echo guard filters out
    // user-message hits (text near-identical to prompt).
    '[class*="message-list"] [class*="md-box-root"]',
    '[class*="md-box-root"]',
    // Generic fallbacks
    '[class*="markdown"]',
    '[class*="content"]',
];

module.exports = {
    key: 'doubao',
    url: 'https://www.doubao.com/chat/',
    navPostDelay: 4000, // React SPA render time
    authDomains: ['doubao.com/login', 'www.doubao.com/login', 'sso.doubao.com'],
    quotaPatterns: [
        ...COMMON_CN_QUOTA_PATTERNS,
        /高峰.*算力.*不足/i,
        /(?:额度|次数|用完|用尽|不够|上限).{0,30}(?:升级|充值)/i,
        /额度.*(?:已|用).*(?:完|尽|满)/i,
        /今日.*(?:次数|额度).*(?:已|用).*(?:完|尽)/i,
        /请.*(?:稍后|明天).*(?:再试|重试)/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /版本.*更新/i,
        /下载.*(?:电脑版|App)/i,
        /打开.*App/i,
    ],

    editorSelectors: [
        'textarea[placeholder*="发消息"]',
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="消息"]',
        '#input-engine-container textarea',
        'textarea',
        '[contenteditable="true"]',
    ],

    // Doubao's textarea treats Enter as newline, NOT send.
    // The send button is #flow-end-msg-send — a round icon button inside
    // #input-engine-container with an SVG arrow icon.
    sendSelectors: DOUBAO_SEND_SELECTORS,
    sendFallback: DOUBAO_SEND_FALLBACK,

    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 3,

    // ── input: Semi Design React textarea ──
    // React controlled textarea: editor.fill() sets DOM value but React
    // ignores direct value sets → send submits empty. keyboard.type() fires
    // per-char keydown/input → React onChange → state update → real send.
    // Long prompts use simulated paste (triggers React onPaste) for speed.
    //
    // DO NOT clearEditor before input: the runner's clearEditor (Ctrl+A →
    // Backspace) disrupts React's focus/state tracking so the subsequent
    // keyboard.type is ignored. The textarea is empty on a new message anyway.
    input: async (page, editor, prompt) => {
        await editor.click().catch(() => {});
        if (prompt.length > 500) {
            const ok = await inputViaSimulatedPaste(page, editor, prompt);
            if (!ok) await page.keyboard.type(prompt, { delay: 15 });
        } else {
            await page.keyboard.type(prompt, { delay: 20 });
        }
        await page.waitForTimeout(500);
        const len = await editor.evaluate(el =>
            (el.value !== undefined && el.tagName === 'TEXTAREA') ? el.value.length
            : (el.innerText || el.textContent || '').length
        ).catch(() => 0);
        return len > prompt.length * 0.8;
    },

    // clearEditor (Ctrl+A → Backspace) disrupts React's controlled textarea.
    // The editor is empty on a new message; skip the default clear.
    clearEditor: async () => true,

    // Doubao's React SPA re-renders the input area after send, detaching the
    // editor element. The default verifySendEffect (which reads the old editor
    // reference) then sees a detached element → returns 'unsent' → the runner
    // retries with Enter (which inserts a newline, not sends). This custom send
    // clicks the send button and verifies via the send button disappearing
    // (becomes !hidden) rather than via the stale editor reference.
    send: async (page, editor) => {
        await clickSend(page, editor, DOUBAO_SEND_SELECTORS, DOUBAO_SEND_FALLBACK);
        // Wait for send button to disappear (React re-renders it as !hidden)
        try {
            await page.locator('#flow-end-msg-send').waitFor({ state: 'hidden', timeout: 5000 });
        } catch (_) { /* best-effort */ }
    },
};
/**
 * Doubao (豆包) provider adapter config.
 *
 * Phase 2: first NATIVE interface adapter — imports shared patterns directly
 * from bridge/overlays (not the providerFactory shim) and carries only data
 * fields. All behavioral steps (prepare/findEditor/input/send/extract) fall
 * through to the runner's bridge-helper defaults. No hooks, no overrides.
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
 */

const { COMMON_DISMISS_PATTERNS } = require('../../bridge/overlays');
const { inputViaSimulatedPaste } = require('../../bridge/dom');

const RESPONSE_SELECTORS = [
    // Doubao's conversation is a v_list of v_list_row items (user + assistant
    // rows share the class). The runner's .last() + echo-guard + baseline-count
    // guard pick the newest assistant row. The old md-box-root selectors were
    // stale (Doubao's UI moved to v_list) and the generic [class*="content"]
    // fallback false-matched the input-guidance container.
    '[class*="v_list_row"]',
    '[class*="v_list"] [class*="markdown"]',
];

module.exports = {
    key: 'doubao',
    url: 'https://www.doubao.com/chat/',
    navPostDelay: 4000, // React SPA render time
    authDomains: ['doubao.com/login', 'www.doubao.com/login', 'sso.doubao.com'],
    quotaPatterns: [
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
    sendSelectors: [
        '#flow-end-msg-send',
        '#input-engine-container button:first-of-type',
        '#input-engine-container button',
    ],
    sendFallback: 'ControlOrMeta+Enter',

    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 3,

    // ── input: Semi Design React textarea ──
    // React controlled textarea: editor.fill() sets the DOM value but React's
    // internal state ignores direct value sets → send submits an empty prompt.
    // keyboard.type() fires per-char keydown/input events → React onChange →
    // state updates → send submits the real prompt. Long prompts use simulated
    // paste (triggers React onPaste) to stay fast.
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
};
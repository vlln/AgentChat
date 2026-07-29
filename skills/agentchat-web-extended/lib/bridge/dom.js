/**
 * bridge/dom.js — composable DOM helpers for provider adapters.
 *
 * Extracted from the former providerFactory.js god-object (Phase 1 refactor).
 * Each helper does one CDP/DOM operation; adapters compose them. DOM coupling
 * for a specific provider lives in its adapter, not here — these are the shared
 * mechanics (find editor, input text, click send, verify effect, dump
 * diagnostics) reused across all providers.
 *
 * Phase 1: behavior-equivalent extraction. No interface change yet.
 */
'use strict';

// Shared threshold: prompts longer than this use clipboard paste (O(1) CDP
// round-trips) instead of keyboard.insertText (O(n)). Conservative to avoid
// React re-render overhead for long payloads, high enough that short prompts
// get reliable keyboard input.
const INSERT_TEXT_LIMIT = 500;

/**
 * Find an editable element matching one of the given selectors.
 * Returns the first visible, non-readonly contenteditable div or textarea.
 *
 * v10: no longer a silent single-shot. When every configured selector fails
 * (the Gemini-class "UI drift" failure, which used to hard-fail the provider
 * at EDITOR_FIND), a heuristic scan across document + open shadow roots looks
 * for the most chat-input-shaped editable on the page; the pick is still
 * gated by validateFn. On total failure, dumps input-element diagnostics to
 * stderr so the next selector fix takes one minute instead of a blind hunt.
 */
async function findEditableElement(page, selectors, validateFn, log) {
    const _log = log || (() => {});
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            const visible = await loc.isVisible({ timeout: 3000 }).catch(() => false);
            if (!visible) continue;

            const editable = await loc.evaluate(el => {
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                    return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
                }
                return el.getAttribute('contenteditable') !== 'false'
                    && !el.hasAttribute('readonly')
                    && !el.hasAttribute('disabled');
            }).catch(() => false);

            if (!editable) continue;

            if (validateFn) {
                const ok = await validateFn(loc).catch(() => false);
                if (!ok) continue;
            }

            return loc;
        } catch (_) { /* next selector */ }
    }

    // v10: heuristic last resort — selector drift should degrade, not kill
    const rescued = await heuristicFindEditor(page, validateFn, _log).catch(() => null);
    if (rescued) return rescued;

    await dumpEditorDiagnostics(page, _log).catch(() => {});
    return null;
}

/**
 * v10: Heuristic editor discovery (shadow-DOM piercing).
 * Scores visible editables by chat-input shape: low on the page, wide,
 * prompt-ish placeholder/aria. Tags the winner with data-fs-editor="1"
 * (Playwright locators pierce open shadow roots, so the tag is reachable
 * even inside a web component). validateFn still gates the pick.
 */
async function heuristicFindEditor(page, validateFn, log = () => {}) {
    let meta = null;
    try {
        meta = await page.evaluate(({ marker }) => {
            const roots = [document];
            try {
                const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n;
                while ((n = w.nextNode())) if (n.shadowRoot) roots.push(n.shadowRoot);
            } catch (_) {}

            // Clear stale tags from earlier scans
            for (const r of roots) {
                try {
                    r.querySelectorAll(`[${marker}]`).forEach(el => el.removeAttribute(marker));
                } catch (_) {}
            }

            const PROMPTISH = /问|输入|消息|发送|聊|訊息|傳送|message|prompt|ask|chat|send|type/i;
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const seen = new Set();
            const cands = [];
            for (const r of roots) {
                let list = [];
                try {
                    list = r.querySelectorAll(
                        'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'
                    );
                } catch (_) { continue; }
                for (const el of list) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 50 || rect.height < 14) continue;
                    const style = getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') continue;
                    if (el.hasAttribute('readonly') || el.hasAttribute('disabled')) continue;
                    if (el.getAttribute('contenteditable') === 'false') continue;

                    const hint = (el.getAttribute('placeholder') || '') + ' '
                               + (el.getAttribute('aria-label') || '');
                    let score = 0;
                    if (rect.top > vh * 0.4) score += 2;   // chat inputs live low
                    if (rect.width > vw * 0.35) score += 2; // main input is wide
                    if (PROMPTISH.test(hint)) score += 2;
                    if (el.tagName === 'TEXTAREA'
                        || el.getAttribute('contenteditable') === 'true') score += 1;

                    cands.push({ el, score, area: rect.width * rect.height, hint: hint.trim().slice(0, 60) });
                }
            }
            if (!cands.length) return null;
            cands.sort((a, b) => b.score - a.score || b.area - a.area);
            cands[0].el.setAttribute(marker, '1');
            return { score: cands[0].score, hint: cands[0].hint, total: cands.length };
        }, { marker: 'data-fs-editor' });
    } catch (_) { return null; }
    if (!meta) return null;

    const loc = page.locator('[data-fs-editor="1"]').first();
    const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) return null;
    if (validateFn) {
        const ok = await validateFn(loc).catch(() => false);
        if (!ok) return null;
    }
    log(`editor found via HEURISTIC scan (selector drift? score=${meta.score} hint="${meta.hint}" candidates=${meta.total}) — update editorSelectors when convenient`);
    return loc;
}

/**
 * v10: Dump visible input-ish elements to stderr when no editor was found —
 * the single source of truth for the next one-minute selector fix.
 */
async function dumpEditorDiagnostics(page, log = () => {}) {
    try {
        const info = await page.evaluate(() => {
            const roots = [document];
            try {
                const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n;
                while ((n = w.nextNode())) if (n.shadowRoot) roots.push(n.shadowRoot);
            } catch (_) {}
            const seen = new Set();
            const items = [];
            for (const r of roots) {
                let list = [];
                try {
                    list = r.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]');
                } catch (_) { continue; }
                for (const el of list) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const rect = el.getBoundingClientRect();
                    items.push({
                        tag: el.tagName,
                        ce: el.getAttribute('contenteditable') || '',
                        placeholder: (el.getAttribute('placeholder') || '').slice(0, 60),
                        aria: (el.getAttribute('aria-label') || '').slice(0, 60),
                        classes: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
                        visible: rect.width > 0 && rect.height > 0,
                        top: Math.round(rect.top),
                        shadow: r !== document,
                    });
                    if (items.length >= 12) return items;
                }
            }
            return items;
        });
        log('DIAG: no editor selector matched — input-ish elements on page:');
        info.forEach((b, i) => {
            log(`  [${i}] <${b.tag}>${b.shadow ? ' [shadow]' : ''} vis=${b.visible} top=${b.top} ce="${b.ce}" ph="${b.placeholder}" aria="${b.aria}" class="${b.classes}"`);
        });
    } catch (e) {
        log(`DIAG: editor dump failed: ${e.message}`);
    }
}

/**
 * Input text via clipboard paste + polling wait.
 * For React-controlled contenteditable divs, paste triggers onPaste properly,
 * but React's async re-render may not complete within a fixed timeout.
 *
 * Polls until the text appears (up to text.length * 10ms, min 2s).
 * Returns true if the input was successful (editor contains ≥80% of the text).
 */
async function inputViaClipboard(page, editor, prompt) {
    try {
        await page.evaluate(t => navigator.clipboard.writeText(t), prompt);
        await page.keyboard.press('ControlOrMeta+v');
        // Poll — React re-render time scales with text length
        const timeout = Math.max(2000, prompt.length * 10);
        const start = Date.now();
        let len = 0;
        while (Date.now() - start < timeout) {
            await page.waitForTimeout(150);
            len = await editor.evaluate(el =>
                (el.innerText || el.textContent || '').length
            ).catch(() => 0);
            if (len > prompt.length * 0.8) break;
        }
        return len > prompt.length * 0.8;
    } catch (_) {
        return false;
    }
}

/**
 * Input text via simulated ClipboardEvent('paste') with DataTransfer.
 * Triggers React's onPaste handler directly — works even when clipboard API
 * is blocked by CDP permissions. This is the key fix for React contenteditable.
 */
async function inputViaSimulatedPaste(page, editor, prompt) {
    try {
        await editor.evaluate((el, text) => {
            // Clear
            while (el.firstChild) el.removeChild(el.firstChild);
            el.focus();

            // Build DataTransfer
            const dt = new DataTransfer();
            dt.setData('text/plain', text);

            // Dispatch ClipboardEvent — React's onPaste reads event.clipboardData
            const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dt,
            });
            el.dispatchEvent(pasteEvent);
        }, prompt);
        await page.waitForTimeout(600);

        const len = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        );
        return len > prompt.length * 0.8;
    } catch (_) {
        return false;
    }
}

/**
 * Input text via chunked keyboard.insertText — the nuclear option.
 * 100% reliable (Playwright dispatches real key events) but O(n) characters.
 * For very long prompts, chunks with yields to avoid blocking React re-renders.
 */
async function inputViaKeyboard(page, editor, prompt, { chunkSize = 150, yieldMs = 40 } = {}) {
    for (let i = 0; i < prompt.length; i += chunkSize) {
        const chunk = prompt.substring(i, Math.min(i + chunkSize, prompt.length));
        await page.keyboard.insertText(chunk);
        await page.waitForTimeout(yieldMs);
    }
    await page.waitForTimeout(300);
    return true; // keyboard.insertText always works
}

/**
 * Default input strategy — clipboard paste for large payloads, keyboard for small.
 * Used by providers that don't need custom input logic (Claude, Kimi, MiniMax, etc.).
 */
async function defaultInput(page, editor, prompt, { insertTextLimit = INSERT_TEXT_LIMIT } = {}) {
    if (prompt.length > insertTextLimit) {
        // PRIVACY FIX: only press Ctrl+V if OUR write to the clipboard succeeded.
        // Previously, a failed writeText (permission denied) was swallowed and
        // Ctrl+V pasted whatever the USER had on their clipboard into a
        // third-party AI page — and could even send it if it passed the 0.8
        // length check. On clipboard failure, fall back to non-clipboard paths.
        let clipOk = true;
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); }
        catch (_) { clipOk = false; }
        if (clipOk) {
            await page.keyboard.press('ControlOrMeta+v');
            await page.waitForTimeout(500);
            const len = await editor.evaluate(el => (el.innerText || el.textContent || '').length);
            if (len > prompt.length * 0.8) return true;
        }
        // Clipboard unavailable or paste didn't land → simulated ClipboardEvent,
        // then chunked keyboard as the last resort.
        if (await inputViaSimulatedPaste(page, editor, prompt)) return true;
        return inputViaKeyboard(page, editor, prompt);
    } else {
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(300);
        return true;
    }
}

// DEFAULTS.input = defaultInput is wired in bridge/run.js (DEFAULTS lives there).
/**
 * Clear the editor (Ctrl+A → Backspace) and focus it.
 */
async function clearEditor(page, editor) {
    await editor.focus();
    await editor.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+a'); // double-tap for some editors
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
}

/**
 * Find, verify, and click a send button, or press a fallback key.
 *
 * v2: Poll-waits for the button to be both visible AND enabled before clicking.
 *     React contenteditable editors may show a disabled button for 200-800ms
 *     after text is pasted (React batch state update).  A click on a disabled
 *     button is silently ignored.
 */
async function clickSend(page, editor, sendSelectors, fallbackKey) {
    for (const sel of sendSelectors) {
        try {
            const btn = page.locator(sel).first();
            // Wait for button to be VISIBLE (up to 2s)
            if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) continue;

            // Poll-wait for button to be ENABLED (React may batch-update state)
            const deadline = Date.now() + 3000;
            let enabled = false;
            while (Date.now() < deadline) {
                enabled = await btn.evaluate(el =>
                    !el.hasAttribute('disabled')
                    && el.getAttribute('aria-disabled') !== 'true'
                    && !el.classList.contains('disabled')
                ).catch(() => false);
                if (enabled) break;
                await page.waitForTimeout(150);
            }
            if (!enabled) continue; // still disabled after 3s → try next selector

            await btn.click();
            await page.waitForTimeout(1500);
            return true;
        } catch (_) { /* next selector */ }
    }
    // Fallback: press the key (usually Enter)
    await editor.focus();
    await page.keyboard.press(fallbackKey || 'Enter');
    await page.waitForTimeout(1500);
    return true;
}

/**
 * v10: Verify-by-effect for SEND — the same principle that fixed the Gemini
 * model picker, applied to the one shared step with a SILENT failure mode:
 * a keyboard fallback that inserts a newline instead of submitting (Enter vs
 * Ctrl+Enter UIs) produced no error, then burned the whole WAIT_RESPONSE
 * budget and failed the provider as 'timeout'.
 *
 * Signals (any one ⇒ 'sent'): editor emptied to <20% of the prompt, or a
 * stop button appeared. 'unsent' is only returned when ≥80% of the prompt
 * DEMONSTRABLY still sits in the editor — the only state where a retry with
 * an alternate key cannot double-send. Anything ambiguous ⇒ 'unknown' (no-op).
 *
 * @returns {Promise<'sent'|'unsent'|'unknown'>}
 */
async function verifySendEffect(page, editor, prompt, C, budgetMs = 4000) {
    const readLen = () => editor.evaluate(el =>
        (el.value !== undefined && el.value !== null && el.tagName === 'TEXTAREA')
            ? el.value.length
            : (el.innerText || el.textContent || '').length
    );
    try {
        const start = Date.now();
        while (Date.now() - start < budgetMs) {
            const len = await readLen().catch(() => -1);
            if (len >= 0 && len < prompt.length * 0.2) return 'sent';

            for (const sel of (C.stopSelectors || [])) {
                const vis = await page.locator(sel).first()
                    .isVisible({ timeout: 200 }).catch(() => false);
                if (vis) return 'sent';
            }
            await page.waitForTimeout(400);
        }
        const finalLen = await readLen().catch(() => -1);
        if (finalLen >= prompt.length * 0.8) return 'unsent';
        return 'unknown';
    } catch (_) { return 'unknown'; }
}

/**
 * v10: When no responseSelector ever attaches, dump the largest visible text
 * blocks (shadow-piercing, ancestor-deduped) — mirrors the Gemini DIAG dump.
 * Any future response-selector drift becomes a one-minute fix instead of a
 * blind 'timeout'.
 */
async function dumpResponseDiagnostics(page, log = () => {}) {
    try {
        const info = await page.evaluate(() => {
            const roots = [document];
            try {
                const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n;
                while ((n = w.nextNode())) if (n.shadowRoot) roots.push(n.shadowRoot);
            } catch (_) {}

            const seen = new Set();
            const blocks = [];
            let scanned = 0;
            for (const r of roots) {
                let list = [];
                try { list = r.querySelectorAll('[class], article, section, main'); }
                catch (_) { continue; }
                for (const el of list) {
                    if (++scanned > 6000) break;
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const t = (el.innerText || '').trim();
                    if (t.length < 120) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    blocks.push({ el, len: t.length, preview: t.slice(0, 80).replace(/\s+/g, ' ') });
                }
                if (scanned > 6000) break;
            }

            // Prefer leaf-most blocks: ascending by length, an ancestor is
            // dropped when a kept descendant carries ≥90% of its text.
            blocks.sort((a, b) => a.len - b.len);
            const kept = [];
            for (const b of blocks) {
                if (kept.some(k => b.el.contains(k.el) && k.len >= b.len * 0.9)) continue;
                kept.push(b);
            }
            kept.sort((a, b) => b.len - a.len);
            return kept.slice(0, 10).map(({ el, len, preview }) => ({
                tag: el.tagName,
                id: el.id || '',
                classes: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
                len,
                preview,
            }));
        });
        log('DIAG: no responseSelector matched — largest visible text blocks:');
        info.forEach((b, i) => {
            log(`  [${i}] <${b.tag}> id="${b.id}" len=${b.len} class="${b.classes}" text="${b.preview}"`);
        });
    } catch (e) {
        log(`DIAG: response dump failed: ${e.message}`);
    }
}

module.exports = {
    INSERT_TEXT_LIMIT,
    findEditableElement,
    heuristicFindEditor,
    dumpEditorDiagnostics,
    inputViaClipboard,
    inputViaSimulatedPaste,
    inputViaKeyboard,
    defaultInput,
    clearEditor,
    clickSend,
    verifySendEffect,
    dumpResponseDiagnostics,
};

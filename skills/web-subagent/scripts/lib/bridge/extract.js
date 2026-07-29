/**
 * bridge/extract.js — response text extraction + HTML→Markdown.
 *
 * Extracted from providerFactory.js (Phase 1). Extracts innerText or
 * innerHTML→Markdown (responseFormat:'markdown'), runs the echo guard
 * (rejects near-identical-to-prompt text) and the adapter's postResponseHook.
 */
'use strict';

const TurndownService = require('turndown');
const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
});

/**
 * Extract and validate response text from the response element.
 *
 * v11 ECHO GUARD: adapters whose responseSelectors end in generic tails
 * ([class*="message"], [class*="message-content"], …) can have `.last()`
 * resolve to the USER's own bubble when the assistant node mounts slowly —
 * the poller then sees perfectly stable text and returns the PROMPT as the
 * "response" (silent-wrong-answer class). When the extracted text is
 * essentially the prompt itself, fail the EXTRACT stage instead.
 */
async function extractResponse(page, responseEl, config, prompt) {
    const minLen = typeof config.minResponseLength === 'number' ? config.minResponseLength : 3;
    let text;

    if (config.responseFormat === 'markdown') {
        // Extract innerHTML and convert to Markdown.
        // innerText loses all formatting (bold, code, lists, tables, links).
        // innerHTML preserves the rendered structure, and turndown converts
        // it back to well-formed Markdown.
        const html = await responseEl.evaluate(el => el.innerHTML);
        if (!html || html.trim().length < minLen) return null;
        text = turndown.turndown(html).trim();
    } else {
        text = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    }

    if (!text || text.length < minLen) return null;

    if (prompt && typeof prompt === 'string') {
        const norm = s => s.replace(/\s+/g, ' ').trim();
        const np = norm(prompt);
        const nt = norm(text);
        // Only guard non-trivial prompts, and only reject NEAR-IDENTICAL
        // text (a user bubble carries the prompt plus at most a few UI
        // labels). "Repeat after me: X" style answers, where the response
        // is a small SUBSTRING of the prompt, must stay valid.
        if (np.length >= 20) {
            const ratio = nt.length / np.length;
            const nearLen = ratio >= 0.9 && ratio <= 1.15;
            if (nt === np || (nearLen && (nt.includes(np) || np.includes(nt)))) {
                return null; // echoed prompt → EXTRACT error upstream
            }
        }
    }

    // Post-response hook (e.g. Claude thinking filter)
    if (config.postResponseHook) {
        text = await config.postResponseHook(page, text, config);
    }

    if (!text || text.length < minLen) return null;

    return text;
}

module.exports = { extractResponse, turndown };

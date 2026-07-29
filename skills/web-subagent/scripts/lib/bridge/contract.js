/**
 * bridge/contract.js — the Adapter interface and enforcement.
 *
 * An Adapter is a module that knows how to drive ONE web AI through CDP.
 * It owns all of its DOM coupling (selectors, send-button logic, completion
 * detection). The runner (bridge/run.js) owns the shared 10-step flow and
 * delegates each step to the adapter, falling back to bridge helpers when a
 * method is absent.
 *
 * Required data fields are validated at load by assertAdapter() — this
 * replaces the old "JSDoc not enforced at runtime" note from providerFactory.
 *
 * Behavioral methods (all OPTIONAL — the runner provides bridge-helper
 * defaults when one is absent):
 *   prepare(page)              default no-op
 *   findEditor(page)           default dom.findEditableElement(editorSelectors, validateEditor)
 *   input(page, editor, prompt) default dom.defaultInput
 *   send(page, editor)         default dom.clickSend(sendSelectors, sendFallback)
 * Data fields read by the defaults: stillGeneratingCheck (completion),
 * postResponseHook + responseFormat + minResponseLength (extract),
 * validateEditor (default findEditor).
 */

'use strict';

// ── Required data fields (fail-fast at load if missing) ──────────────────
// Universal across every provider: identity + where to type + where to read.
// Send is deliberately NOT required — an adapter may send via a button
// selector, via sendFallback key alone (qwen: empty sendSelectors + Enter),
// or via a custom send() override (kimi/mimo). Same for sendFallback.
const REQUIRED = [
    'key',              // provider id (gemini, chatgpt, …)
    'url',              // AI website URL
    'authDomains',      // URL substrings indicating login redirect
    'editorSelectors',  // CSS selectors for the input element
    'responseSelectors',// CSS selectors for the response container
];

/**
 * Assert an adapter carries the required data fields. Throws naming the
 * offending adapter + missing field. Called by createProviderRunner at
 * runner-construction time, so a malformed adapter fails at load, not
 * mid-conversation.
 */
function assertAdapter(adapter) {
    const name = adapter && adapter.key ? adapter.key : '<unknown>';
    const missing = REQUIRED.filter(f => {
        const v = adapter && adapter[f];
        return v === undefined || v === null
            || (Array.isArray(v) && v.length === 0);
    });
    if (missing.length) {
        throw new Error(
            `Adapter "${name}" is missing required field(s): ${missing.join(', ')}. ` +
            `See bridge/contract.js for the interface.`
        );
    }
    return adapter;
}

module.exports = {
    assertAdapter,
    REQUIRED,
};

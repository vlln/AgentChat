/**
 * bridge/contract.js — the Adapter interface, enforcement, and legacy bridging.
 *
 * An Adapter is a module that knows how to drive ONE web AI through CDP.
 * It owns all of its DOM coupling (selectors, send-button logic, completion
 * detection). The runner (bridge/run.js) owns the shared 10-step flow and
 * delegates each step to the adapter, falling back to bridge helpers when a
 * method is absent.
 *
 * Two shapes coexist during Phase 2 migration:
 *   - NATIVE  : a module exporting named methods (prepare/input/send/findEditor).
 *   - LEGACY  : an old config object with hooks (preInputHook/customSend/input).
 *               wrapConfig() lifts it into the native interface.
 * When all 9 adapters are native, wrapConfig is deleted.
 */

'use strict';

const { findEditableElement, defaultInput, clickSend } = require('./dom');
const { extractResponse } = require('./extract');

// ── Required data fields (fail-fast at load if missing) ──────────────────
// These are universal across every provider: identity + where to type + where
// to read. Send is deliberately NOT required — an adapter may send via a button
// selector, via sendFallback key alone (qwen: empty sendSelectors + Enter), or
// via a custom send() override (kimi/mimo). Same for sendFallback.
const REQUIRED = [
    'key',              // provider id (gemini, chatgpt, …)
    'url',              // AI website URL
    'authDomains',      // URL substrings indicating login redirect
    'editorSelectors',  // CSS selectors for the input element
    'responseSelectors',// CSS selectors for the response container
];

/**
 * Assert an adapter carries the required data fields. Throws naming the
 * offending adapter + missing field. Replaces the old "JSDoc not enforced"
 * comment in providerFactory.js.
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

// ── Legacy → native bridge ────────────────────────────────────────────────
//
// Old config objects name their behavioral hooks differently from the
// interface methods (preInputHook→prepare, customSend→send). Adapters whose
// only "hooks" are data-style (validateEditor, postResponseHook,
// stillGeneratingCheck) need NO wrapping — the runner's defaults read those
// data fields directly, exactly as the old factory did.
//
// So wrapConfig only translates the hooks that become METHODS:
//   preInputHook  → prepare(page)        (old called as (page, cfg))
//   customSend    → send(page, editor)   (same signature)
//   input         → input(...)           (same name; just ensure a default)

/**
 * Lift a legacy config object into the Adapter interface. The returned object
 * keeps all config data fields (selectors, patterns, tunables) and adds the
 * named methods the runner dispatches on.
 */
function wrapConfig(cfg) {
    return {
        ...cfg,
        // preInputHook(page, cfg) → prepare(page). Pass cfg so adapters that
        // read policy from it (chatgpt, gemini) keep working unchanged.
        prepare: cfg.preInputHook
            ? (page) => cfg.preInputHook(page, cfg)
            : undefined,
        // input is the same name; default to the shared clipboard/keyboard
        // strategy when the adapter didn't supply one.
        input: cfg.input ?? defaultInput,
        // customSend → send. Undefined when absent → runner's clickSend default.
        send: cfg.customSend,
        // findEditor/extract/isStillGenerating are intentionally NOT mapped:
        // the runner's defaults read the data fields (editorSelectors,
        // validateEditor, responseFormat, postResponseHook, stillGeneratingCheck)
        // directly — identical to the legacy factory's behavior.
    };
}

/**
 * Normalize a raw adapter module/config into the interface shape, dispatching
 * to wrapConfig for legacy configs and assertAdapter for native modules.
 *
 * Legacy detection: the two hook names that become methods with DIFFERENT
 * names (preInputHook, customSend). Their presence means the file hasn't been
 * migrated yet.
 */
function toAdapter(raw) {
    if ('preInputHook' in raw || 'customSend' in raw) {
        return wrapConfig(raw);
    }
    return assertAdapter(raw);
}

module.exports = {
    assertAdapter,
    wrapConfig,
    toAdapter,
    REQUIRED,
};

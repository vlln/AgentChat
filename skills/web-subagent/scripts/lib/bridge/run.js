/**
 * bridge/run.js — the provider conversation runner (former createProviderRunner).
 *
 * Extracted from providerFactory.js (Phase 1). Thin 10-step flow skeleton:
 * navigate → auth → quota → overlays → prepare → findEditor → input → send
 * → waitForCompletion → extract → onComplete. Each step delegates to the
 * adapter's named method when present, falling back to bridge helpers
 * (findEditableElement / defaultInput / clickSend / extractResponse) when
 * absent. DOM specifics live in the adapter; this skeleton stays DOM-free.
 *
 * Phase 2: createProviderRunner now normalizes its input via toAdapter()
 * (contract.js) — legacy configs are lifted by wrapConfig, native interface
 * modules are validated by assertAdapter. The 4 behavioral steps (prepare /
 * findEditor / input / send) dispatch on the interface methods.
 */
'use strict';

const { classifyError, STAGES } = require('../errors');
const { log: _tlog } = require('../terminal');
const { getSessionUrl, saveSessionUrl, clearSessionUrl } = require('../sessions');
const { defaultInput, INSERT_TEXT_LIMIT, findEditableElement, clearEditor, clickSend, verifySendEffect, dumpResponseDiagnostics } = require('./dom');
const { waitForCompletion } = require('./completion');
const { checkOverlays, COMMON_CN_QUOTA_PATTERNS } = require('./overlays');
const { extractResponse } = require('./extract');
const { assertAdapter } = require('./contract');

const flog = (key, msg) => { try { _tlog(key || 'factory', msg); } catch (_) {} };

// Chinese-language quota patterns shared across 5+ providers (Qwen, Kimi,
const DEFAULTS = {
    navTimeout: 45000,
    navWaitUntil: 'domcontentloaded',
    navPostDelay: 0,
    stopWaitMode: 'hidden',
    stopBtnExtensionMs: 0,
    completionAnchor: null,
    stillGeneratingCheck: null,
    stillGeneratingMaxHoldMs: 90_000, // v11: ⚙ hold cap (see schema above)
    responseSelectorTimeout: 30_000,
    stabilityWindow: 10_000,
    pollInterval: 2_000,
    minResponseLength: 10,
    insertTextLimit: INSERT_TEXT_LIMIT,
    input: null, // set below after atomic ops are defined
    dismissPatterns: [], // overlays matching these are safe to dismiss (close button click)
    blockedUrlPatterns: [], // post-nav URLs classified as 'auth' (CAPTCHA/consent/interstitial)
    signedOutSelectors: [], // visible ⇒ signed-out landing page — fail fast as 'auth'
};

DEFAULTS.input = defaultInput;

// ══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a provider runner from a config object.
 *
 * The returned function has the same signature as the legacy tryXxx() functions:
 *   async (page, prompt, timeoutMs, ctx) → { success, response? }
 *
 * This makes it a drop-in replacement for the caller's error handling.
 *
 * @param {object} cfg — provider config (see CONFIG SCHEMA above)
 * @returns {(page: Page, prompt: string, timeoutMs: number, ctx: object) => Promise<{success: boolean, response?: string, reason?: string}>}
 */
function createProviderRunner(cfg) {
    // Merge defaults, then validate the adapter carries the required data
    // fields (Phase 2: all adapters are now native interface modules — the
    // legacy wrapConfig bridge is gone). `C` carries the named methods the
    // steps below dispatch on (prepare/findEditor/input/send), with bridge
    // helper defaults applied inline when a method is absent.
    const C = assertAdapter({ ...DEFAULTS, ...cfg });

    return async function run(page, prompt, timeoutMs, ctx) {
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            const err = new Error('Invalid prompt: must be a non-empty string');
            return classifyError(err, STAGES.PRE_EDITOR, 'runner');
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            const err = new Error(`Invalid timeoutMs: ${timeoutMs}`);
            return classifyError(err, STAGES.PRE_EDITOR, 'runner');
        }
        const provStart = Date.now();

        // ── Step 1: Navigate ──
        // Resume a previous session if available, otherwise start fresh.
        // Session URLs are provider-specific (e.g. /chat/38435105284969218)
        // and allow multi-turn conversations to continue.
        let usedSessionUrl = false;
        try {
            const sessionUrl = C.resumeSession !== false ? getSessionUrl(C.key) : null;
            const navUrl = sessionUrl || C.url;

            await page.goto(navUrl, {
                waitUntil: C.navWaitUntil,
                timeout: C.navTimeout,
            });

            if (sessionUrl) {
                // Verify the session URL didn't redirect to login/auth/404
                const landedUrl = page.url();
                const isAuth = (C.authDomains || []).some(d => landedUrl.includes(d))
                            || landedUrl.includes('/auth')
                            || landedUrl.includes('/login');
                if (isAuth || landedUrl.includes('/404') || landedUrl.includes('/error')) {
                    flog(C.key, `session URL expired — clearing and retrying with base URL`);
                    clearSessionUrl(C.key);
                    await page.goto(C.url, {
                        waitUntil: C.navWaitUntil,
                        timeout: C.navTimeout,
                    });
                } else {
                    usedSessionUrl = true;
                    flog(C.key, `resumed session: ${landedUrl.slice(0, 80)}`);
                }
            }

            // SPA render wait — some providers need extra time for React/Angular to mount
            if (C.navPostDelay > 0) {
                await page.waitForTimeout(C.navPostDelay);
            }

            // Resume validity probe: a saved session URL may load an
            // old-conversation view that has NO fresh compose box (the
            // redirect/auth check above only catches login/404 redirects, not
            // a successfully-loaded-but-inputless page). If no editor is
            // visible, clear the session and fall back to the base URL so
            // Step 5 doesn't fail at EDITOR_FIND.
            if (usedSessionUrl) {
                let editorVisible = false;
                for (const sel of (C.editorSelectors || [])) {
                    if (await page.locator(sel).first()
                            .isVisible({ timeout: 500 }).catch(() => false)) {
                        editorVisible = true;
                        break;
                    }
                }
                if (!editorVisible) {
                    flog(C.key, `resumed session has no editor — clearing and retrying with base URL`);
                    clearSessionUrl(C.key);
                    await page.goto(C.url, {
                        waitUntil: C.navWaitUntil,
                        timeout: C.navTimeout,
                    });
                    if (C.navPostDelay > 0) await page.waitForTimeout(C.navPostDelay);
                }
            }
        } catch (e) {
            // If the session URL fails (e.g. 404), clear and fall back
            if (getSessionUrl(C.key)) {
                clearSessionUrl(C.key);
                try {
                    await page.goto(C.url, {
                        waitUntil: C.navWaitUntil,
                        timeout: C.navTimeout,
                    });
                    if (C.navPostDelay > 0) await page.waitForTimeout(C.navPostDelay);
                } catch (e2) {
                    return classifyError(e2, STAGES.NAVIGATE, C.key);
                }
            } else {
                return classifyError(e, STAGES.NAVIGATE, C.key);
            }
        }

        // ── Step 2: Auth check ──
        try {
            const url = page.url();
            // Signed-out failure surfaces THREE ways, all needing the same
            // operator action (re-auth in the shared browser):
            //   1. redirect to a login domain           → authDomains
            //   2. redirect to CAPTCHA/consent/upsell   → blockedUrlPatterns
            //   3. signed-out landing page served ON the provider domain
            //      (Gemini does this — URL looks fine)  → signedOutSelectors
            // Cases 2–3 previously fell through to model-activation / editor /
            // send failures → reason 'error' → exit 9 (all_exhausted): the
            // caller burned the full per-call budget and never learned the
            // real fix. Classify all three as 'auth' within seconds of nav.
            const isAuth = C.authDomains.some(d => url.includes(d))
                        || url.includes('/auth')
                        || url.includes('/login')
                        || (C.blockedUrlPatterns || []).some(re => re.test(url));
            if (isAuth) {
                return classifyError(
                    new Error(`Login required (landed on ${url.slice(0, 100)})`),
                    STAGES.AUTH_CHECK, C.key, 'auth'
                );
            }
            for (const sel of (C.signedOutSelectors || [])) {
                if (await page.locator(sel).first()
                        .isVisible({ timeout: 500 }).catch(() => false)) {
                    return classifyError(
                        new Error(`Signed-out UI present: ${sel}`),
                        STAGES.AUTH_CHECK, C.key, 'auth'
                    );
                }
            }
        } catch (e) {
            return classifyError(e, STAGES.AUTH_CHECK, C.key);
        }

        // ── Step 3: Quota check ──
        try {
            const bodyText = await page.evaluate(() => document.body?.innerText || '');
            for (const pattern of (C.quotaPatterns || [])) {
                if (pattern.test(bodyText)) {
                    return classifyError(
                        new Error(`Quota hit: ${pattern}`),
                        STAGES.QUOTA_CHECK, C.key, 'quota'
                    );
                }
            }
        } catch (e) {
            return classifyError(e, STAGES.QUOTA_CHECK, C.key);
        }

        // ── Step 3.5: Overlay check — dismiss modals or bail if blocked ──
        try {
            const ov = await checkOverlays(page, C);
            if (ov.block) {
                return classifyError(
                    new Error(ov.detail),
                    STAGES.OVERLAY_CHECK, C.key, ov.block
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.OVERLAY_CHECK, C.key);
        }

        // ── Step 4: Pre-input hook (e.g. Gemini Pro detection) ──
        if (C.prepare) {
            try {
                await C.prepare(page);
            } catch (e) {
                return classifyError(e, STAGES.PRE_EDITOR, C.key);
            }
        }

        // ── Step 5: Find editor ──
        // v10: findEditableElement now self-heals (heuristic rescue) and dumps
        // diagnostics on total failure — pass the provider-tagged logger.
        // Phase 2: adapter may override findEditor(); default uses its
        // editorSelectors + validateEditor data fields.
        const editor = C.findEditor
            ? await C.findEditor(page)
            : await findEditableElement(page, C.editorSelectors, C.validateEditor, (m) => flog(C.key, m));
        if (!editor) {
            return classifyError(
                new Error('No editable input found'),
                STAGES.EDITOR_FIND, C.key, 'error'
            );
        }

        // ── Step 6: Clear + input text ──
        // Stage label fixed: input failures were previously mislabeled EDITOR_FIND,
        // skewing telemetry-based failure analysis.
        try {
            await (C.clearEditor || clearEditor)(page, editor);
            const inputOk = await (C.input || defaultInput)(page, editor, prompt, { timeoutMs });
            if (!inputOk) {
                return classifyError(
                    new Error('Failed to input text'),
                    STAGES.INPUT, C.key, 'error'
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.INPUT, C.key);
        }

        // ── Step 6.6: overlay re-check — a modal may appear AFTER the editor
        // was found (focus-triggered, or Doubao's first-visit interstitial).
        // The Step 3.5 check ran before the editor existed; dismiss anything
        // new so it doesn't intercept the send click. Best-effort: a hard
        // block surfaces as OVERLAY_CHECK; a dismissable one closes silently.
        try {
            const ov = await checkOverlays(page, C);
            if (ov.block) {
                return classifyError(
                    new Error(ov.detail),
                    STAGES.OVERLAY_CHECK, C.key, ov.block
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.OVERLAY_CHECK, C.key);
        }

        // ── Step 6.5: baseline response-element counts (stale-response guard) ──
        // On a reused tab with restored history, phase 2's `.last()` can attach
        // to the PREVIOUS conversation's final message. Counting matches per
        // responseSelector BEFORE sending lets waitForCompletion prefer the
        // first element that appears BEYOND this count. Fresh pages count 0 →
        // the guard is inert there. Best-effort: failures just disable the guard.
        const baselineCounts = {};
        for (const sel of C.responseSelectors) {
            try { baselineCounts[sel] = await page.locator(sel).count(); }
            catch (_) { /* guard disabled for this selector */ }
        }

        // ── Step 7: Send ── (stage label fixed: was mislabeled WAIT_RESPONSE)
        try {
            if (C.send) {
                await C.send(page, editor);
            } else {
                await clickSend(page, editor, C.sendSelectors, C.sendFallback);
            }
        } catch (e) {
            return classifyError(e, STAGES.SEND, C.key);
        }

        // ── Step 7.5: v10 send-effect verification ──
        // A send that silently did nothing (Enter inserted a newline; a stale
        // button ate the click) previously surfaced only as a WAIT_RESPONSE
        // 'timeout' after the full budget. Retry with the alternate key ONLY
        // when ≥80% of the prompt is demonstrably still in the editor — the
        // one state where a retry cannot double-send. Best-effort throughout.
        try {
            const eff = await verifySendEffect(page, editor, prompt, C);
            if (eff === 'unsent') {
                // A popup may have appeared AFTER Step 6.6's check (focus/
                // click-triggered, e.g. Doubao's 下载电脑版 interstitial) and
                // intercepted the send click. Dismiss any new overlay, then
                // retry the send with the alternate key.
                const ov = await checkOverlays(page, C).catch(() => ({ block: null }));
                if (ov && ov.block) {
                    flog(C.key, `overlay appeared during send — ${ov.detail}`);
                }
                const alt = (C.sendFallback === 'Enter') ? 'ControlOrMeta+Enter' : 'Enter';
                flog(C.key, `send not confirmed — prompt still in editor; retrying with ${alt}`);
                await editor.focus().catch(() => {});
                if (C.send) {
                    await C.send(page, editor).catch(() => {});
                } else {
                    await page.keyboard.press(alt);
                }
                await page.waitForTimeout(1500);
            }
        } catch (_) { /* verification is best-effort */ }

        // ── Step 8: Wait for response ──
        // BUGFIX: pass provStart (full provider budget start) instead of respStart
        // (post-input reset). waitForCompletion's phase-1 comment already assumes
        // startTime covers pre-send elapsed time; the old code gave waiting a fresh
        // clock, letting one provider consume up to ~2× its budget.
        // Shallow per-run copy: C is shared across invocations of this runner,
        // so per-run state (baselineCounts) must never be written onto it.
        const responseEl = await waitForCompletion(page, { ...C, baselineCounts }, provStart, timeoutMs);
        if (!responseEl) {
            // v10: dump the largest visible text blocks BEFORE classifying —
            // a response-selector drift is now diagnosable from one log.
            await dumpResponseDiagnostics(page, (m) => flog(C.key, m)).catch(() => {});
            return classifyError(
                new Error('No response element appeared'),
                STAGES.WAIT_RESPONSE, C.key, 'timeout'
            );
        }

        // ── Step 9: Extract + post-process ──
        // BUGFIX: previously not wrapped in try/catch, so a postResponseHook throw
        // (e.g. Gemini's ERR_SAFETY_REJECTED) bypassed classifyError entirely here
        // and only got caught by the generic outer catch in the caller, which
        // used to always collapse to reason='error' — losing the safety signal.
        let response;
        try {
            response = await extractResponse(page, responseEl, C, prompt);
        } catch (e) {
            return classifyError(e, STAGES.EXTRACT, C.key);
        }
        if (!response) {
            return classifyError(
                new Error('Response too short or empty'),
                STAGES.EXTRACT, C.key, 'error'
            );
        }

        // ── Step 10: Success ──
        if (ctx && ctx.telemetry) {
            ctx.telemetry.per_provider_ms[C.key] = Date.now() - provStart;
        }

        // Save session URL for future resume (multi-turn conversations)
        if (C.resumeSession !== false) {
            try {
                const currentUrl = page.url();
                saveSessionUrl(C.key, currentUrl, C.url);
            } catch (_) { /* best-effort */ }
        }

        return { success: true, response };
    };
}

module.exports = {
    createProviderRunner,
    DEFAULTS,
    COMMON_CN_QUOTA_PATTERNS,
};

/**
 * bridge/completion.js — response-completion polling.
 *
 * Extracted from providerFactory.js (Phase 1). Stop-button detection →
 * response-element attach → stability polling (with stillGeneratingCheck
 * resets capped by stillGeneratingMaxHoldMs). No DOM specifics: all
 * selectors/tunables come from the adapter config passed in.
 */
'use strict';

/**
 * Wait for AI to finish generating.
 *
 * Strategy: stop button detection → response element → stability polling.
 * Calls config.onProgress(status) if provided:
 *   '+' = text grew, '~' = text changed without growing (shrink / in-place
 *   mutation — e.g. a collapsing tool/thinking card), '.' = stable,
 *   '?' = DOM error, '⚙' = still generating
 *
 * v2 (2026-07-03): Added stopBtnExtensionMs, completionAnchor, stillGeneratingCheck
 * for Pro Extended Thinking support (Gemini bursty output, 3-5 min generation).
 * v11 (2026-07): Phase-3 rework for agentic tool phases (Kimi 联网搜索 truncation):
 *   - CHANGE detection, not GROWTH detection. The old `text.length > lastLen`
 *     never reset the clock when innerText SHRANK — exactly what happens when
 *     a search/thinking card collapses and the real answer starts streaming:
 *     until the answer grows back past the card's peak length, every poll
 *     looked "stable" and the window could expire MID-ANSWER. Fingerprint
 *     (length + 80-char tail) now catches shrink and same-length mutation.
 *   - stillGeneratingCheck now receives (page, { text, sinceChangeMs,
 *     elapsedMs }) and is only consulted when the text did NOT change
 *     (its verdict was ignored on growth anyway — saves one CDP round-trip
 *     per growing poll).
 *   - ⚙ resets are capped by stillGeneratingMaxHoldMs since the last REAL
 *     text change, so a false-positive check degrades to a bounded delay
 *     instead of burning the whole provider budget.
 */
async function waitForCompletion(page, config, startTime, timeoutMs) {
    const { stopSelectors, stabilityWindow, pollInterval, onProgress } = config;
    const tick = onProgress || (() => {});

    // Phase 1: wait for stop button to appear then disappear
    //
    // BUGFIX (was: always broke after the first selector regardless of match —
    // `.catch(() => {})` on the awaited waitFor() swallowed timeouts *before* the
    // outer try/catch ever saw a rejection, so `break` ran unconditionally on
    // iteration 1). Fix: probe each selector for a short window first; only the
    // selector that actually matches gets the full detection sequence.
    const stopMode = config.stopWaitMode || 'hidden';
    const stopExt = config.stopBtnExtensionMs || 0;
    const STOP_PROBE_TIMEOUT_MS = 3000;
    if (stopSelectors && stopSelectors.length > 0) {
        for (const sel of stopSelectors) {
            const stopBtn = page.locator(sel).first();

            // Quick probe: did *this* selector's stop button actually show up?
            const appeared = await stopBtn
                .waitFor({ state: 'visible', timeout: STOP_PROBE_TIMEOUT_MS })
                .then(() => true)
                .catch(() => false);
            if (!appeared) continue; // this selector never matched — try the next one

            if (stopMode === 'detached') {
                // Qwen: stop button is removed from DOM when done, not just hidden.
                const cap = Math.min(timeoutMs, 300000);
                const elapsed = Date.now() - startTime;
                const remaining = cap - elapsed;
                // P1-7: clamp to actual remaining budget — Math.max(30000, ...)
                // could force an extra 30s wait even when budget is already
                // exhausted, causing single-provider overrun that chains into
                // totalTimeout overflow. Budget exhausted → return immediately.
                if (remaining < 5000) break; // not enough time to wait meaningfully
                await stopBtn.waitFor({ state: 'detached', timeout: Math.max(5000, remaining) }).catch(() => {});
            } else {
                const elapsed = Date.now() - startTime;
                const remaining = timeoutMs - elapsed;
                if (remaining < 5000) break;
                await stopBtn.waitFor({ state: 'hidden', timeout: Math.max(5000, remaining) }).catch(() => {});

                // Extension for long-generation models (e.g. Pro Extended Thinking)
                if (stopExt > 0) {
                    const stillWorking = await stopBtn.isVisible().catch(() => false);
                    if (stillWorking) {
                        const elapsed2 = Date.now() - startTime;
                        const remaining2 = timeoutMs - elapsed2;
                        // P1-7: clamp extension to remaining budget; don't force
                        // a 20s floor when budget is already gone.
                        const extra = Math.min(stopExt, Math.max(0, remaining2 - 5000));
                        if (extra > 0) {
                            await stopBtn.waitFor({ state: 'hidden', timeout: extra }).catch(() => {});
                        }
                    }
                }
            }
            break; // handled the matching stop button — done with phase 1
        }
        // If no selector ever matched, that's fine (e.g. a fast response that never
        // showed a stop button) — fall through to phase 2 as before.
    }

    // Phase 2: find response element
    //
    // BUGFIX: same dead-fallback pattern as phase 1 — capture the resolved
    // boolean instead of discarding it, so unmatched selectors actually get
    // skipped instead of the loop always keeping the first one.
    //
    // BUDGET FIX: each selector previously waited min(selTimeout, timeoutMs)
    // with NO elapsed-time deduction — after phase 1 legitimately consumed the
    // budget, an adapter with 5 responseSelectors (e.g. Claude) could still
    // burn 5 × 30s past the deadline. Per-selector wait is now clamped to the
    // REMAINING budget, floored at 1s so an already-attached element is still
    // found instantly even when the budget is spent.
    //
    // STALE-RESPONSE GUARD: on a REUSED tab whose SPA restored a previous
    // conversation, `.last()` initially resolves to the LAST message of the OLD
    // chat. If the send silently failed (or the new message is slow to mount),
    // stability polling would see that old, stable text and return a previous
    // answer for the new prompt — the silent-wrong-answer class. When the
    // pre-send baseline count for a selector was > 0, we first wait briefly for
    // element #baseline (the first NEW node) to attach; only if that gate fails
    // (some UIs replace in place rather than append) do we fall back to the old
    // `.last()` behavior. baseline === 0 (fresh page, the common case) is a
    // zero-cost no-op.
    const selTimeout = config.responseSelectorTimeout || 30_000;
    const baseline = config.baselineCounts || null;
    let responseEl = null;
    for (const sel of config.responseSelectors) {
        const remaining = timeoutMs - (Date.now() - startTime);
        const perWait = Math.min(selTimeout, Math.max(1000, remaining));

        if (baseline && Number.isInteger(baseline[sel]) && baseline[sel] > 0) {
            const freshGate = await page.locator(sel).nth(baseline[sel])
                .waitFor({ state: 'attached', timeout: Math.min(perWait, 15_000) })
                .then(() => true)
                .catch(() => false);
            if (freshGate) {
                responseEl = page.locator(sel).last(); // live locator tracks newest
                break;
            }
            // gate failed — fall through to the legacy .last() probe below
        }

        const loc = page.locator(sel).last();
        const attached = await loc
            .waitFor({ state: 'attached', timeout: perWait })
            .then(() => true)
            .catch(() => false);
        if (attached) {
            responseEl = loc;
            break;
        }
    }

    if (!responseEl) return null;

    // Phase 3: stability polling
    const stillGeneratingCheck = config.stillGeneratingCheck || (async () => false);
    // v11: ⚙ hold cap — see docstring. Re-arms on every REAL text change.
    const stillGenMaxHold = Number.isFinite(config.stillGeneratingMaxHoldMs)
        ? config.stillGeneratingMaxHoldMs
        : 90_000;
    let lastLen = 0;
    // v11 fingerprint: length + tail. Catches shrink (collapsing tool cards)
    // and same-length in-place mutation, which pure length-growth missed.
    // Initialized to the empty-text fingerprint so an empty responseEl on
    // poll 1 does NOT count as a change (exact parity with the old code).
    let lastFp = '0\u0000';
    let lastChangeTime = Date.now();
    let lastRealChangeTime = Date.now(); // only ACTUAL text changes re-arm the ⚙ cap
    const deadline = startTime + timeoutMs;

    // ROBUSTNESS: distinguish a transient read miss (element re-rendered mid-poll)
    // from a fatal page loss (tab crashed, navigated away, browser context gone).
    // The old blanket `catch { tick('?') }` treated BOTH as transient and kept
    // polling a dead page until the FULL timeoutMs elapsed — turning a 2s crash
    // into a 180s hang and burning the whole provider budget on nothing. We now
    // count consecutive errors and, if the page itself is closed/crashed, break
    // immediately and return whatever text we captured before the failure.
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;
    while ((Date.now() - lastChangeTime) < stabilityWindow && Date.now() < deadline) {
        await page.waitForTimeout(pollInterval);
        // Fast path out: page/context gone → no point polling further.
        if (page.isClosed()) { tick('?'); break; }
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            consecutiveErrors = 0;

            const now = Date.now();
            const fp = text.length + '\u0000' + text.slice(-80);

            if (fp !== lastFp) {
                // ANY change — growth, shrink (collapsing search/thinking
                // card), or same-length mutation — means generation is live.
                const grew = text.length > lastLen;
                lastLen = text.length;
                lastFp = fp;
                lastChangeTime = now;
                lastRealChangeTime = now;
                tick(grew ? '+' : '~');
            } else {
                // Text static — ask the adapter whether the UI still says
                // "working" (tool phase, bursty thinking). Only consulted
                // here: its verdict was ignored on change anyway, so this
                // also saves one CDP round-trip per changing poll.
                const stillGen = await stillGeneratingCheck(page, {
                    text,
                    sinceChangeMs: now - lastRealChangeTime,
                    elapsedMs: now - startTime,
                }).catch(() => false);

                if (stillGen && (now - lastRealChangeTime) < stillGenMaxHold) {
                    lastChangeTime = now; // reset clock — generation ongoing
                    tick('⚙');
                } else {
                    tick('.');
                }
            }
        } catch (e) {
            tick('?');
            // A crashed/navigated page throws "Target closed" / "Execution context
            // was destroyed" on every subsequent evaluate — retrying can't recover.
            const msg = String(e && e.message || e);
            if (/Target.*closed|context was destroyed|has been closed|crashed/i.test(msg)) {
                break;
            }
            // Otherwise treat as transient, but cap the run of failures so a
            // permanently-detached responseEl can't spin to the deadline either.
            if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        }
    }

    // Phase 4 (optional): completion anchor — definitive "done" signal
    //
    // BUGFIX: previously gave the *first* anchor selector the entire remaining
    // timeout budget and broke unconditionally afterwards (same swallowed-catch
    // pattern as phases 1-2), so locale variants after the first (e.g. Simplified
    // Chinese / English "Copy" button) were never actually tried — and an
    // unmatched first selector could silently burn the whole remaining budget.
    // Fix: split the remaining budget across candidates; only a real match breaks.
    const anchors = config.completionAnchor;
    if (anchors) {
        const anchorList = Array.isArray(anchors) ? anchors : [anchors];
        // BUDGET FIX (P1-7 follow-up): the old Math.max(10000,·) forced a 10s
        // wait even with the budget exhausted, and the 5s per-anchor floor broke
        // the "split the remaining budget" invariant — 4 anchors × max(5s, r/4)
        // can spend 20s when only 10s remain (Gemini has 4 locale variants).
        // Now: a small 2s grace so a visible anchor is still caught instantly,
        // a hard cumulative deadline, and a 1s per-anchor floor within it.
        const remainingBudget = Math.max(2000, timeoutMs - (Date.now() - startTime));
        const anchorDeadline = Date.now() + remainingBudget;
        const perAnchorTimeout = Math.max(1000, Math.floor(remainingBudget / anchorList.length));
        for (const sel of anchorList) {
            const left = anchorDeadline - Date.now();
            if (left <= 0) break; // cumulative budget spent — stop probing
            const found = await page.locator(sel).last().waitFor({
                state: 'visible',
                timeout: Math.min(perAnchorTimeout, left),
            }).then(() => true).catch(() => false);
            if (found) break; // first matching anchor wins
        }
    }

    return responseEl;
}

module.exports = { waitForCompletion };

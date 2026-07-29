/**
 * bridge/overlays.js — modal/dialog detection and dismissal.
 *
 * Extracted from providerFactory.js (Phase 1). Scans for visible overlays,
 * hard-blocks on quota/auth text, best-effort dismisses the rest. The login
 * regex here is deliberately negative-lookbehind guarded (退出登录/免登录/已登录
 * must NOT auth-block) — still_working.test.js source-scans this file for it.
 */
'use strict';

// Dismissable overlay patterns shared across providers. New-feature popups,
// announcements, and welcome modals that are safe to close via CLOSE_BTN_SEL.
const COMMON_DISMISS_PATTERNS = [
    /新功能/i, /公告/i, /欢迎/i, /更新.*(?:说明|日志)/i,
    /what'?s\s*new/i, /new\s*feature/i, /welcome/i,
    /try\s*(?:the\s*)?new/i, /introducing/i,
];

// Common CN-provider quota-exhaustion patterns. Used by adapters that target
// mainland-Chinese AI services (Qwen, Kimi, DeepSeek, MiniMax, MiMo, Doubao).
const COMMON_CN_QUOTA_PATTERNS = [
    /额度.*(?:已|用).*(?:完|尽|满)/i,
    /quota\s*(?:exceeded|limit)/i,
    /次数.*(?:已|用).*(?:完|尽)/i,
    /请.*(?:充值|升级|续费)/i,
];

// ══════════════════════════════════════════════════════════════════════════════
// OVERLAY CHECK — detect and handle modals/dialogs blocking the input area
// ══════════════════════════════════════════════════════════════════════════════

const OVERLAY_SEL = [
    '[role="dialog"]', '[role="alertdialog"]',
    '.modal', '[class*="modal"]', '[class*="dialog"]',
    '[class*="overlay"]', '[class*="popup"]',
];

const CLOSE_BTN_SEL = [
    '[aria-label*="close" i]', '[aria-label*="Close" i]',
    '[aria-label*="关闭"]', '[aria-label*="Dismiss" i]',
    'button:has-text("×")', 'button:has-text("Close")',
    'button:has-text("关闭")', 'button:has-text("Got it")',
    'button:has-text("Accept")', 'button:has-text("同意")',
    'button:has-text("知道了")', 'button:has-text("继续")',
    // "remind me later" — Doubao's 下载电脑版 interstitial dismisses via this
    'button:has-text("下次提醒我")', 'button:has-text("稍后提醒")',
    'button:has-text("以后再说")', 'button:has-text("暂不")',
    '[class*="close" i]', 'svg[class*="close" i]',
];

/**
 * Scan for visible overlays. If found:
 *   - quota/auth text → hard block (skip to next provider)
 *   - dismissable text → click close button, continue
 *   - unknown → try close, if still present → block
 *
 * Returns { block: string|null, detail: string }
 */
async function checkOverlays(page, C) {
    // PERF: probe all overlay selectors CONCURRENTLY. The serial loop paid the
    // full 800ms isVisible timeout per ABSENT selector — 7 selectors ≈ 5.6s of
    // dead time on every provider visit (the no-overlay case is the common
    // one). CDP multiplexes fine; the whole scan now costs ~0.8s.
    let visFlags;
    try {
        visFlags = await Promise.all(OVERLAY_SEL.map(sel =>
            page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)
        ));
    } catch (_) {
        visFlags = OVERLAY_SEL.map(() => false);
    }

    let anyDismissed = false;
    for (let s = 0; s < OVERLAY_SEL.length; s++) {
        if (!visFlags[s]) continue;
        const sel = OVERLAY_SEL[s];
        let el;
        try {
            el = page.locator(sel).first();
        } catch (_) { continue; }

        // STALE-SNAPSHOT GUARD: visFlags was captured BEFORE any dismissal.
        // The same modal typically matches several selectors ([role="dialog"]
        // AND [class*="dialog"]). After the first selector dismissed it, later
        // selectors still carried visFlags=true; the now-HIDDEN element's
        // textContent still matched (innerText is '' when hidden, so the ||
        // falls through to textContent), but its close button was invisible —
        // tryDismissOverlay failed and a SUCCESSFULLY dismissed popup came
        // back as {block:'error'}, failing the provider. Once anything was
        // dismissed, re-probe visibility live before processing.
        if (anyDismissed) {
            const stillVisible = await el.isVisible({ timeout: 300 }).catch(() => false);
            if (!stillVisible) continue;
        }

        const text = await el.evaluate(n => (n.innerText || n.textContent || '').trim()).catch(() => '');
        if (text.length < 5) continue;

        // Skip: known non-blocking page furniture (footer disclaimers, permanent
        // info bars) that happen to sit inside an overlay-like container.
        const skipPatterns = C.skipOverlayPatterns || [];
        if (skipPatterns.some(p => p.test(text))) continue;

        // Hard block: quota
        for (const pat of (C.quotaPatterns || [])) {
            if (pat.test(text)) return { block: 'quota', detail: text.slice(0, 120) };
        }
        // Hard block: login
        // v11: '登录' needs a negative lookbehind — settings dialogs contain
        // 退出登录 (logout) and marketing copy contains 免登录/已登录, all of
        // which hard-blocked a perfectly signed-in provider as 'auth'.
        // \b around log in / sign in similarly stops "Blogindex"-style hits.
        if (/(?:\blog\s*in\b|\bsign\s*in\b|(?<!退出|已|免)登\s*录|请先登录|Continue with Google)/i.test(text)) {
            return { block: 'auth', detail: text.slice(0, 120) };
        }

        // Soft block: try to dismiss. Known-dismissable overlays (matched against
        // C.dismissPatterns) are expected to close cleanly via CLOSE_BTN_SEL;
        // unrecognized overlays are still attempted best-effort (matches the
        // "unknown → try close, if still present → block" policy above), but are
        // now labeled distinctly so failures are easier to diagnose from logs.
        // BUGFIX: previously `dismissable ? 'error' : 'error'` — both branches
        // returned the same value, so `dismissable` was computed and discarded.
        const dismissable = (C.dismissPatterns || []).some(p => p.test(text));
        const dismissed = await tryDismissOverlay(page, el);
        if (!dismissed) {
            const kind = dismissable ? 'known overlay' : 'unrecognized overlay';
            return { block: 'error', detail: `${kind} stuck: ${text.slice(0, 120)}` };
        }
        // Dismissed — keep scanning the REMAINING selectors instead of returning:
        // a welcome popup can sit on top of a quota modal, and the early return
        // let the quota state slip through to a doomed input attempt.
        anyDismissed = true;
        continue;
    }
    return { block: null };
}

async function tryDismissOverlay(page, el) {
    // Phase 1: search within overlay element
    for (const sel of CLOSE_BTN_SEL) {
        try {
            const btn = el.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click();
                await page.waitForTimeout(800);
                // Check: overlay gone?
                if (!(await el.isVisible({ timeout: 500 }).catch(() => true))) return true;
            }
        } catch (_) { /* next selector */ }
    }
    // Phase 2: fallback — page-wide search (MiMo-style overlays may position
    // the dismiss button outside the overlay container's DOM hierarchy)
    for (const sel of CLOSE_BTN_SEL) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click();
                await page.waitForTimeout(800);
                if (!(await el.isVisible({ timeout: 500 }).catch(() => true))) return true;
            }
        } catch (_) { /* next selector */ }
    }
    return false;
}

module.exports = {
    OVERLAY_SEL,
    CLOSE_BTN_SEL,
    checkOverlays,
    tryDismissOverlay,
    COMMON_DISMISS_PATTERNS,
    COMMON_CN_QUOTA_PATTERNS,
};

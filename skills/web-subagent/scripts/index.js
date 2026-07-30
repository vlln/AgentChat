#!/usr/bin/env node
/**
 * AgentChat — CDP bridge from web AI to a callable provider.
 *
 * Sends a prompt to ONE web AI provider via Chrome CDP and returns the answer.
 * No fallback, no cascading — the caller decides which provider and what to do
 * on failure.
 *
 * Usage:
 *   node index.js --only=Kimi "Your prompt here"
 *   node index.js --only=ChatGPT --timeout=600000 "Long prompt..."
 *   echo "Prompt from stdin" | node index.js --only=Gemini
 *   node index.js --smoke          # verify all providers reachable
 *   node index.js --doctor         # check CDP connectivity only
 *
 * Exit codes:
 *   0 - Success (response on stdout)
 *   1 - Chrome CDP not reachable (ERR_NO_CDP)
 *   2 - Provider auth-gated (ERR_AUTH)
 *   3 - Safety rejected (ERR_SAFETY)
 *   4 - Internal error (ERR_INTERNAL)
 *   5 - Provider rate-limited (ERR_RATE_LIMITED)
 *   9 - Provider failed, other reason (ERR_EXHAUSTED)
 *  10 - Timeout (ERR_TIMEOUT)
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const { ProviderError, classifyError } = require('./lib/errors');
const { createProviderRunner } = require('./lib/bridge/run');
const { appendWithRotation } = require('./lib/telemetry');
const { makeRunId, emitReceipt } = require('./lib/receipt');
const { log: _log, startTimer: _startTimer, spinner } = require('./lib/terminal');
const { connectWithRetry: _connectWithRetry, doctorCheck: _doctorCheck } = require('./lib/cdp');

// ── Adapt shared modules to WebExtended naming conventions ──
const PREFIX = 'fallback';
const log = (msg) => _log(PREFIX, msg);
const startTimer = (label) => _startTimer(PREFIX, label);
const connectWithRetry = (cdpUrl, retries) => _connectWithRetry(chromium, cdpUrl, retries, log);
const doctorCheck = () => _doctorCheck(true, log);

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const CDP_URL = `http://127.0.0.1:${process.env.CDP_PORT || '9222'}`;
const DEFAULT_TOTAL_TIMEOUT = 600_000; // 10 min total across all providers
const DEFAULT_PROVIDER_TIMEOUT = 180_000; // 3 min per provider
const SKILL_DIR = path.join(path.dirname(__filename), '..'); // skill root (parent of scripts/) for telemetry

// ══════════════════════════════════════════════════════════════════════════════
// INVOCATION CONTEXT — per-run state isolated from module globals (P0-2)
// ══════════════════════════════════════════════════════════════════════════════

class InvocationContext {
    constructor() {
        // Execution receipt id — random per run, quoted by the calling agent
        // as proof the skill actually executed (see lib/receipt.js).
        this.runId = makeRunId();
        this.telemetry = {
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            provider_used: null,
            providers_tried: [],
            fallback_reasons: {},
            prompt_length_chars: 0,
            response_length_chars: 0,
            total_ms: 0,
            per_provider_ms: {},
            exit_code: 0,
        };
    }

    recordTelemetry(code) {
        this.telemetry.exit_code = code;
        const f = path.join(SKILL_DIR, 'data', 'fallback-telemetry.jsonl');
        appendWithRotation(f, JSON.stringify(this.telemetry) + '\n');
        // Execution receipt — single choke point covering every exit path
        // (success AND failure both prove "the skill ran"). STDERR on purpose:
        // this file's stdout is the raw-response machine contract consumed
        // verbatim by lib/execute.js / the Python SDK / the MCP server, and a
        // receipt line there would be embedded into the answer text.
        emitReceipt({
            skillDir: SKILL_DIR,
            skill: 'web-subagent',
            runId: this.runId,
            fields: {
                exit: code,
                provider_used: this.telemetry.provider_used,
                providers_tried: this.telemetry.providers_tried,
                total_ms: this.telemetry.total_ms,
            },
            stream: 'stderr',
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER CHAIN (priority order — first available wins)
// ══════════════════════════════════════════════════════════════════════════════

// Single source of truth: lib/providers/chain.js (also consumed by FreeSubAgent,
// which must NOT require this file — that would load playwright-core + 8 adapters).
const { PROVIDER_CHAIN } = require('./lib/providers/chain');

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER RUNNERS — factory-built from adapter configs in lib/providers/adapters/
// ══════════════════════════════════════════════════════════════════════════════
//   Gemini:  Pro Extended activation, bursty-output detection, 120s stop extension
//   ChatGPT: 3-tier input (clipboard → simulated paste → chunked keyboard)
//   Claude:  ProseMirror editor, Thinking placeholder filter
//   Qwen:    React SPA 3s delay, stop-btn detached (not hidden), model-name strip
//   Kimi:    New-session hook per call, .send-button-container disabled detection
//   MiniMax: TipTap/ProseMirror async mount 4s delay
//   MiMo:    DOM-traversal send button, React SPA 4s delay
//   DeepSeek: Standard pipeline, ds-markdown response

const PROVIDER_KEYS = ['gemini','chatgpt','claude','qwen','kimi','minimax','mimo','deepseek','doubao'];
const RUNNERS = Object.fromEntries(PROVIDER_KEYS.map(k => {
  const cfg = require(`./lib/providers/adapters/${k}`);
  // Gemini uses its own spinner-free runner; all others share the progress spinner
  return [k, createProviderRunner(k === 'gemini' ? cfg : { ...cfg, onProgress: spinner })];
}));

// ══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Resolve hostnames to check for an already-open provider tab. */
function getProviderHosts(provider) {
    if (provider.tabHosts) return provider.tabHosts;
    try { return [new URL(provider.url).hostname]; } catch { return []; }
}

/**
 * Find an already-open tab for a given provider (or null).
 *
 * BUGFIX (self-DoS): the previous isProviderTabOpen() + "skip if open" logic,
 * combined with keep-tabs-always-on, made sequential invocations block
 * themselves: run 1 succeeds on Gemini and keeps the tab → run 2 sees the tab,
 * classifies Gemini as "in use", and falls to ChatGPT → after a few runs all
 * 8 providers are permanently blocked by their own historical tabs (exit 9).
 *
 * Fix: REUSE the existing tab instead of skipping the provider. page.goto(url)
 * on the existing tab starts a fresh chat, so reuse is functionally identical
 * to a new tab and also stops tab accumulation. Concurrent-worker isolation is
 * the job of FreeSubAgent's file locks (and --single), not tab heuristics.
 */
function findProviderPage(context, provider) {
    const hosts = getProviderHosts(provider);
    return context.pages().find(p => {
        try {
            // HOSTNAME MATCH (was: substring over the FULL URL). A tab whose
            // path/query merely MENTIONS a provider domain — e.g. a Google
            // search for "gemini.google.com api" — matched the old
            // pu.includes(host) check, and the runner then page.goto()'d that
            // tab away: navigating an unrelated USER tab, exactly what the
            // keep-tabs policy forbids. Parse the URL and compare hostnames
            // (exact or subdomain) instead.
            const pageUrl = p.url();
            if (!pageUrl || pageUrl.startsWith('about:')) return false;
            const host = new URL(pageUrl).hostname;
            return hosts.some(h => host === h || host.endsWith('.' + h));
        } catch { return false; }
    }) || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// SMOKE TEST — verify at least one provider is reachable
// ══════════════════════════════════════════════════════════════════════════════

async function smokeTest(browser) {
    log('Running smoke test — checking provider reachability...');
    const context = browser.contexts()[0];

    for (const provider of PROVIDER_CHAIN) {
        let page;
        try {
            // An already-open tab is itself proof of reachability
            if (findProviderPage(context, provider)) {
                log(`  ${provider.name}: ✅ REACHABLE (existing tab)`);
                continue;
            }

            page = await context.newPage();
            await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            const url = page.url();

            const isAuth = provider.authDomains.some(d => url.includes(d));
            if (isAuth) {
                log(`  ${provider.name}: REACHABLE but needs login (${url.substring(0, 60)})`);
            } else {
                log(`  ${provider.name}: ✅ REACHABLE (${url.substring(0, 60)})`);
            }
        } catch (err) {
            log(`  ${provider.name}: ❌ UNREACHABLE — ${err.message}`);
        } finally {
            if (page && !page.isClosed()) {
                try { await page.close(); } catch (_) { }
            }
        }
    }

    log('Smoke test complete. Check output above for provider status.');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    const ctx = new InvocationContext(); // P0-2: per-invocation state isolation

    // --doctor
    if (args.includes('--doctor')) {
        return doctorCheck();
    }

    // Parse flags
    let customTimeout = DEFAULT_TOTAL_TIMEOUT;
    let providerName = null;
    let keepTabs = true; // Always keep tabs — never close user's browser

    // Timeouts are milliseconds. Values < 10000 are almost certainly seconds
    // typed by a human (--timeout=900) — normalize instead of silently giving
    // the whole chain a sub-second budget.
    const normalizeTimeout = (v) => {
        if (v < 10_000) {
            log(`WARN: --timeout=${v} interpreted as ${v}s (${v * 1000}ms). Timeouts are in milliseconds.`);
            return v * 1000;
        }
        return v;
    };

    // NOTE: --doctor is already handled above with an early return, so it never
    // reaches this loop. --smoke is detected separately via args.includes('--smoke')
    // further below. Neither should be pushed into `remaining` — previously both
    // were, which meant they'd get joined into the `prompt` string (harmless today
    // only because the smoke/doctor branches short-circuit before `prompt` is used).
    const remaining = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--smoke') {
            // handled via args.includes('--smoke') below — swallow, don't push
        } else if (a.startsWith('--timeout=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) customTimeout = normalizeTimeout(v);
        } else if (a === '--keep-tabs') {
            keepTabs = true;
        } else if (a === '--close' || a === '--close-browser') {
            // Only closes our own tab on success (page.close()) — never browser.close().
            keepTabs = false;
        } else if (a.startsWith('--only=')) {
            providerName = a.split('=')[1];
        } else if (a.startsWith('--locale=')) {
            // FEATURE GAP FIX: --locale was documented (lib/locales/gemini.js
            // header: "CLI 传 --locale=xx_XX") and passed by the Python SDK
            // (session.py appends --locale=<key> whenever locale= is given),
            // but this parser had no branch for it — unknown --flags are
            // silently dropped, so the Python `locale` parameter has been a
            // no-op since it shipped. Wire it to the Gemini locale profiles.
            const locKey = a.split('=')[1];
            const applied = require('./lib/locales/gemini').setLocale(locKey);
            if (applied === 'fuzzy' && locKey) {
                log(`WARN: unknown --locale "${locKey}" — falling back to auto-detect/fuzzy matching`);
            } else {
                log(`Gemini UI locale forced to ${applied}`);
            }
        } else if (!a.startsWith('--')) {
            remaining.push(a);
        }
    }

    // Read prompt
    let prompt = remaining.join(' ').trim();
    if (!prompt && !args.includes('--smoke') && !process.stdin.isTTY) {
        // Try stdin — but only when something is actually piped in.
        // On an interactive TTY this used to hang forever instead of printing usage.
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        prompt = chunks.join('').trim();
    }
    if (!prompt && !args.includes('--smoke')) {
        if (args.includes('--help') || args.includes('-h')) {
            console.error('Usage: node index.js --only=NAME [--timeout=MS] [--close] [--locale=xx_XX] [--smoke] [--doctor] "Your prompt"');
            console.error('       echo "prompt" | node index.js --only=NAME [flags]');
            process.exit(0);
        }
        if (!providerName) {
            console.error('Missing --only=NAME. Specify which provider to use.');
            console.error('Usage: node index.js --only=NAME [--timeout=MS] [--close] "Your prompt"');
            process.exit(1);
        }
        console.error('Usage: node index.js --only=NAME [--timeout=MS] [--close] [--locale=xx_XX] [--smoke] [--doctor] "Your prompt"');
        console.error('       echo "prompt" | node index.js --only=NAME [flags]');
        process.exit(1);
    }

    ctx.telemetry.prompt_length_chars = prompt.length;

    // Connect to Chrome
    let browser;
    try {
        browser = await connectWithRetry(CDP_URL);
    } catch (err) {
        log(`FATAL: Cannot connect to Chrome CDP — ${err.message}`);
        log(`Ensure Chrome debug is running: bash "${path.join(__dirname, 'start-chrome-debug.sh')}"`);
        ctx.recordTelemetry(1);
        process.exit(1);
    }

    try {
        // --smoke
        if (args.includes('--smoke')) {
            await smokeTest(browser);
            process.exit(0);
        }

        // Run single provider
        let resolvedProvider = PROVIDER_CHAIN.find(p => p.key === providerName || p.name.toLowerCase() === providerName);
        if (!resolvedProvider && providerName) {
            // Substring fallback for human convenience
            resolvedProvider = PROVIDER_CHAIN.find(p =>
                p.key.includes(providerName) || p.name.toLowerCase().includes(providerName)
            );
            if (resolvedProvider) {
                log(`WARN: "${providerName}" matched "${resolvedProvider.name}" (${resolvedProvider.key}). Use exact name to avoid ambiguity.`);
            }
        }
        if (!resolvedProvider) {
            log(`ERROR: unknown provider "${providerName || '(none)'}". Valid: ${PROVIDER_CHAIN.map(p => p.key).join(', ')}`);
            ctx.recordTelemetry(4);
            process.exit(4);
        }
        const provStart = Date.now();
        const context = browser.contexts()[0];
        if (!context) throw new Error('No active browser context.');

        let page;
        let createdPage = false;
        page = findProviderPage(context, resolvedProvider);
        if (page) {
            log(`  ${resolvedProvider.name}: reusing existing tab`);
        } else {
            page = await context.newPage();
            createdPage = true;
        }
        try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (_) { }

        const perProvTimeout = customTimeout;
        log(`\n▶ Provider: ${resolvedProvider.name} (${Math.round(perProvTimeout / 1000)}s budget)`);
        const timer = startTimer(`${resolvedProvider.name}`);

        const runner = RUNNERS[resolvedProvider.key];
        const result = runner
            ? await runner(page, prompt, perProvTimeout, ctx)
            : classifyError(new Error(`Unknown provider: ${resolvedProvider.key}`), 'navigate', resolvedProvider.key);
        timer.stop();

        if (!result.success) {
            if (createdPage && page && !page.isClosed()) {
                try { await page.close(); } catch (_) { }
            }
            const reason = result.reason || 'error';
            log(`✗ ${resolvedProvider.name}: FAILED — ${reason}`);
            if (result.reason === 'auth' && resolvedProvider.recoveryHint) {
                log(`  ↳ fix: ${resolvedProvider.recoveryHint}`);
            }

            ctx.telemetry.providers_tried = [resolvedProvider.key];
            ctx.telemetry.fallback_reasons = { [resolvedProvider.key]: { reason, error_details: result.error_details || null } };
            ctx.telemetry.total_ms = Date.now() - provStart;

            if (reason === 'auth') { ctx.recordTelemetry(2); process.exit(2); }
            if (reason === 'quota' || reason === 'rate') { ctx.recordTelemetry(5); process.exit(5); }
            if (reason === 'safety') { ctx.recordTelemetry(3); process.exit(3); }
            if (reason === 'timeout') { ctx.recordTelemetry(10); process.exit(10); }
            ctx.recordTelemetry(9);
            process.exit(9);
        }

        // Success
        if (createdPage && page && !page.isClosed() && !keepTabs) {
            try { await page.close(); } catch (_) { }
        }

        ctx.telemetry.provider_used = resolvedProvider.name;
        ctx.telemetry.providers_tried = [resolvedProvider.key];
        ctx.telemetry.total_ms = Date.now() - provStart;

        log(`\n✓ ${resolvedProvider.name}: USED (${result.response.length} chars, ${ctx.telemetry.total_ms}ms total)`);
        ctx.recordTelemetry(0);
        process.stdout.write(result.response + '\n', () => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
        return;

    } catch (err) {
        log(`FATAL: ${err.message}`);
        ctx.recordTelemetry(4);
        process.exit(4);
    } finally {
        // POLICY: NEVER call browser.close() — this is a CDP guest session.
        // Closing the browser destroys ALL the user's tabs, not just ours.
    }
}

if (require.main === module) {
    main().catch(e => {
        process.stderr.write(`[fallback] unhandled: ${e.message}\n`);
        process.exit(4);
    });
}

module.exports = { PROVIDER_CHAIN };

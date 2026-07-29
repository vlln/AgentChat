/**
 * Adapter contract test — validates every provider adapter satisfies the
 * bridge/contract.js interface at load time.
 *
 * Covers what assertAdapter enforces PLUS method-signature sanity:
 *   - required data fields present (key/url/authDomains/editorSelectors/responseSelectors)
 *   - optional behavioral methods, if present, are functions
 *   - data hooks (stillGeneratingCheck/postResponseHook/validateEditor), if present, are functions
 *   - no legacy field names remain (preInputHook/customSend — Phase 2 migrated them)
 *
 * Does NOT exercise live DOM — that needs a running Chrome session. This is
 * a load-time contract guard: a malformed adapter fails here, not mid-call.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ADAPTERS_DIR = path.join(__dirname, '..', 'skills', 'web-subagent', 'scripts', 'lib', 'providers', 'adapters');
const { assertAdapter, REQUIRED } = require('../skills/web-subagent/scripts/lib/bridge/contract');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, detail); }
};

const OPTIONAL_METHODS = ['prepare', 'findEditor', 'input', 'send'];
const OPTIONAL_DATA_HOOKS = ['stillGeneratingCheck', 'postResponseHook', 'validateEditor'];
const LEGACY_FIELDS = ['preInputHook', 'customSend'];

const keys = fs.readdirSync(ADAPTERS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .sort();

assert('adapter directory has files', keys.length > 0, `found ${keys.length}`);

for (const key of keys) {
    const adapter = require(path.join(ADAPTERS_DIR, `${key}.js`));

    // assertAdapter throws on missing required fields; catch to report per-adapter.
    try {
        assertAdapter(adapter);
        assert(`${key}: required data fields present`, true);
    } catch (e) {
        assert(`${key}: required data fields present`, false, e.message);
        continue;
    }

    assert(`${key}: .key matches filename`, adapter.key === key, `got "${adapter.key}"`);
    assert(`${key}: .url is a URL`, /^https?:\/\//.test(adapter.url || ''), adapter.url);

    for (const m of OPTIONAL_METHODS) {
        if (adapter[m] !== undefined) {
            assert(`${key}: ${m} is a function`, typeof adapter[m] === 'function', `got ${typeof adapter[m]}`);
        }
    }
    for (const h of OPTIONAL_DATA_HOOKS) {
        if (adapter[h] !== undefined) {
            assert(`${key}: ${h} hook is a function`, typeof adapter[h] === 'function', `got ${typeof adapter[h]}`);
        }
    }
    for (const legacy of LEGACY_FIELDS) {
        assert(`${key}: no legacy field ${legacy}`, !(legacy in adapter), 'Phase 2 should have migrated it');
    }

    // send coverage: either sendSelectors (possibly empty for fallback-only),
    // sendFallback, or a send() override.
    const hasSend = Array.isArray(adapter.sendSelectors)
        || typeof adapter.sendFallback === 'string'
        || typeof adapter.send === 'function';
    assert(`${key}: has some send strategy`, hasSend);
}

// Every REQUIRED field should be the documented set.
assert('REQUIRED fields are the documented 5',
    REQUIRED.length === 5
        && REQUIRED.includes('key') && REQUIRED.includes('url')
        && REQUIRED.includes('authDomains') && REQUIRED.includes('editorSelectors')
        && REQUIRED.includes('responseSelectors'),
    JSON.stringify(REQUIRED));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

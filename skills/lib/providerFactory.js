/**
 * providerFactory.js — COMPATIBILITY SHIM (Phase 1 refactor).
 *
 * The implementation has been split into ./bridge/{run,dom,completion,overlays,
 * extract}.js. This file re-exports every former symbol so existing consumers
 * (the 9 adapters in providers/adapters/, AgentChat-WebExtended, and the test
 * suite) keep working unchanged. Phase 2 (adapter interface migration) will
 * delete this shim once adapters require the bridge modules directly.
 *
 * Nothing here is implementation — it is a thin re-export layer.
 */
'use strict';

const run = require('./bridge/run');
const dom = require('./bridge/dom');
const completion = require('./bridge/completion');
const overlays = require('./bridge/overlays');
const extract = require('./bridge/extract');

module.exports = {
    createProviderRunner: run.createProviderRunner,
    INSERT_TEXT_LIMIT: dom.INSERT_TEXT_LIMIT,
    appendWithRotation: run.appendWithRotation,
    findEditableElement: dom.findEditableElement,
    heuristicFindEditor: dom.heuristicFindEditor,
    verifySendEffect: dom.verifySendEffect,
    dumpEditorDiagnostics: dom.dumpEditorDiagnostics,
    dumpResponseDiagnostics: dom.dumpResponseDiagnostics,
    inputViaClipboard: dom.inputViaClipboard,
    inputViaSimulatedPaste: dom.inputViaSimulatedPaste,
    inputViaKeyboard: dom.inputViaKeyboard,
    clearEditor: dom.clearEditor,
    clickSend: dom.clickSend,
    waitForCompletion: completion.waitForCompletion,
    extractResponse: extract.extractResponse,
    COMMON_CN_QUOTA_PATTERNS: run.COMMON_CN_QUOTA_PATTERNS,
    COMMON_DISMISS_PATTERNS: overlays.COMMON_DISMISS_PATTERNS,
};

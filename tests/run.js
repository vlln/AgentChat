#!/usr/bin/env node
/**
 * Test runner — spawns each test file as a child process so that
 * process.exit() in one file does not kill the runner.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testsDir = path.join(__dirname);
const files = fs.readdirSync(testsDir)
    .filter(f => f.endsWith('.test.js'))
    .sort();

let totalPass = 0;
let totalFail = 0;

for (const file of files) {
    const filePath = path.join(testsDir, file);
    const result = spawnSync(process.execPath, [filePath], {
        stdio: 'inherit',
        timeout: 30_000,
    });
    if (result.status !== 0) {
        totalFail++;
    } else {
        totalPass++;
    }
}

console.log(`\n${totalPass} test files passed, ${totalFail} failed`);
process.exit(totalFail > 0 ? 1 : 0);
#!/usr/bin/env node
/**
 * Runs every *-harness.mjs in this directory and exits non-zero if any fails.
 *
 *   node scripts/tests/run-all.mjs
 *
 * There is no test runner in this repo (no package.json, no framework) — see
 * README.md in this directory. This is a plain sequential spawner so the whole
 * suite is one command; each harness is still runnable on its own.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const harnesses = readdirSync(HERE).filter((f) => f.endsWith('-harness.mjs')).sort();

if (!harnesses.length) {
  console.error('No *-harness.mjs files found in ' + HERE);
  process.exit(1);
}

let failed = [];
for (const h of harnesses) {
  console.log('\n' + '═'.repeat(70) + '\n  ' + h + '\n' + '═'.repeat(70));
  const r = spawnSync(process.execPath, [path.join(HERE, h)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(h);
}

console.log('\n' + '═'.repeat(70));
if (failed.length) {
  console.log('FAILED: ' + failed.join(', '));
  console.log(harnesses.length - failed.length + '/' + harnesses.length + ' harnesses passed');
  process.exit(1);
}
console.log('All ' + harnesses.length + ' harnesses passed');

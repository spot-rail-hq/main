#!/usr/bin/env node
/**
 * Pre-normalises the raw Darwin fixtures in fixtures/darwin-departures/ into
 * fixtures/darwin-departures/normalized/, using the REAL, unmodified
 * normalizeBoard() from api/_lib/darwin-normalize.mjs.
 *
 * Why this exists: /api/darwin-departures.js normalises server-side, so
 * departures.html's renderer only ever consumes the normalised shape — never
 * the raw Darwin JSON these fixtures were captured as. Pre-normalising here
 * (once, offline) means departures.html's fixture-preview mode (?fixture=)
 * can fetch a plain static JSON file and render it directly, with zero
 * duplicated normaliser logic living in the browser to drift out of sync.
 *
 *   node scripts/build-darwin-fixture-previews.mjs
 *
 * Re-run this if a new raw fixture is added to fixtures/darwin-departures/
 * and needs a preview counterpart.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeBoard } from '../api/_lib/darwin-normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SRC_DIR = path.join(REPO_ROOT, 'fixtures/darwin-departures');
const OUT_DIR = path.join(SRC_DIR, 'normalized');

// Only raw board-shape fixtures (top-level `trainServices`, however absent
// when zero-match) go through normalizeBoard() — the Service Details and
// Next Departures Board fixtures have a different shape entirely and aren't
// what departures.html's board renderer consumes.
const BOARD_FIXTURES = [
  'bhm-board.json',
  'lst-board.json',
  'cancelled-lds.json',
  'delayed-no-estimate-bri.json',
  'filter-to-loo-zero-match.json',
  'filter-to-eus-match.json',
];

mkdirSync(OUT_DIR, { recursive: true });

let built = 0;
for (const file of BOARD_FIXTURES) {
  const srcPath = path.join(SRC_DIR, file);
  let raw;
  try {
    raw = JSON.parse(readFileSync(srcPath, 'utf8'));
  } catch (e) {
    console.log(`skip ${file}: ${e.message}`);
    continue;
  }
  const normalized = normalizeBoard(raw);
  writeFileSync(path.join(OUT_DIR, file), JSON.stringify(normalized, null, 2));
  console.log(`built normalized/${file} (${normalized.services.length} services)`);
  built++;
}

console.log(`\n${built}/${BOARD_FIXTURES.length} fixture previews built in ${path.relative(REPO_ROOT, OUT_DIR)}/`);

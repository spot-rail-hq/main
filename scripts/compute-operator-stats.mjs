#!/usr/bin/env node
/**
 * scripts/compute-operator-stats.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Computes operators-content.json's `stations_operated` (a plain count) by
 * counting, for each operator, how many stations-content.json entries list
 * that operator's canonical `name` or one of its `aliases` in their
 * `operators` array. No network calls — pure aggregation over data already
 * populated by fetch-osm-facts.mjs's route-relation membership checking, so
 * the count reflects the same verified-stop-membership standard as the
 * station-level data it's derived from, not a fresh proximity guess.
 *
 *   node scripts/compute-operator-stats.mjs
 *
 * Sole writer of operators-content.json's `stations_operated` field — see
 * fetch-osm-facts.mjs and fetch-wikipedia-facts.mjs headers, neither of
 * which write it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');
const OPERATORS_PATH = path.join(ROOT, 'operators-content.json');

const stations = JSON.parse(readFileSync(STATIONS_PATH, 'utf8'));
const operators = JSON.parse(readFileSync(OPERATORS_PATH, 'utf8'));

const counts = {};
for (const key of Object.keys(operators)) {
  if (key === '_notes') continue;
  const entry = operators[key];
  const names = new Set([entry.name, ...(entry.aliases || [])].filter(Boolean));
  let count = 0;
  for (const crs of Object.keys(stations)) {
    if (crs === '_notes') continue;
    const ops = stations[crs].operators || [];
    if (ops.some((op) => names.has(op))) count++;
  }
  counts[key] = count;
  // A real 0 here means "no OSM route relation for this operator passed
  // stop-membership verification at any station" — a data gap, not a true
  // zero-coverage operator. Writing literal 0 would render a false
  // "Stations operated: 0" in the UI, so the field is left unset instead
  // and flagged below for manual follow-up.
  if (count > 0) operators[key].stations_operated = count;
  else delete operators[key].stations_operated;
}

writeFileSync(OPERATORS_PATH, JSON.stringify(operators, null, 2) + '\n');
console.log('stations_operated computed for', Object.keys(counts).length, 'operators:');
for (const [key, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(' ', key, operators[key].name, '—', count);
}
const gaps = Object.entries(counts).filter(([, c]) => c === 0);
if (gaps.length) {
  console.log('\nFLAGGED — 0 verified stations, field left unset (not written as literal 0):');
  for (const [key] of gaps) console.log(' ', key, operators[key].name);
}

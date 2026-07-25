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
 * which write it. EXCEPT for entries flagged `stations_operated_manual`,
 * which this script deliberately never touches — see the flag's own
 * comment in the loop below for why (tube lines / tram networks whose
 * stops aren't in stations-content.json at all).
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
const skipped = [];
for (const key of Object.keys(operators)) {
  if (key === '_notes') continue;
  const entry = operators[key];
  // OPT-OUT: `stations_operated_manual` marks an entry whose stops are not
  // in stations-content.json AT ALL and never will be — that file is the
  // National Rail CRS/NaPTAN station database, so a London Underground
  // line's or a tram network's own stops simply aren't in it. Counting
  // those the normal way always yields 0, which this script would then
  // "correctly" treat as a data gap and DELETE the curated Wikipedia-
  // sourced figure (confirmed 2026-07-25: every one of the 11 tube lines
  // added in the 2026-07-23 pass would have been silently zeroed by the
  // next run of this script). That's different from the genuine gaps the
  // count > 0 check below handles (HT/HX/XR — real National Rail
  // operators whose stations ARE in the file, just not yet matched by a
  // stop-verified OSM route relation), so it needs its own explicit flag
  // rather than a looser heuristic. Skipped entries are neither counted
  // nor written; their stations_operated stays exactly as curated.
  if (entry.stations_operated_manual) {
    skipped.push(key);
    continue;
  }
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
if (skipped.length) {
  console.log('\nSKIPPED — stations_operated_manual set, curated figure left untouched:');
  for (const key of skipped) console.log(' ', key, operators[key].name, '—', operators[key].stations_operated);
}

#!/usr/bin/env node
/**
 * scripts/build-historical-operator-coverage.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Builds data/historical-operator-coverage.json — the MAP-COVERAGE RANGE for
 * every operator that actually appears in the historical line tiles.
 *
 *   node scripts/build-historical-operator-coverage.mjs
 *
 * ─── WHY THIS IS PRECOMPUTED, NOT QUERIED PER PANEL-OPEN ──────────────────
 * The slider-follow rules need, for a given operator, the first year its
 * network is actually visible on the map. Deriving that at panel-open time
 * would mean querying the vector tiles for every feature attributed to that
 * operator — but querySourceFeatures() only sees tiles CURRENTLY LOADED for
 * the CURRENT viewport, so the answer would silently change depending on
 * where the user happened to be panned and how far out they were zoomed. An
 * operator whose network is off-screen would return no features and the rule
 * would fall through to "no span determined". That is not a performance
 * problem, it is a correctness one — the precompute is the only way to get a
 * stable answer.
 *
 * Cost: one pass over the same GeoJSON the tiles were built from, at build
 * time, producing a file small enough to load with the other content JSON.
 *
 * ─── THE THREE DATES (do not conflate) ────────────────────────────────────
 *   FOUNDED               incorporation. NOT when the network existed —
 *                         GWR was incorporated 1833, its first line opened
 *                         1838. Never used for slider movement: it can land
 *                         the user on an empty map. Lives in the hand-curated
 *                         data/historical-operators.json.
 *   DATES OF OPERATION    the editorial/historical span shown in the panel.
 *                         Also hand-curated.
 *   MAP-COVERAGE RANGE    THIS FILE. min(start_year) / max(end_year) across
 *                         every line feature attributed to the operator in
 *                         our own tiles, CLAMPED to the band that attribution
 *                         is valid within (see CO_FIELDS). The only range that
 *                         guarantees the user sees something when the slider
 *                         moves there.
 *
 * ─── FIELD OWNERSHIP ──────────────────────────────────────────────────────
 * Sole writer of data/historical-operator-coverage.json. Reads
 * tile-generation/historical-lines.geojson (the exact input the tiles were
 * built from, so coverage cannot disagree with what renders). Never writes
 * data/historical-operators.json — that file is hand-curated content and this
 * one is derived geometry facts, kept separate on the same field-ownership
 * principle as the rest of the repo's build scripts.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IN_LINES = path.join(ROOT, 'tile-generation', 'historical-lines.geojson');
const OUT_PATH = path.join(ROOT, 'data', 'historical-operator-coverage.json');

// The tile properties an operator name can appear in, each with the era band
// that attribution is only valid WITHIN. co_modern is omitted deliberately —
// it is null on every OHM feature (the modern band renders from
// line-segments.json instead), so scanning it would always be empty.
//
// CLAMPING TO THE BAND IS NOT COSMETIC — it is what makes this file usable.
// A feature carries co_br if it was alive at any point in 1948-1993, but its
// own start_year is when the LINE was built, which can be a century earlier.
// Measured on the first unclamped run: "British Railways" came out as
// 1700-open (an 18th-century wagonway that later became BR track) and
// "London, Midland and Scottish Railway" as 1810-open, against real spans of
// 1948-1994 and 1923-1947. Feeding those to the slider-follow rules would
// send a user opening the BR panel to 1700 — a blank map, 248 years before
// BR existed. Clamping each contribution to its own band gives the range
// where that operator's network is actually on screen, which is the whole
// point of the field.
const CO_FIELDS = [
  { field: 'co_pre1923', from: 0, to: 1922 },
  { field: 'co_big4', from: 1923, to: 1947 },
  { field: 'co_br', from: 1948, to: 1993 },
];

function main() {
  const geo = JSON.parse(readFileSync(IN_LINES, 'utf8'));
  const coverage = {};

  for (const f of geo.features) {
    const p = f.properties;
    const start = p.start_year;
    const end = p.end_year === undefined ? null : p.end_year;
    if (start === undefined || start === null) continue;

    for (const { field, from, to } of CO_FIELDS) {
      const name = p[field];
      if (!name) continue;
      // Clamp this feature's own lifespan into the band the attribution is
      // valid within. An open-ended feature (end === null) is treated as
      // running to the band's upper bound, not to today.
      const clampedStart = Math.max(start, from);
      const clampedEnd = Math.min(end === null ? to : end, to);
      if (clampedEnd < clampedStart) continue; // no overlap with the band at all

      const rec = (coverage[name] = coverage[name] || {
        name,
        fields: {},
        first_year: clampedStart,
        last_year: clampedEnd,
        feature_count: 0,
      });
      rec.fields[field] = (rec.fields[field] || 0) + 1;
      rec.feature_count++;
      if (clampedStart < rec.first_year) rec.first_year = clampedStart;
      if (clampedEnd > rec.last_year) rec.last_year = clampedEnd;
    }
  }

  const entries = Object.values(coverage).sort((a, b) => b.feature_count - a.feature_count);

  const output = {
    generated_at: new Date().toISOString(),
    _notes:
      'MAP-COVERAGE RANGE per operator, derived from tile-generation/historical-lines.geojson — ' +
      'the exact input the historical tiles were built from, so this cannot disagree with what ' +
      'actually renders. Built by scripts/build-historical-operator-coverage.mjs (sole writer). ' +
      'Keyed by the LITERAL string as it appears in the tiles\' co_pre1923 / co_big4 / co_br ' +
      'properties, NOT by a slug — this is the join key a map feature gives you, and translating ' +
      'it to a slug is data/historical-operators.json\'s job via its own `tile_matches` array. ' +
      'first_year / last_year are the span to use for slider movement and for the active-span ' +
      'indicator. Both are CLAMPED to the era band the attribution is valid within, which is what ' +
      'makes them usable: unclamped, British Railways computed as 1700 (an 18th-century wagonway ' +
      'that later became BR track) and would have sent a user opening the BR panel to a blank map ' +
      '248 years before BR existed. A name appearing in more than one band spans both — Great ' +
      'Western Railway is 1825-1947 because it is both a pre-grouping builder name and a 1923 ' +
      'group. DO NOT use a company\'s founding year for slider movement — see this script\'s ' +
      'header on why the three dates are not interchangeable.',
    coverage: Object.fromEntries(entries.map((e) => [e.name, e])),
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');

  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`  ${entries.length} distinct operator names with map coverage\n`);
  console.log('  top 12 by attributed features:');
  for (const e of entries.slice(0, 12)) {
    const span = `${e.first_year}–${e.last_year}`;
    console.log(`    ${String(e.feature_count).padStart(6)}  ${span.padEnd(12)}  ${e.name}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

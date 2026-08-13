#!/usr/bin/env node
/**
 * scripts/build-historical-search-index.mjs — flat search index for History
 * mode's Station tab, built from scripts/output/historical-stations.geojson.
 *
 * WHY A SEPARATE ARTIFACT, NOT DERIVED AT RUNTIME. History mode never fetches
 * the raw geojson in the browser — only historical.pmtiles, a spatially-tiled
 * binary source. Deriving a search index from loaded tiles would only ever
 * see whatever's in the current viewport (the same defect
 * coverageForHistoricalOperator() in map.html was precomputed at build time
 * to avoid — querySourceFeatures() answers change with where the user has
 * panned). So this is prebuilt, once, at build time, same as
 * data/routing-graph.json.
 *
 * SHAPE, AND WHY. selectHistoricalStation(props, coords) in map.html reads
 * periods as FLATTENED p1_start/p1_end...p5_start/p5_end scalars (not the
 * nested `periods` array the raw geojson carries) — that's what
 * historical.pmtiles' tippecanoe output produces, and it's the only shape
 * the slider-follow logic actually reads. So this index flattens the same
 * way, so a search-index entry can be handed to selectHistoricalStation()
 * exactly like a real map-click's tile properties, no branching needed at
 * the call site.
 *
 * An OPEN period's end year is OMITTED, not written as null — tippecanoe
 * drops null-valued properties from the tile, and selectHistoricalStation()
 * detects "still open" by checking `props['p'+i+'_end'] === undefined`.
 * Writing null instead of omitting would silently break that check (null !==
 * undefined), so every open-period end here is a genuinely absent key.
 *
 * `id` is wikidata_qid — the only field in the source data that is both
 * present on all 8,884 features and 100% unique (verified). There is no
 * other stable id anywhere in the source.
 *
 * `name` is copied byte-for-byte from the source — parentheticals kept, per
 * decision (they're the only disambiguation this dataset has, e.g. "Newport
 * railway station (Essex)"). `name_lc` is a plain lowercase of the same
 * string, no other normalisation — matches searchStations()'s own
 * s.name.toLowerCase() convention in map.html, nothing stripped.
 *
 * Deliberately minimal: no crs, no wikipedia_title, no source/license/
 * precision fields, no geometry beyond the one coordinate pair. Everything
 * else the detail panel needs it already gets from the map-click path;
 * this index only has to get a result onto the map and the slider snapped.
 *
 * Usage: node scripts/build-historical-search-index.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'scripts', 'output', 'historical-stations.geojson');
const OUT_PATH = path.join(ROOT, 'data', 'historical-station-search-index.json');
const MAX_PERIODS = 5; // matches selectHistoricalStation()'s own p1..p5 loop bound in map.html

const src = JSON.parse(readFileSync(SRC_PATH, 'utf8'));

const seenIds = new Set();
let duplicateIds = 0;
let truncatedPeriods = 0;

const index = src.features.map((f) => {
  const p = f.properties;
  const id = p.wikidata_qid;
  if (seenIds.has(id)) duplicateIds++;
  seenIds.add(id);

  const periods = p.periods || [];
  if (periods.length > MAX_PERIODS) truncatedPeriods++;

  // Rounded to 5dp (~1.1m) — a marker/flyTo target needs nowhere near the
  // source's mixed 4-6dp precision (NaPTAN vs Wikidata coordinates), and this
  // is a real size saving across 8,884 entries.
  const entry = {
    id,
    name: p.name,
    name_lc: p.name.toLowerCase(),
    coords: f.geometry.coordinates.map((c) => Math.round(c * 100000) / 100000),
  };
  periods.slice(0, MAX_PERIODS).forEach((period, i) => {
    entry['p' + (i + 1) + '_start'] = period.start_year;
    // Omit, never null — see header note.
    if (period.end_year !== null && period.end_year !== undefined) {
      entry['p' + (i + 1) + '_end'] = period.end_year;
    }
  });
  return entry;
});

if (duplicateIds) {
  console.warn(`WARNING: ${duplicateIds} duplicate wikidata_qid values found — id is not actually unique in this source run.`);
}
if (truncatedPeriods) {
  console.warn(`WARNING: ${truncatedPeriods} feature(s) had more than ${MAX_PERIODS} periods and were truncated.`);
}

const json = JSON.stringify(index);
writeFileSync(OUT_PATH, json);

const rawBytes = Buffer.byteLength(json);
const gzipBytes = gzipSync(json).length;
console.log(`Written ${index.length} entries to ${OUT_PATH}`);
console.log(`Size: ${(rawBytes / 1024).toFixed(1)} KB raw, ${(gzipBytes / 1024).toFixed(1)} KB gzipped`);

#!/usr/bin/env node
/**
 * scripts/build-historical-tiles-geojson.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Prepares the two historical GeoJSON layers for tippecanoe — sibling to
 * scripts/build-operator-tiles-geojson.mjs, same role in the historical
 * pipeline as that one has in the operator-colour pipeline. See
 * tile-generation/build-historical-tiles.sh for the full sequence.
 *
 *   node scripts/build-historical-tiles-geojson.mjs
 *
 * Reads   scripts/output/historical-lines.geojson
 *         scripts/output/historical-stations.geojson
 * Writes  tile-generation/historical-lines.geojson
 *         tile-generation/historical-stations.geojson
 *
 * ─── WHY THIS STEP EXISTS AT ALL: MVT CANNOT HOLD AN ARRAY ────────────────
 * The locked station schema is `periods: [{start_year, end_year}, …]`, which
 * is correct for the DATA — 965 stations closed and later reopened, and a
 * single date pair cannot represent that. But Mapbox Vector Tile properties
 * are scalars only. Verified live against tippecanoe 2.79.0: it does not drop
 * a nested array, it JSON-STRINGIFIES it, so `periods` arrives client-side as
 * the string '[{"start_year":1850,…}]'.
 *
 * That is fine for a popup (JSON.parse it) and useless for a filter — a
 * MapLibre expression cannot look inside a string. Since the whole feature is
 * a slider that filters by year, the periods have to ALSO exist as scalars.
 * So each station carries both:
 *
 *   periods      the JSON string (tippecanoe's own encoding) — for popups
 *   p1_start … pN_end   flattened scalar pairs — for the filter expression
 *   start_year / end_year   the outer span — for cheap coarse filtering
 *
 * MAX_PERIODS is derived from the data (currently 5) rather than assumed, and
 * the script FAILS if a station exceeds it, because silently truncating a
 * period would delete real history — a station would blink out of existence
 * for a decade it was demonstrably open.
 *
 * The filter Phase 2B needs, given `year` as the slider position:
 *   ["any",
 *     ["all", ["<=", ["get","p1_start"], year],
 *             ["any", ["!", ["has","p1_end"]], [">=", ["get","p1_end"], year]]],
 *     … same for p2..pN, each guarded by ["has","pN_start"] …
 *   ]
 *
 * ─── LINES NEED NO FLATTENING ─────────────────────────────────────────────
 * Line features are already all-scalar (start_year, end_year, the four co_*
 * fields, license, source) so they pass through unchanged apart from dropping
 * nulls — see stripNulls below.
 *
 * ─── FIELD OWNERSHIP ──────────────────────────────────────────────────────
 * Sole writer of tile-generation/historical-lines.geojson and
 * tile-generation/historical-stations.geojson. Reads only scripts/output/.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IN_LINES = path.join(ROOT, 'scripts', 'output', 'historical-lines.geojson');
const IN_STATIONS = path.join(ROOT, 'scripts', 'output', 'historical-stations.geojson');
const TILE_DIR = path.join(ROOT, 'tile-generation');
const OUT_LINES = path.join(TILE_DIR, 'historical-lines.geojson');
const OUT_STATIONS = path.join(TILE_DIR, 'historical-stations.geojson');

// Hard ceiling on flattened period slots. Exceeding it is a build failure,
// never a truncation — see the header.
const MAX_PERIODS = 6;

// A null property costs tile bytes and tells the client nothing that
// ["has", …] doesn't. MapLibre's ["has"] is the idiomatic null test in a
// filter anyway, so nulls are dropped rather than encoded.
function stripNulls(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function writeFeatures(file, features) {
  writeFileSync(
    file,
    '{"type":"FeatureCollection","features":[\n' +
      features.map((f) => JSON.stringify(f)).join(',\n') +
      '\n]}\n',
  );
}

function main() {
  mkdirSync(TILE_DIR, { recursive: true });

  // ── Lines ──
  const lines = JSON.parse(readFileSync(IN_LINES, 'utf8'));
  const lineFeatures = lines.features.map((f) => ({
    type: 'Feature',
    properties: stripNulls(f.properties),
    geometry: f.geometry,
  }));
  writeFeatures(OUT_LINES, lineFeatures);

  const coCounts = { co_pre1923: 0, co_big4: 0, co_br: 0, co_modern: 0 };
  for (const f of lineFeatures) for (const k of Object.keys(coCounts)) if (f.properties[k]) coCounts[k]++;

  // ── Stations ──
  const stations = JSON.parse(readFileSync(IN_STATIONS, 'utf8'));
  let maxSeen = 0;
  const stationFeatures = stations.features.map((f) => {
    const periods = f.properties.periods || [];
    maxSeen = Math.max(maxSeen, periods.length);
    if (periods.length > MAX_PERIODS) {
      throw new Error(
        `${f.properties.wikipedia_title} has ${periods.length} periods, above MAX_PERIODS=${MAX_PERIODS}. ` +
          `Raise MAX_PERIODS and rebuild — do NOT let it truncate, that would silently delete a real ` +
          `open period and make the station vanish for years it was demonstrably running.`,
      );
    }
    const flat = {};
    periods.forEach((p, i) => {
      flat[`p${i + 1}_start`] = p.start_year;
      if (p.end_year !== null && p.end_year !== undefined) flat[`p${i + 1}_end`] = p.end_year;
    });
    const props = stripNulls({ ...f.properties, ...flat });
    // Keep the array too — tippecanoe turns it into a JSON string, which is
    // exactly what a popup wants and what a filter cannot use.
    props.periods = periods;
    return { type: 'Feature', properties: props, geometry: f.geometry };
  });
  writeFeatures(OUT_STATIONS, stationFeatures);

  console.log(`Wrote ${path.relative(ROOT, OUT_LINES)}`);
  console.log(`  ${lineFeatures.length} line features`);
  console.log(`  populated: ${JSON.stringify(coCounts)}`);
  console.log(`Wrote ${path.relative(ROOT, OUT_STATIONS)}`);
  console.log(`  ${stationFeatures.length} station features`);
  console.log(`  max periods on one station: ${maxSeen} (ceiling ${MAX_PERIODS})`);
  const multi = stationFeatures.filter((f) => (f.properties.periods || []).length > 1).length;
  console.log(`  multi-period stations: ${multi}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

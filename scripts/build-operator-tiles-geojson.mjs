#!/usr/bin/env node
/**
 * scripts/build-operator-tiles-geojson.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Converts scripts/output/line-segments.json (Phase 2's segment graph) into
 * a plain GeoJSON FeatureCollection for tippecanoe to tile — see
 * tile-generation/build-operator-tiles.sh for the full pipeline and why
 * tippecanoe (not tilemaker) is the right tool for this specific layer.
 *
 * MVT/vector-tile feature properties are scalar only (string/number/
 * boolean) — no native array type — so a segment's `operators` array is
 * encoded as a comma-joined string (e.g. "GC,GR,LD,NT,TP,XC", or just "GR"
 * when there's one). `operator_count` is included as a separate numeric
 * property so Phase 5's zoom-adaptive bundling (per the plan) doesn't need
 * to re-split the string just to count.
 *
 * Run:
 *   node scripts/build-operator-tiles-geojson.mjs
 *
 * Output: tile-generation/operators.geojson (tippecanoe's input — not
 * committed, regenerated fresh each build, same as every other
 * scripts/output/* artifact).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IN_PATH = path.join(ROOT, 'scripts', 'output', 'line-segments.json');
const OUT_PATH = path.join(ROOT, 'tile-generation', 'operators.geojson');

const graph = JSON.parse(readFileSync(IN_PATH, 'utf8'));

const features = graph.segments.map((s) => ({
  type: 'Feature',
  properties: {
    id: s.id,
    operators: s.operators.join(','),
    operator_count: s.operators.length,
    length_m: s.length_m,
  },
  geometry: { type: 'LineString', coordinates: s.coords },
}));

writeFileSync(OUT_PATH, features.map((f) => JSON.stringify(f)).join('\n'));
// newline-delimited GeoJSON (one Feature per line) — tippecanoe accepts this
// directly and it streams far better than one giant FeatureCollection for a
// 6,126-feature/430k-coordinate input.

console.log(`Wrote ${features.length} features to ${OUT_PATH}`);
console.log(`Source: ${graph.scope} scope, generated_at ${graph.generated_at}`);
if (graph.scope !== 'national') {
  console.warn(`WARNING: line-segments.json scope is '${graph.scope}', not 'national' — this will tile a bbox-bounded checkpoint, not the full network. Re-run with LINE_SEGMENTS_NATIONAL=1 first if that's not intended.`);
}

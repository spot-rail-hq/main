#!/usr/bin/env node
/**
 * scripts/build-operator-tiles-geojson.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Converts scripts/output/line-segments.json (Phase 2's segment graph) into
 * a plain GeoJSON FeatureCollection for tippecanoe to tile — see
 * tile-generation/build-operator-tiles.sh for the full pipeline and why
 * tippecanoe (not tilemaker) is the right tool for this specific layer.
 *
 * Phase 5 follow-up (2026-07-15): true per-operator fan-out, replacing the
 * earlier "one feature per segment, comma-joined operators string, neutral
 * color for anything multi-operator" v1. Now emits ONE FEATURE PER OPERATOR
 * PER SEGMENT — a 6-operator segment becomes 6 features with IDENTICAL
 * geometry, each carrying a single operator key (so map.html's existing
 * exact-match color expression just works, no client-side string-splitting
 * needed) plus `operator_index` (0-based position within that segment's
 * operator list) and `operator_total` (the count), which map.html uses to
 * compute a `line-offset` centered on the real track so each operator
 * renders as its own thin parallel line rather than 6 stacked identical
 * geometries.
 *
 * `id` is now unique PER FAN-OUT FEATURE (segment id * 10 + operator
 * index — safe since operator_total never exceeds 9 in the real data, max
 * observed is 6), not per segment, because map.html's hover feature-state
 * uses `promoteId: 'id'` — if multiple fanned-out features shared one id,
 * hovering any single one would mark ALL of them as hovered (feature-state
 * is keyed by promoted id, not by individual feature identity), breaking
 * the "highlight just the one line under the cursor" requirement. The
 * original segment id is preserved separately as `segment_id` for anything
 * that needs to trace a fan-out feature back to its source segment.
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

const features = [];
for (const s of graph.segments) {
  s.operators.forEach((op, i) => {
    features.push({
      type: 'Feature',
      properties: {
        id: s.id * 10 + i,
        segment_id: s.id,
        operators: op,
        operator_index: i,
        operator_total: s.operators.length,
        length_m: s.length_m,
      },
      geometry: { type: 'LineString', coordinates: s.coords },
    });
  });
}

// Sanity-check the id-uniqueness assumption (segment id * 10 + operator
// index) before writing anything — if a segment ever has 10+ operators
// this scheme silently collides, so fail loudly instead.
const maxOperatorTotal = Math.max(0, ...graph.segments.map((s) => s.operators.length));
if (maxOperatorTotal > 9) {
  throw new Error(`A segment has ${maxOperatorTotal} operators — the id scheme (segment_id * 10 + operator_index) only supports up to 9. Widen the multiplier before proceeding.`);
}
const idSet = new Set(features.map((f) => f.properties.id));
if (idSet.size !== features.length) {
  throw new Error(`Generated ${features.length} features but only ${idSet.size} distinct ids — id collision in the fan-out scheme, investigate before tiling.`);
}

writeFileSync(OUT_PATH, features.map((f) => JSON.stringify(f)).join('\n'));
// newline-delimited GeoJSON (one Feature per line) — tippecanoe accepts this
// directly and it streams far better than one giant FeatureCollection for a
// 6,126-feature/430k-coordinate input.

console.log(`Wrote ${features.length} fan-out features (from ${graph.segments.length} segments, max operator_total ${maxOperatorTotal}) to ${OUT_PATH}`);
console.log(`Source: ${graph.scope} scope, generated_at ${graph.generated_at}`);
if (graph.scope !== 'national') {
  console.warn(`WARNING: line-segments.json scope is '${graph.scope}', not 'national' — this will tile a bbox-bounded checkpoint, not the full network. Re-run with LINE_SEGMENTS_NATIONAL=1 first if that's not intended.`);
}

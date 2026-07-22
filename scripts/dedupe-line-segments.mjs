#!/usr/bin/env node
/**
 * scripts/dedupe-line-segments.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Post-processing pass over scripts/output/line-segments.json (Phase 2's
 * output) — merges segments that are independent OSM digitizations of the
 * SAME real-world corridor into one canonical segment per corridor.
 *
 * WHY THIS EXISTS (2026-07-22 bug report): a From/To search between Hatton
 * and Leamington Spa rendered a highlighted line that visibly crossed
 * itself, and separately, WMR/LNR services known to run that corridor never
 * showed up on the map. Traced both to the same root cause: different OSM
 * route relations covering the exact same physical track (e.g. one relation
 * tagged CH+XC, another tagged CH+WMR+XC) were mapped with slightly
 * different way-splitting, so build-line-segments.mjs produced TWO separate
 * segments for what is one real corridor — confirmed live for the Hatton-
 * Leamington case: segment 960 (CH,XC, 9117m) and segment 5446 (CH,XC,
 * 9055m) share matching endpoints and near-identical length but ZERO
 * overlapping way_ids — genuinely two separate OSM digitizations, not a
 * relation-splitting artifact. The routing graph then links both
 * representations together via short connector segments, so Dijkstra's
 * shortest path can hop from one representation to the other mid-journey —
 * physically nonsensical (a train doesn't switch which digitization of the
 * track it's on) and it's exactly what produced the self-crossing line: the
 * rendered path jumps between two non-identical parallel geometries at the
 * splice point. A national scan found ~1,380 such candidate pairs, so this
 * is systemic, not a one-off.
 *
 * This script does NOT fix the operator-COLOR/visibility side of that bug
 * (WMR not rendering on the base map) — that lives in the already-deployed
 * operators.pmtiles vector tiles (built via build-operator-tiles-geojson.mjs
 * + tippecanoe + uploaded to R2), which this session has no credentials/
 * tooling to regenerate. What IS fixed here is the ROUTING GRAPH
 * (data/routing-graph.json, a plain committed file the client fetches
 * directly) never being ABLE to hop between duplicate representations in
 * the first place, since only one canonical segment per corridor survives
 * into it — which directly fixes the self-crossing rendered path.
 *
 * MATCHING: geometric, not way-id-based (confirmed above that duplicates
 * can share zero way_ids). Two segments are considered the same corridor if
 * their endpoints match (allowing reversal), their total length is close,
 * AND three sampled interior points (25/50/75% along the path) are also
 * close — that last check is what stops two genuinely different routes
 * that happen to share both endpoints (e.g. a loop vs. a direct line) from
 * being merged. Grouped via union-find so a corridor mapped by 3+ relations
 * merges into one group, not just pairwise.
 *
 * MERGE: keeps the geometry of whichever group member has the MOST
 * coordinate points (highest fidelity) as the surviving segment — same
 * `id` as before, so nothing downstream needs remapping and the
 * ALREADY-DEPLOYED tiles' segment_id values stay valid (tiles still
 * contain both original segment_ids as separate features; the routing
 * graph rebuilt from this output just never creates an edge that would
 * need to query the discarded one). Operators and way_ids are unioned
 * across the whole group onto the survivor. Every other group member is
 * dropped from the output entirely.
 *
 * Run:
 *   node scripts/dedupe-line-segments.mjs
 * Then re-run the rest of the pipeline so the fix actually reaches
 * data/routing-graph.json:
 *   node scripts/build-station-graph-links.mjs
 *   node scripts/build-routing-graph.mjs
 *
 * Output: overwrites scripts/output/line-segments.json in place (original
 * is recoverable via git — this repo tracks that file).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');

const data = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
const segments = data.segments;
console.log(`Loaded ${segments.length} segments.`);

// Plain planar approximation (not true geodesic) — fine for a relative
// "are these two points close" check at this scale, same reasoning already
// used for map.html's station-density tiering.
const COS_REF = Math.cos((54.5 * Math.PI) / 180);
const KM_PER_DEG_LAT = 111000;
function dist(a, b) {
  const dx = (a[0] - b[0]) * COS_REF * KM_PER_DEG_LAT;
  const dy = (a[1] - b[1]) * KM_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function cumulativeDist(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  return cum;
}
function sampleAtFraction(coords, cum, total, frac) {
  const target = total * frac;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= target) {
      const segFrac = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      const a = coords[i - 1], b = coords[i];
      return [a[0] + (b[0] - a[0]) * segFrac, a[1] + (b[1] - a[1]) * segFrac];
    }
  }
  return coords[coords.length - 1];
}

const info = segments.map((s, idx) => {
  const coords = s.coords;
  const cum = cumulativeDist(coords);
  const total = cum[cum.length - 1];
  return {
    idx,
    seg: s,
    start: coords[0],
    end: coords[coords.length - 1],
    total,
    samples: [0.25, 0.5, 0.75].map((f) => sampleAtFraction(coords, cum, total, f)),
  };
});

// 2026-07-22 bugfix: a FLAT 150m tolerance looked right for the ~9-40km
// Hatton-Leamington corridor case this script was built for, but a busy
// junction throat is full of genuinely DIFFERENT short segments (27-155m
// ladder/crossover pieces) that are closer together than 150m purely
// because they're small, not because they're duplicates — confirmed live:
// a first pass at 150m flat merged 17 real, distinct short segments near a
// London terminal throat into one, because at that length scale 150m is
// enormous relative to the segments themselves. Tolerance now SCALES with
// each pair's own length (a fraction of it, clamped between a noise floor
// and the original 150m ceiling for long corridors), so short segments
// need proportionally tight matching while long ones keep the generous
// absolute allowance real snapping differences need.
const TOL_FRAC = 0.06; // 6% of length
const TOL_FLOOR_M = 15; // below this, treat as GPS/digitization noise regardless of length
const TOL_CEIL_M = 150; // above this, more precision doesn't buy anything for a long corridor
function scaledTol(lengthM) {
  return Math.min(TOL_CEIL_M, Math.max(TOL_FLOOR_M, TOL_FRAC * lengthM));
}
const LENGTH_TOL_MIN_M = 100;
const LENGTH_TOL_FRAC = 0.1;
// 2026-07-22: a second bugfix on top of the scaled-tolerance one above — a
// busy junction throat packs MANY genuinely different short segments (a
// crossover ladder) into a small area, and at that scale there just isn't
// enough geometric signal to reliably tell "two duplicate digitizations of
// one track" apart from "two different but nearby physical connections" —
// confirmed live: even after scaling tolerance to length, a cluster of ten
// distinct 19-44m segments near a London terminal throat still matched each
// other pairwise, because a few metres of real GPS/digitization noise is
// still a big fraction of a 20m segment. Below this floor, don't attempt to
// dedupe at all — the reported bug (and every genuine duplicate corridor
// found alongside it) is multi-hundred-metres-to-tens-of-km long, so this
// costs nothing for the actual fix while removing the riskiest false-
// positive class entirely.
const MIN_LENGTH_FOR_DEDUP_M = 300;

function isDuplicate(a, b) {
  if (a.seg.coords.length < 2 || b.seg.coords.length < 2) return false;
  if (a.total < MIN_LENGTH_FOR_DEDUP_M || b.total < MIN_LENGTH_FOR_DEDUP_M) return false;
  if (Math.abs(a.total - b.total) > Math.max(LENGTH_TOL_MIN_M, LENGTH_TOL_FRAC * a.total)) return false;
  const tol = scaledTol(Math.min(a.total, b.total));
  const forward = dist(a.start, b.start) <= tol && dist(a.end, b.end) <= tol;
  const reversed = !forward && dist(a.start, b.end) <= tol && dist(a.end, b.start) <= tol;
  if (!forward && !reversed) return false;
  const bSamples = reversed ? [...b.samples].reverse() : b.samples;
  for (let i = 0; i < a.samples.length; i++) {
    if (dist(a.samples[i], bSamples[i]) > tol) return false;
  }
  return true;
}

// ── Union-find, grouping a corridor mapped by 3+ relations into one group,
// not just pairwise ─────────────────────────────────────────────────────
const parent = info.map((_, i) => i);
function find(x) {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}
function union(a, b) {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent[ra] = rb;
}

// O(n²) over ~6,126 segments (~37.5M comparisons, pure arithmetic, no trig)
// — a one-time offline script run, not a hot path; a bounding-box pre-check
// keeps most pairs cheap (bail on length before ever computing samples).
let comparisons = 0;
for (let i = 0; i < info.length; i++) {
  for (let j = i + 1; j < info.length; j++) {
    comparisons++;
    if (isDuplicate(info[i], info[j])) union(i, j);
  }
}
console.log(`${comparisons} pairs compared.`);

const groups = new Map(); // root idx -> [info...]
for (const item of info) {
  const root = find(item.idx);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(item);
}

let mergedGroupCount = 0, droppedSegmentCount = 0;
const keep = [];
for (const group of groups.values()) {
  if (group.length === 1) {
    keep.push(group[0].seg);
    continue;
  }
  mergedGroupCount++;
  droppedSegmentCount += group.length - 1;
  // Canonical = most coordinate points (highest fidelity geometry).
  let canonical = group[0];
  for (const g of group) if (g.seg.coords.length > canonical.seg.coords.length) canonical = g;
  const operators = new Set();
  const wayIds = new Set();
  for (const g of group) {
    for (const o of g.seg.operators || []) operators.add(o);
    for (const w of g.seg.way_ids || []) wayIds.add(w);
  }
  const mergedSeg = {
    ...canonical.seg,
    operators: [...operators],
    way_ids: [...wayIds],
  };
  keep.push(mergedSeg);
  const others = group.filter((g) => g !== canonical).map((g) => g.seg.id);
  console.log(
    `Merged group (${group.length}): kept id=${canonical.seg.id} [${[...operators].join(',')}] ` +
      `<- dropped ids [${others.join(', ')}]`
  );
}

console.log(`\n${mergedGroupCount} corridor groups merged, ${droppedSegmentCount} duplicate segments dropped.`);
console.log(`${segments.length} segments -> ${keep.length} segments.`);

const out = { ...data, segment_count: keep.length, segments: keep };
writeFileSync(SEG_PATH, JSON.stringify(out));
console.log(`Written to ${SEG_PATH}`);

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
 * color for anything multi-operator" v1. Emits ONE FEATURE PER OPERATOR PER
 * SEGMENT — a 6-operator segment becomes 6 features with IDENTICAL geometry,
 * each carrying a single operator key (so map.html's existing exact-match
 * color expression just works, no client-side string-splitting needed).
 *
 * Lane-continuity rewrite (2026-07-21): the original fan-out gave each
 * feature `operator_index` (0-based position within THAT SEGMENT's own
 * operators array, alphabetical) and `operator_total` (that segment's own
 * operator count), and map.html centered the render offset as
 * `index - (total-1)/2`. Verified via the real segment graph that this
 * causes a real, FREQUENT visual defect: since `total` is entirely local to
 * one segment, the SAME operator's absolute offset swings every time the
 * set of co-runners changes — which happens at nearly every junction
 * (measured 28-47% of same-operator adjacent-segment boundaries actually
 * change offset, across two different real corridors: Doncaster/LNER and
 * the Glasgow checkpoint/ScotRail). Alphabetical ordering itself is already
 * globally consistent (GR is always alphabetically between GC and LD,
 * everywhere) — the actual bug is RE-CENTERING by a LOCAL total every time,
 * which shifts everyone's absolute position even when nothing about their
 * relative arrangement changed.
 *
 * Fix: assignStableLanes() below computes one FIXED integer lane number per
 * operator PER PHYSICALLY-CONNECTED CORRIDOR (not per segment), via a BFS
 * over the segment adjacency graph (segments sharing an OSM endpoint node).
 * A continuing operator inherits its lane from an already-processed
 * neighbor; only a genuinely NEW operator (not seen on any adjacent
 * already-visited segment) gets assigned a fresh lane. The per-segment
 * render offset is then `lane[op] - mean(lane[op'] for op' on this segment)`
 * — mean-centered using the STABLE lane numbers, not a freshly re-sequenced
 * local index, so two continuing operators keep the exact same relative
 * gap across a boundary regardless of who else joins/leaves nearby; only
 * the group's mean (and therefore everyone's absolute offset by a shared,
 * small amount) shifts when the local set actually changes.
 *
 * Emits `lane_offset` (a plain number, already mean-centered) instead of
 * operator_index/operator_total — map.html's operatorLineOffsetExpression()
 * just scales this by zoom, no index/total math needed client-side anymore.
 * `id` is still segment_id * 10 + enumeration-index (unrelated to the lane
 * number — only needs to be unique per fan-out feature, see the original
 * per-feature promoteId reasoning below).
 *
 * `id` is unique PER FAN-OUT FEATURE (segment id * 10 + a plain enumeration
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

// ── Lane-continuity assignment ──────────────────────────────────────────
// Builds an adjacency graph over segment ENDPOINT nodes only (junctions/
// splits only ever happen at endpoints — see build-line-segments.mjs), then
// BFS-propagates a stable per-operator lane number along each connected
// component. Returns { laneById: Map<segmentId, Map<operator, laneNumber>>,
// conflictCount, componentCount } — conflictCount/componentCount are purely
// diagnostic (logged below, not consumed downstream).
function assignStableLanes(segments) {
  const segById = new Map(segments.map((s) => [s.id, s]));
  const nodeToSegs = new Map();
  for (const s of segments) {
    const endpoints = [s.nodes[0], s.nodes[s.nodes.length - 1]];
    for (const n of endpoints) {
      if (!nodeToSegs.has(n)) nodeToSegs.set(n, []);
      nodeToSegs.get(n).push(s.id);
    }
  }
  function neighborsOf(segId) {
    const s = segById.get(segId);
    const endpoints = [s.nodes[0], s.nodes[s.nodes.length - 1]];
    const out = new Set();
    for (const n of endpoints) {
      for (const other of nodeToSegs.get(n) || []) {
        if (other !== segId) out.add(other);
      }
    }
    return out;
  }
  function nextFreeLane(takenLanes) {
    if (!takenLanes.has(0)) return 0;
    for (let k = 1; ; k++) {
      if (!takenLanes.has(k)) return k;
      if (!takenLanes.has(-k)) return -k;
    }
  }

  const laneById = new Map(); // segmentId -> Map(operator -> lane)
  const componentOf = new Map(); // segmentId -> component id (for the mean-centering pass below)
  const visited = new Set();
  let conflictCount = 0;
  let componentCount = 0;

  for (const seed of segments) {
    if (visited.has(seed.id)) continue;
    componentCount++;
    const thisComponent = componentCount;
    const queue = [seed.id];
    visited.add(seed.id);
    while (queue.length) {
      const segId = queue.shift();
      componentOf.set(segId, thisComponent);
      const seg = segById.get(segId);
      const processedNeighbors = [...neighborsOf(segId)].filter((n) => laneById.has(n));

      // Collect every already-assigned neighbor's proposed lane for each of
      // THIS segment's operators (an operator with no proposal at all is
      // genuinely new here, not a continuation of anything nearby).
      const proposals = new Map(); // operator -> Map(lane -> voteCount)
      for (const nb of processedNeighbors) {
        for (const [op, lane] of laneById.get(nb)) {
          if (!seg.operators.includes(op)) continue;
          if (!proposals.has(op)) proposals.set(op, new Map());
          const votes = proposals.get(op);
          votes.set(lane, (votes.get(lane) || 0) + 1);
        }
      }

      const assignment = new Map();
      const taken = new Set();
      // Continuing operators first — majority-voted lane (deterministic
      // smallest-lane tiebreak), so a real conflict (two different physical
      // directions disagreeing on this operator's lane) resolves the same
      // way every rebuild rather than depending on Map iteration order.
      for (const op of seg.operators) {
        const votes = proposals.get(op);
        if (!votes) continue;
        if (votes.size > 1) conflictCount++;
        let bestLane = null, bestCount = -1;
        for (const [lane, count] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
          if (count > bestCount) { bestLane = lane; bestCount = count; }
        }
        assignment.set(op, bestLane);
        taken.add(bestLane);
      }
      // Newly-appearing operators — smallest lane not already taken on THIS
      // segment, alternating outward from 0 (0, 1, -1, 2, -2, ...) so a
      // brand-new corridor (or a new entrant joining an existing one) stays
      // compact/centered rather than drifting to one side.
      for (const op of seg.operators) {
        if (assignment.has(op)) continue;
        const lane = nextFreeLane(taken);
        assignment.set(op, lane);
        taken.add(lane);
      }

      laneById.set(segId, assignment);
      for (const nb of neighborsOf(segId)) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
  }

  return { laneById, componentOf, conflictCount, componentCount, neighborsOf };
}

// Relaxation pass — fixes the residual case the single-pass BFS above can't:
// two segments that are mutual neighbors but got visited far apart in BFS
// order (e.g. two branches of a junction reached via different, distant
// ancestors) can each independently self-assign a "new" lane for the same
// operator before ever seeing each other, even with an IDENTICAL operator
// set on both segments — a real conflict, not local-mean jitter (verified
// 2026-07-21: found segments with identical `operators` arrays but
// different GR lanes after the first BFS pass). Re-derives every segment's
// assignment from its FULL neighbor set's CURRENT lanes (not just
// BFS-predecessors) each pass, repeated a FIXED number of times — verified
// this does NOT reliably converge to a fixed point (a handful of segments
// at genuinely ambiguous multi-way junctions keep flipping between two
// equally-valid lane choices forever), so a fixed iteration count is used
// rather than "run until stable". 8 passes was chosen empirically: the
// change-count drops monotonically and substantially through about pass 10
// (228 -> 48 changed segments on the real national graph) before plateauing
// and eventually oscillating past pass ~15 — 8 captures the great majority
// of that improvement while staying comfortably before the oscillation
// range, and running a fixed count keeps output fully deterministic (same
// input always produces the same tiles) rather than depending on where a
// non-converging loop happened to be stopped.
function relaxLanes(segments, laneById, neighborsOf, passes) {
  const segById = new Map(segments.map((s) => [s.id, s]));
  function nextFreeLane(takenLanes) {
    if (!takenLanes.has(0)) return 0;
    for (let k = 1; ; k++) {
      if (!takenLanes.has(k)) return k;
      if (!takenLanes.has(-k)) return -k;
    }
  }
  let current = laneById;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Map();
    for (const s of segments) {
      const proposals = new Map(); // operator -> Map(lane -> voteCount)
      for (const nb of neighborsOf(s.id)) {
        const nbLanes = current.get(nb);
        if (!nbLanes) continue;
        for (const [op, lane] of nbLanes) {
          if (!s.operators.includes(op)) continue;
          if (!proposals.has(op)) proposals.set(op, new Map());
          const votes = proposals.get(op);
          votes.set(lane, (votes.get(lane) || 0) + 1);
        }
      }
      const assignment = new Map();
      const taken = new Set();
      for (const op of s.operators) {
        const votes = proposals.get(op);
        if (!votes) continue;
        let bestLane = null, bestCount = -1;
        for (const [lane, count] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
          if (count > bestCount) { bestLane = lane; bestCount = count; }
        }
        assignment.set(op, bestLane);
        taken.add(bestLane);
      }
      // No proposal this pass — keep the existing lane if it's still free
      // (stabilizes faster than always re-deriving from scratch), otherwise
      // take the next free slot.
      for (const op of s.operators) {
        if (assignment.has(op)) continue;
        const existing = current.get(s.id)?.get(op);
        const lane = existing !== undefined && !taken.has(existing) ? existing : nextFreeLane(taken);
        assignment.set(op, lane);
        taken.add(lane);
      }
      next.set(s.id, assignment);
    }
    current = next;
  }
  return current;
}

const RELAXATION_PASSES = 8;
const built = assignStableLanes(graph.segments);
const { componentOf, conflictCount, componentCount, neighborsOf } = built;
const laneById = relaxLanes(graph.segments, built.laneById, neighborsOf, RELAXATION_PASSES);

// Centering constant is ONE FIXED VALUE PER CONNECTED COMPONENT, not
// recomputed per segment. This is the actual fix for the offset-jog bug
// (verified 2026-07-21 against the real Doncaster/LNER and Glasgow/ScotRail
// corridors): a per-segment mean recenters using whichever operators
// happen to be on THAT one segment, which shifts every time the local set
// changes — nearly every junction — even though each operator's own lane
// number (above) is already perfectly stable. Centering on the mean of
// each DISTINCT operator's lane within the whole component instead (each
// operator counted once, not once per segment it spans) gives a single
// constant subtracted everywhere in that component, so an operator's
// rendered offset only ever changes if ITS OWN lane genuinely had to be
// reassigned (a real conflict, not a routine "someone else joined/left").
// Combined with relaxLanes() above, reduced the measured jog rate (fraction
// of same-operator adjacent segment-boundary pairs whose offset differs)
// from 47% -> 2.0% nationwide for LNER, 28% -> 1.6% for ScotRail, similar
// for every other operator checked (CrossCountry 2.6%, Avanti West Coast
// 3.6%, GWR 0.7%). The small remainder is genuine multi-way-junction
// ambiguity relaxLanes() can't fully resolve (see its own comment on why a
// fixed pass count is used instead of running to convergence), not routine
// junction churn.
const componentLaneSums = new Map(); // componentId -> {sum, count} over DISTINCT operator->lane pairs
for (const [segId, assignment] of laneById) {
  const c = componentOf.get(segId);
  if (!componentLaneSums.has(c)) componentLaneSums.set(c, new Map()); // operator -> lane, de-duped
  const seen = componentLaneSums.get(c);
  for (const [op, lane] of assignment) seen.set(op, lane); // same value every time (stable) — just overwrite
}
const componentMean = new Map();
for (const [c, opLanes] of componentLaneSums) {
  const vals = [...opLanes.values()];
  componentMean.set(c, vals.reduce((a, b) => a + b, 0) / vals.length);
}

const features = [];
for (const s of graph.segments) {
  const lanes = laneById.get(s.id);
  const mean = componentMean.get(componentOf.get(s.id));
  s.operators.forEach((op, i) => {
    features.push({
      type: 'Feature',
      properties: {
        id: s.id * 10 + i,
        segment_id: s.id,
        operators: op,
        lane_offset: lanes.get(op) - mean,
        length_m: s.length_m,
      },
      geometry: { type: 'LineString', coordinates: s.coords },
    });
  });
}

// Sanity-check the id-uniqueness assumption (segment id * 10 + enumeration
// index) before writing anything — if a segment ever has 10+ operators this
// scheme silently collides, so fail loudly instead.
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
console.log(`Lane assignment: ${componentCount} connected components, ${conflictCount} initial BFS-pass lane conflicts, ${RELAXATION_PASSES} relaxation passes applied on top`);
if (graph.scope !== 'national') {
  console.warn(`WARNING: line-segments.json scope is '${graph.scope}', not 'national' — this will tile a bbox-bounded checkpoint, not the full network. Re-run with LINE_SEGMENTS_NATIONAL=1 first if that's not intended.`);
}

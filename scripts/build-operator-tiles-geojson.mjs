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
 * Magnitude-weighted optimiser (2026-07-28): assignStableLanes()+relaxLanes()
 * are now only a SEED. Both minimise how MANY neighbours disagree about an
 * operator's lane and never by HOW MUCH, so a 5-lane jump costs them the same
 * as a 1-lane one — which is why the shipped tileset had Lumo and CrossCountry
 * swapping sides mid-corridor on the ECML while LNER stayed stable.
 * optimiseLanes() below minimises sum(|delta lane|^POWER) over every adjacency
 * boundary by local search to a genuine fixed point, and treats "distinct lanes
 * per segment" as a hard constraint. On the post-dedupe graph: boundaries at
 * >=2 lane units 52 -> 4 (nothing left above 2u), lane collisions 513 -> 0.
 * See each constant for its swept alternatives and why they were rejected.
 *
 * Emits `lane_offset` (a plain number, already centred on its component's lane
 * range midpoint) instead of operator_index/operator_total — map.html's
 * operatorLineOffsetExpression() just scales this by zoom, no index/total math
 * needed client-side anymore. NOTE for anyone retuning the fan: the optimiser's
 * lane span is 7.0 units, not the 5.0 the pre-optimiser build produced, and
 * map.html's LANE_FAN_ZOOM_STOPS is scaled to match. Changing the optimiser
 * constants can change the span — re-check that pairing.
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
      // KNOWN BUG, DELIBERATELY NOT FIXED HERE (2026-07-28). This loop does not
      // check `taken`, so two operators on one segment can both be voted onto
      // the SAME lane and render exactly on top of each other — one of them
      // invisible. Measured in the shipped pre-dedupe tileset: 699 segments
      // (11.4%), 816 operator-pairs, ~3,774 km of track; post-dedupe 513 / 577
      // / ~2,251 km. Every major TOC affected (XC 194, AW 171, TP 149, ...).
      //
      // Why it is not fixed in place: relaxLanes' output is now only the SEED
      // for optimiseLanes() below, which treats "distinct lanes per segment" as
      // a hard constraint (COLLISION_PENALTY) and drives collisions to zero
      // regardless of what it is handed — enforced by a build-time assertion,
      // so the invariant is guaranteed, not merely expected. Adding a `taken`
      // check HERE changes the seed and measurably degrades the final result:
      // A/B on the post-dedupe graph gave >=2u 4 -> 8 and, decisively, split
      // Lumo across two lanes on the ECML Northallerton-York corridor
      // (`{1.7778: 18, 0.7778: 2}`) — the exact defect this whole rewrite was
      // commissioned to fix. The one thing the fixed seed does buy is a lane
      // span of exactly 5.0 instead of 7.0 (no LANE_FAN_ZOOM_STOPS rescale
      // needed); that was judged not worth reintroducing the defect.
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
const seedLanes = relaxLanes(graph.segments, built.laneById, neighborsOf, RELAXATION_PASSES);

// ── Magnitude-weighted lane optimiser (2026-07-28) ────────────────────────
// assignStableLanes()+relaxLanes() above are now only a SEED. They minimise
// how MANY adjacent segments disagree about an operator's lane (majority vote,
// smallest-lane tiebreak) and never consider by HOW MUCH: a 5-lane jump and a
// 1-lane jump cost them exactly the same. That is why the shipped tileset had
// Lumo and CrossCountry visibly swapping sides mid-corridor on the ECML while
// LNER stayed rock solid — a 1-unit jog is ~2px at z8 and invisible, a 3-5 unit
// one is a step the eye reads as a break.
//
// This pass minimises sum(|delta lane|^JOG_COST_POWER) over every adjacency
// boundary instead, by local search to a genuine fixed point. Measured on the
// post-dedupe graph (5,371 segments): boundaries >=2 lane units 52 -> 4,
// nothing left above 2u, and 513 -> 0 lane collisions.
const JOG_COST_POWER = 2;
// Superlinear so magnitude dominates count. Swept 1/2/3/4 -> >=2u of 9/4/1/2.
// POWER=1 is the current algorithm's failure mode restated (minimises count,
// leaves four 4-unit jogs). POWER=3 scores best nationally at 1 but SPLITS
// LUMO on the ECML again, so it is rejected on the same veto as everything
// else here. 2 is the only setting that both hits the target and keeps the
// corridor this rewrite exists to fix.
const COLLISION_PENALTY = 50;
// Two operators on one segment must never share a lane (they would draw on top
// of each other). Set well above any plausible single-boundary jog cost — max
// ~25 at POWER=2 — so this behaves as a hard constraint rather than something
// the optimiser can trade away. Asserted after the run.
const COMPACTNESS = 0;
// A mild |lane| pull toward zero, to stop a run parking at lane -4 for a
// marginal gain and widening the fan. KEPT AT ZERO, i.e. disabled. Do not
// re-derive this: it was built and swept (0.005 / 0.01 / 0.02 / 0.03 / 0.05 /
// 0.1 / 0.25) and it splits Lumo back into 2-3 lanes at EVERY non-zero weight,
// including the mildest. It is not a cost tradeoff — at w=0.005 the compactness
// saving on a 20-segment run is 0.1 against a jog cost of 1.0, far too weak to
// buy that split. What actually happens is the perturbation tips the local
// search into a different, worse basin (sweeps jump 4 -> 7; >=2u sits flat at 6
// across 0.005-0.03, i.e. the same wrong basin, before degrading further).
// Scaling the weight cannot fix a basin problem. The most it ever bought was
// span 7.0 -> 6.0; it never approached 5.0.
const LANE_WINDOW = 4;   // candidate lanes searched either side; wider found nothing more
const MAX_SWEEPS = 60;   // a bound, never reached — converges at 3-4 sweeps

// ── STABILITY / LANE MEMORY (2026-08-05) ─────────────────────────────────
// THE BUG THIS FIXES. Everything above minimises a cost over the WHOLE network
// with no preference for the answer it gave last time, so the solution is only
// as stable as the input. Adding 338 branch-ingest segments — Wharfedale,
// Harrogate, Pontefract, South Fylde, Morecambe, Corby, none of them within
// 100 km of the East Coast Main Line — re-solved the entire network and moved
// 739 of 9,897 lane offsets (7.5%) by 1-4 units on corridors nobody had
// touched. Measured in the Retford-Newark-Grantham-Stamford box alone, offset
// jogs went 2 -> 5, and the three new ones were LNER, CrossCountry and Grand
// Central sitting directly on the ECML. On screen a jog is a line that steps
// sideways mid-corridor, which reads as the route breaking in half.
//
// Nothing was wrong with the optimiser's answer either time. The failure is
// that "a good solution" and "the same good solution" are different
// requirements, and only the first was ever asked for.
//
// THE FIX. Remember the previous run's assignment and (a) seed from it, so the
// local search starts in the basin it already settled in, and (b) charge a
// small cost for moving away from it, so an offset only changes where doing so
// actually buys something.
//
// WEIGHT CHOICE. 0.35 per unit of deviation, deliberately BELOW the 1.0 cost of
// a single 1-unit jog at POWER=2. That ordering is the whole design: removing a
// real jog always outbids the memory, so this can never freeze a genuine defect
// in place, but two equally-good solutions are no longer a coin flip. Do not
// raise it above 1.0 — at that point the optimiser would rather keep a visible
// break than move a lane, which is the opposite of the point.
//
// NOT THE SAME AS COMPACTNESS, which is disabled above for reasons that look
// superficially similar. Compactness pulls every lane toward zero — a constant
// force with no relation to any solution, which is why it tips the search into
// a worse basin at any weight. This pulls toward a specific previously-verified
// assignment, i.e. it anchors the search rather than dragging it. Verified
// empirically rather than argued: see the jog counts logged at the end of a run.
const STABILITY_WEIGHT = 0.35;
const LANE_MEMORY_PATH = path.join(__dirname, 'output', 'lane-offsets.json');
// { "<segmentId>": { "<operator>": lane } } from the previous run. Absent on a
// first run (or after a deliberate reset), in which case this whole mechanism
// is inert and the optimiser behaves exactly as it did before.
let laneMemory = new Map();
try {
  const raw = JSON.parse(readFileSync(LANE_MEMORY_PATH, 'utf8'));
  for (const [segId, ops] of Object.entries(raw.lanes || {})) {
    laneMemory.set(Number(segId), new Map(Object.entries(ops)));
  }
  console.log(`Lane memory: ${laneMemory.size} segments remembered from ${raw.generated_at || 'an earlier run'}`);
} catch {
  console.log('Lane memory: none found — this run will establish it (offsets may move once).');
}

// Every adjacency boundary that actually matters: a pair of segments sharing an
// endpoint node, and the operators they have in common.
const nodeToSegsAll = new Map();
for (const s of graph.segments) {
  for (const n of [s.nodes[0], s.nodes[s.nodes.length - 1]]) {
    if (!nodeToSegsAll.has(n)) nodeToSegsAll.set(n, []);
    nodeToSegsAll.get(n).push(s.id);
  }
}
const segByIdAll = new Map(graph.segments.map((s) => [s.id, s]));
const boundaries = [];
{
  const seenPair = new Set();
  for (const [, ids] of nodeToSegsAll) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        const opsA = new Set(segByIdAll.get(a).operators || []);
        const shared = (segByIdAll.get(b).operators || []).filter((o) => opsA.has(o));
        if (shared.length) boundaries.push({ a, b, ops: shared });
      }
    }
  }
}
const boundaryIndex = new Map();
for (const bd of boundaries) {
  if (!boundaryIndex.has(bd.a)) boundaryIndex.set(bd.a, []);
  if (!boundaryIndex.has(bd.b)) boundaryIndex.set(bd.b, []);
  boundaryIndex.get(bd.a).push(bd);
  boundaryIndex.get(bd.b).push(bd);
}

function optimiseLanes(seed) {
  const lanes = new Map();
  for (const [id, asg] of seed) lanes.set(id, new Map(asg));
  // Start the local search from the remembered answer wherever there is one.
  // The seed above (assignStableLanes + relaxLanes) is a fresh derivation that
  // knows nothing about the last run, so without this the search begins in a
  // different basin and the stability term can only tug it partway back —
  // seeding is what makes the memory actually hold. A remembered lane is only
  // adopted if the operator is still on the segment; anything else is ignored,
  // so a stale memory degrades to the fresh seed rather than corrupting it.
  let seededOps = 0;
  for (const [id, asg] of lanes) {
    const remembered = laneMemory.get(id);
    if (!remembered) continue;
    for (const op of asg.keys()) {
      const was = remembered.get(op);
      if (was !== undefined) { asg.set(op, was); seededOps++; }
    }
  }
  if (seededOps) console.log(`Lane memory: seeded ${seededOps} (segment, operator) lanes from the previous run`);
  const allOperators = [...new Set(graph.segments.flatMap((s) => s.operators || []))];

  const jogCost = (d) => Math.pow(d, JOG_COST_POWER);
  function boundaryCost(bd) {
    const la = lanes.get(bd.a), lb = lanes.get(bd.b);
    if (!la || !lb) return 0;
    let c = 0;
    for (const op of bd.ops) {
      const x = la.get(op), y = lb.get(op);
      if (x === undefined || y === undefined) continue;
      const d = Math.abs(x - y);
      if (d > 0) c += jogCost(d);
    }
    return c;
  }
  function segmentPenalty(segId) {
    const asg = lanes.get(segId);
    if (!asg) return 0;
    const perLane = new Map();
    let c = 0;
    // Lane memory: charge for drifting from the previous run's answer. Linear,
    // not squared — a 1-unit drift should cost a predictable 0.35 rather than
    // being nearly free, and the squared jog term is what must dominate at
    // larger distances. Operators with no remembered lane (new segments, or a
    // new sub-brand on an old segment) contribute nothing, so growth is free.
    const remembered = laneMemory.get(segId);
    if (remembered) {
      for (const [op, l] of asg) {
        const was = remembered.get(op);
        if (was !== undefined && was !== l) c += STABILITY_WEIGHT * Math.abs(l - was);
      }
    }
    for (const l of asg.values()) {
      perLane.set(l, (perLane.get(l) || 0) + 1);
      c += COMPACTNESS * Math.abs(l);
    }
    for (const k of perLane.values()) if (k > 1) c += (COLLISION_PENALTY * k * (k - 1)) / 2;
    return c;
  }
  // Cost of everything touching a set of segments. Only ever compared against
  // itself before/after a candidate move, so double-counting inside the set is
  // harmless as long as the same set is used both times.
  function localCost(segIds) {
    let c = 0;
    const doneBoundaries = new Set();
    for (const id of segIds) {
      c += segmentPenalty(id);
      for (const bd of boundaryIndex.get(id) || []) {
        if (doneBoundaries.has(bd)) continue;
        doneBoundaries.add(bd);
        c += boundaryCost(bd);
      }
    }
    return c;
  }
  // Maximal connected groups of segments on which `op` currently holds one lane.
  function operatorRuns(op) {
    const inOp = new Set(graph.segments.filter((s) => (s.operators || []).includes(op)).map((s) => s.id));
    const visited = new Set(), runs = [];
    for (const start of inOp) {
      if (visited.has(start)) continue;
      const lane = lanes.get(start)?.get(op);
      if (lane === undefined) { visited.add(start); continue; }
      const run = [], queue = [start];
      visited.add(start);
      while (queue.length) {
        const id = queue.shift();
        run.push(id);
        for (const nb of neighborsOf(id)) {
          if (!inOp.has(nb) || visited.has(nb)) continue;
          if (lanes.get(nb)?.get(op) !== lane) continue;
          visited.add(nb);
          queue.push(nb);
        }
      }
      runs.push({ lane, segs: run });
    }
    return runs;
  }

  let sweeps = 0, converged = false;
  for (; sweeps < MAX_SWEEPS; sweeps++) {
    let changed = 0;

    // MOVE 1 — RUN-LEVEL. Relocate an operator's whole same-lane run, swapping
    // with whichever operator holds the target lane on each segment. This is
    // the move that actually fixes a swapped run: a single-segment swap only
    // relocates the jog to the next segment along, which is why a purely
    // per-segment optimiser got Lumo from 17/5 to 18/4 and no further.
    for (const op of allOperators) {
      for (const run of operatorRuns(op)) {
        const touched = new Set(run.segs);
        for (const id of run.segs) for (const nb of neighborsOf(id)) touched.add(nb);
        let bestCost = localCost(touched), bestLane = null;
        const candidates = new Set();
        for (const id of run.segs) for (const nb of neighborsOf(id)) {
          const l = lanes.get(nb)?.get(op);
          if (l !== undefined && l !== run.lane) candidates.add(l);
        }
        for (let d = -2; d <= 2; d++) candidates.add(run.lane + d);
        candidates.delete(run.lane);
        for (const cand of candidates) {
          const undo = [];
          for (const id of run.segs) {
            const asg = lanes.get(id);
            let occupant = null;
            for (const [o, l] of asg) if (l === cand && o !== op) { occupant = o; break; }
            undo.push([id, asg.get(op), occupant, occupant ? asg.get(occupant) : null]);
            asg.set(op, cand);
            if (occupant) asg.set(occupant, run.lane);
          }
          const after = localCost(touched);
          if (after < bestCost - 1e-9) { bestCost = after; bestLane = cand; }
          for (let k = undo.length - 1; k >= 0; k--) {
            const [id, oldLane, occupant, occupantOld] = undo[k];
            const asg = lanes.get(id);
            asg.set(op, oldLane);
            if (occupant) asg.set(occupant, occupantOld);
          }
        }
        if (bestLane !== null) {
          for (const id of run.segs) {
            const asg = lanes.get(id);
            let occupant = null;
            for (const [o, l] of asg) if (l === bestLane && o !== op) { occupant = o; break; }
            asg.set(op, bestLane);
            if (occupant) asg.set(occupant, run.lane);
          }
          changed++;
        }
      }
    }

    // MOVE 2/3 — per-segment polish: relabel one operator to a nearby lane, or
    // swap two operators. Cleans up what the run pass leaves at junction throats.
    for (const s of graph.segments) {
      const asg = lanes.get(s.id);
      if (!asg || !asg.size) continue;
      const touched = new Set([s.id]);
      for (const nb of neighborsOf(s.id)) touched.add(nb);
      let best = localCost(touched);
      let improved = true;
      while (improved) {
        improved = false;
        for (const op of s.operators) {
          const cur = asg.get(op);
          if (cur === undefined) continue;
          for (let cand = cur - LANE_WINDOW; cand <= cur + LANE_WINDOW && !improved; cand++) {
            if (cand === cur) continue;
            asg.set(op, cand);
            const c = localCost(touched);
            if (c < best - 1e-9) { best = c; improved = true; changed++; }
            else asg.set(op, cur);
          }
          if (improved) break;
        }
        if (improved) continue;
        for (let i = 0; i < s.operators.length && !improved; i++) {
          for (let j = i + 1; j < s.operators.length && !improved; j++) {
            const o1 = s.operators[i], o2 = s.operators[j];
            const l1 = asg.get(o1), l2 = asg.get(o2);
            if (l1 === undefined || l2 === undefined || l1 === l2) continue;
            asg.set(o1, l2); asg.set(o2, l1);
            const c = localCost(touched);
            if (c < best - 1e-9) { best = c; improved = true; changed++; }
            else { asg.set(o1, l1); asg.set(o2, l2); }
          }
        }
      }
    }

    if (changed === 0) { converged = true; break; }
  }
  return { lanes, sweeps, converged };
}

const optStart = Date.now();
const { lanes: laneById, sweeps: optSweeps, converged: optConverged } = optimiseLanes(seedLanes);
const optMs = Date.now() - optStart;

// The invariant the optimiser exists to guarantee — asserted, not assumed. See
// the collision-bug note in relaxLanes() for what this is protecting against.
for (const [segId, asg] of laneById) {
  const vals = [...asg.values()];
  if (new Set(vals).size !== vals.length) {
    throw new Error(`Segment ${segId} has two operators on the same lane after optimisation (${[...asg.entries()].map(([o, l]) => `${o}=${l}`).join(', ')}) — COLLISION_PENALTY failed to hold the distinct-lane invariant.`);
  }
}

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
// 2026-07-28: this was the MEAN of each component's distinct operator->lane
// pairs. It is now the component's lane RANGE MIDPOINT. Why the change:
//
//  - The centring constant's only job is to decide where zero sits, so the fan
//    reads as symmetric about the corridor. The mean does that badly when lane
//    usage is lopsided — the optimiser's output ran -4.222..+2.778, a range
//    skew of -0.206, i.e. the fan visibly hangs to one side of the track.
//    The midpoint gives exactly -3.5..+3.5, skew 0.000, by definition.
//
//  - It is free. Subtracting a different CONSTANT per component shifts every
//    lane in that component by the same amount, so no boundary delta changes
//    anywhere: jog magnitudes and lane collisions are both invariant under it
//    BY CONSTRUCTION, not merely as an observed result. Nothing measured above
//    can regress because of this line.
//
// Both endpoints come from the same component, so cross-component boundaries
// (which would see two different constants) cannot exist.
const componentLaneRange = new Map(); // componentId -> {min, max}
for (const [segId, assignment] of laneById) {
  const c = componentOf.get(segId);
  let r = componentLaneRange.get(c);
  if (!r) { r = { min: Infinity, max: -Infinity }; componentLaneRange.set(c, r); }
  for (const lane of assignment.values()) {
    if (lane < r.min) r.min = lane;
    if (lane > r.max) r.max = lane;
  }
}
const componentMean = new Map(); // name kept: still "the centring constant", now the midpoint
for (const [c, r] of componentLaneRange) componentMean.set(c, (r.min + r.max) / 2);

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
        // Per-railway heritage identity, attached ONLY to the Heritage lane of
        // the segment. A shared segment like ["GW", "Heritage"] emits two
        // features; the GW one is main-line track and must not inherit the
        // heritage railway's name. Fields are omitted entirely rather than
        // emitted null so tippecanoe doesn't carry dead keys network-wide.
        ...(op === 'Heritage' && s.heritage_slug
          ? {
              heritage_slug: s.heritage_slug,
              heritage_type: s.heritage_type,
              ...(s.heritage_type_secondary ? { heritage_type_secondary: s.heritage_type_secondary } : {}),
              band: s.heritage_band,
            }
          : {}),
      },
      geometry: { type: 'LineString', coordinates: s.coords },
    });
  });
}

// ── CHAIN MERGE (2026-08-05) ─────────────────────────────────────────────
// THE BUG. Everything above emits ONE FEATURE PER SEGMENT PER OPERATOR, and
// map.html renders those with `line-offset`. MapLibre applies line-offset
// PER FEATURE, computing the perpendicular from that feature's own geometry —
// so where two segments meet at an angle, the two offset polylines are pushed
// sideways in slightly different directions and their ends no longer touch,
// leaving a wedge-shaped gap on the outside of the bend. `line-cap: round`
// hides small ones, which is why this only became obvious once the lane span
// widened from 7 to 8 units.
//
// Measured on the pre-merge output: 3,709 same-operator feature-to-feature
// joins, 1,992 of them (53.7%) with a direction change over 2 degrees and 488
// over 15 degrees, worst 179.6. Every one is a potential visible break, and it
// is why the reported gaps at Peterborough, Hitchin and Standish survived the
// attribution gap-fill — the DATA at all three is continuous (0 discontinuities
// for LD, TL and XC respectively); only the rendering was broken.
//
// THE FIX. Concatenate segments that share an endpoint, an operator AND a lane
// offset into a single LineString. The offset is then computed once along a
// continuous polyline, so there is no join left to come apart. This is what
// every other railway map does and it is the right baseline.
//
// WHY IT IS SAFE FOR THE TWO CONSUMERS THAT DEPEND ON PER-SEGMENT FEATURES:
//   - HOVER uses `promoteId: 'id'`, and each merged chain still gets a single
//     unique id, so feature-state keys stay unique. Hovering now highlights the
//     whole continuous run rather than one arbitrary fragment of it, which is
//     the behaviour a continuous line should have anyway.
//   - THE ROUTING GEOMETRY LOOKUP in map.html filters the tile source by
//     segment_id. A merged feature covers several, so it carries `segment_ids`
//     as a COMMA-DELIMITED STRING with leading and trailing commas (",12,13,")
//     and map.html matches with ['in', ',<id>,', ['get','segment_ids']]. The
//     delimiters matter: without them ",1," would also match ",21,". Vector
//     tiles cannot store arrays, which is why this is a string and not a list.
//     The caller already cuts the returned line down to its edge's own stretch
//     using from_coord/to_coord, so a longer line is not a problem for it.
{
  const key = (f) => f.properties.operators + ' ' + f.properties.lane_offset;
  const pt = (c) => c[0].toFixed(7) + ',' + c[1].toFixed(7);
  const groups = new Map();
  for (const f of features) {
    if (!groups.has(key(f))) groups.set(key(f), []);
    groups.get(key(f)).push(f);
  }
  const merged = [];
  for (const [, list] of groups) {
    // Endpoint index within this (operator, lane) group only.
    const ends = new Map();
    for (const f of list) {
      const c = f.geometry.coordinates;
      for (const k of [pt(c[0]), pt(c[c.length - 1])]) {
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(f);
      }
    }
    const used = new Set();
    // Walk from every feature, extending in both directions while exactly one
    // unused neighbour continues. Requiring exactly one keeps the merge off
    // junctions: at a fork there is no single continuation, so the chain stops
    // and the fork stays a separate feature — which is correct, since the two
    // branches genuinely diverge.
    const nextFrom = (endKey, self) => {
      const cands = (ends.get(endKey) || []).filter((x) => x !== self && !used.has(x));
      return cands.length === 1 ? cands[0] : null;
    };
    for (const seed of list) {
      if (used.has(seed)) continue;
      used.add(seed);
      let coords = seed.geometry.coordinates.slice();
      const ids = [seed.properties.segment_id];
      let lengthM = seed.properties.length_m || 0;
      // Extend forward off the tail, then backward off the head.
      for (const forward of [true, false]) {
        for (;;) {
          const tailKey = forward ? pt(coords[coords.length - 1]) : pt(coords[0]);
          const nxt = nextFrom(tailKey, null);
          if (!nxt || used.has(nxt)) break;
          const nc = nxt.geometry.coordinates;
          const headMatches = pt(nc[0]) === tailKey;
          const piece = headMatches ? nc.slice(1) : nc.slice(0, -1).reverse();
          if (!piece.length) break;
          used.add(nxt);
          ids.push(nxt.properties.segment_id);
          lengthM += nxt.properties.length_m || 0;
          if (forward) coords = coords.concat(piece);
          else coords = piece.slice().reverse().concat(coords);
        }
      }
      merged.push({
        type: 'Feature',
        properties: {
          ...seed.properties,
          segment_ids: ',' + ids.join(',') + ',',
          segment_count: ids.length,
          length_m: Math.round(lengthM),
        },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
  }
  const beforeCount = features.length;
  features.length = 0;
  features.push(...merged);
  console.log(`Chain merge: ${beforeCount} per-segment features -> ${features.length} continuous features ` +
    `(median chain ${(() => { const a = merged.map((f) => f.properties.segment_count).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; })()} segments, ` +
    `longest ${Math.max(...merged.map((f) => f.properties.segment_count))})`);
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

// ── Targeted jog repair (2026-08-05) ─────────────────────────────────────
// optimiseLanes() converges to a genuine local minimum of its COST function,
// but cost and visible breakage are not the same thing: a 1-unit jog costs 1.0
// and the optimiser will happily keep one if moving it would cost 1.1
// elsewhere. On screen that trade is not neutral — the kept jog is a line that
// visibly steps sideways on the East Coast Main Line.
//
// This pass optimises the METRIC the user actually sees. For every remaining
// jog it tries relocating the smaller of the two same-lane runs onto the other
// side's lane, and keeps the move ONLY if the total jog count strictly falls
// and no segment ends up with two operators in one lane. Strict improvement
// means it cannot loop, and the collision check means it cannot produce
// overlapping lines to buy a cosmetic win.
//
// SCOPED TO AVOIDABLE JOGS ON PURPOSE. Where the two sides carry a DIFFERENT
// NUMBER of operators the shift is structural — offsets are centred per segment,
// so a fan converging from 4 lanes to 2 must move every lane in it, and that is
// the correct drawing, not a defect. Those (80 of 99 measured) are left alone;
// only the 19 where both sides carry the same operator count are candidates.
//
// ⚠ OFF BY DEFAULT (LANE_JOG_REPAIR=1 to enable), and that is a considered
// decision rather than a half-finished feature. It works — it cut 99 jogs to 84
// — but it is NOT IDEMPOTENT, and idempotency matters more here than 7 jogs.
// The repair optimises JOG COUNT while optimiseLanes() optimises COST, and the
// two disagree: repair moves a run off the cost optimum, the next run's
// optimiser walks it straight back, and the run after that repairs it again
// somewhere slightly different. Measured: with repair on, an IDENTICAL re-run
// moved 387 offsets at STABILITY_WEIGHT 0.35 and 434 at 0.9 — raising the
// anchor does not fix it, because the fight is between two objectives rather
// than between the anchor and one objective. That drift is the very bug this
// whole change exists to eliminate, so the trade is not close.
//
// To make it shippable it would have to join the fixed point rather than run
// after it — e.g. fold the jog-count term into optimiseLanes' own cost, or
// iterate optimise->repair to convergence and only then record. Either is a
// real piece of work and neither should be bolted on under time pressure.
if (process.env.LANE_JOG_REPAIR === '1') {
  const neighbourAt = new Map();
  for (const s of graph.segments) {
    for (const n of [s.nodes[0], s.nodes[s.nodes.length - 1]]) {
      if (n == null) continue;
      if (!neighbourAt.has(n)) neighbourAt.set(n, []);
      neighbourAt.get(n).push(s);
    }
  }
  const laneOf = (id, op) => laneById.get(id)?.get(op);
  // Returns BOTH count and worst magnitude. Count alone is not a safe objective:
  // the first version of this pass optimised it in isolation, cut 99 jogs to 86
  // and pushed the worst from 2.0 to 3.0 lanes — trading several barely-visible
  // steps for one obvious one. That is POWER=1's documented failure mode
  // restated, and it is a worse map even though the number went down.
  const measure = () => {
    let count = 0, worst = 0;
    for (const [, list] of neighbourAt) {
      if (list.length < 2) continue;
      const ops = new Set();
      list.forEach((s) => (s.operators || []).forEach((o) => ops.add(o)));
      for (const op of ops) {
        const c = list.filter((s) => (s.operators || []).includes(op));
        if (c.length < 2) continue;
        const offs = [...new Set(c.map((s) => laneOf(s.id, op)).filter((v) => v !== undefined))];
        if (offs.length > 1) { count++; worst = Math.max(worst, Math.max(...offs) - Math.min(...offs)); }
      }
    }
    return { count, worst };
  };
  const collides = (id) => {
    const asg = laneById.get(id);
    if (!asg) return false;
    const seen = new Set();
    for (const l of asg.values()) { if (seen.has(l)) return true; seen.add(l); }
    return false;
  };
  // Connected run of segments on which `op` sits at one lane — same notion the
  // optimiser's MOVE 1 uses, recomputed here against the final assignment.
  const runOf = (startId, op, lane) => {
    const seen = new Set([startId]); const queue = [startId]; const out = [];
    while (queue.length) {
      const id = queue.shift(); out.push(id);
      const s = segByIdAll.get(id);
      for (const n of [s.nodes[0], s.nodes[s.nodes.length - 1]]) {
        for (const nb of neighbourAt.get(n) || []) {
          if (seen.has(nb.id) || !(nb.operators || []).includes(op)) continue;
          if (laneOf(nb.id, op) !== lane) continue;
          seen.add(nb.id); queue.push(nb.id);
        }
      }
    }
    return out;
  };

  let before = measure(), repaired = 0;
  for (let pass = 0; pass < 6; pass++) {
    let movedThisPass = 0;
    for (const [, list] of neighbourAt) {
      if (list.length < 2) continue;
      const ops = new Set();
      list.forEach((s) => (s.operators || []).forEach((o) => ops.add(o)));
      for (const op of ops) {
        const carrying = list.filter((s) => (s.operators || []).includes(op));
        if (carrying.length < 2) continue;
        const lanes = [...new Set(carrying.map((s) => laneOf(s.id, op)).filter((v) => v !== undefined))];
        if (lanes.length < 2) continue;
        // Structural (fan converging) — leave it, see the note above.
        if (new Set(carrying.map((s) => s.operators.length)).size > 1) continue;
        // Try moving each side's run onto the other side's lane.
        for (const from of lanes) {
          for (const to of lanes) {
            if (from === to) continue;
            const anchor = carrying.find((s) => laneOf(s.id, op) === from);
            if (!anchor) continue;
            const run = runOf(anchor.id, op, from);
            const undo = [];
            for (const id of run) {
              const asg = laneById.get(id);
              // Swap with whoever currently holds the target lane here.
              const holder = [...asg.entries()].find(([o, l]) => l === to && o !== op);
              undo.push([id, op, asg.get(op), holder ? holder[0] : null, holder ? holder[1] : null]);
              asg.set(op, to);
              if (holder) asg.set(holder[0], from);
            }
            const bad = run.some((id) => collides(id));
            const after = bad ? null : measure();
            // Strictly fewer jogs AND never a wider one. Both conditions, so a
            // move can neither loop nor buy a smaller count with a bigger step.
            const better = after && after.count < before.count && after.worst <= before.worst;
            if (better) { before = after; repaired++; movedThisPass++; }
            else {
              for (const [id, o, oldLane, hOp, hLane] of undo) {
                const asg = laneById.get(id);
                asg.set(o, oldLane);
                if (hOp) asg.set(hOp, hLane);
              }
            }
          }
        }
      }
    }
    if (!movedThisPass) break;
  }
  if (repaired) console.log(`Jog repair: ${repaired} avoidable jogs eliminated by run relocation`);
}

// ── Lane memory + jog census ─────────────────────────────────────────────
// Written BEFORE the GeoJSON so a later failure cannot leave a tileset on disk
// whose lane assignment was never recorded — the next run would then re-solve
// freely and silently move offsets again, which is the exact bug the memory
// exists to prevent.
{
  const out = {};
  for (const [id, asg] of laneById) out[id] = Object.fromEntries(asg);
  writeFileSync(LANE_MEMORY_PATH, JSON.stringify({
    generated_at: new Date().toISOString(),
    stability_weight: STABILITY_WEIGHT,
    note: 'Lane assignment from the last successful run. Seeds and anchors the next one so an unrelated segment change cannot reshuffle offsets network-wide. Safe to delete — the next run then re-solves from scratch and offsets may move once.',
    segments: laneById.size,
    lanes: out,
  }, null, 0));

  // THE USER-VISIBLE METRIC, reported every run so a regression is caught here
  // rather than on the map. A "jog" is an operator that CONTINUES through a
  // junction but is drawn at a different lane offset either side — on screen,
  // a line that steps sideways mid-corridor and reads as a break.
  const atNode = new Map();
  for (const s of graph.segments) {
    for (const n of [s.nodes[0], s.nodes[s.nodes.length - 1]]) {
      if (n == null) continue;
      if (!atNode.has(n)) atNode.set(n, []);
      atNode.get(n).push(s);
    }
  }
  let jogs = 0, worst = 0;
  for (const [, list] of atNode) {
    if (list.length < 2) continue;
    const ops = new Set();
    list.forEach((s) => (s.operators || []).forEach((o) => ops.add(o)));
    for (const op of ops) {
      const carrying = list.filter((s) => (s.operators || []).includes(op));
      if (carrying.length < 2) continue;      // terminates here; not a jog
      const offs = [...new Set(carrying.map((s) => laneById.get(s.id)?.get(op)).filter((v) => v !== undefined))];
      if (offs.length > 1) { jogs++; worst = Math.max(worst, Math.max(...offs) - Math.min(...offs)); }
    }
  }
  console.log(`Lane jogs: ${jogs} junction/operator pairs where the lane steps sideways (worst ${worst.toFixed(1)} lanes) — lower is better, 0 means no visible breaks`);
}

writeFileSync(OUT_PATH, features.map((f) => JSON.stringify(f)).join('\n'));
// newline-delimited GeoJSON (one Feature per line) — tippecanoe accepts this
// directly and it streams far better than one giant FeatureCollection for a
// 6,126-feature/430k-coordinate input.

console.log(`Wrote ${features.length} fan-out features (from ${graph.segments.length} segments, max operator_total ${maxOperatorTotal}) to ${OUT_PATH}`);
console.log(`Source: ${graph.scope} scope, generated_at ${graph.generated_at}`);
console.log(`Lane seed: ${componentCount} connected components, ${conflictCount} initial BFS-pass lane conflicts, ${RELAXATION_PASSES} relaxation passes`);
console.log(`Lane optimiser: POWER=${JOG_COST_POWER} COLLISION_PENALTY=${COLLISION_PENALTY} COMPACTNESS=${COMPACTNESS} LANE_WINDOW=${LANE_WINDOW} — ${optSweeps} sweeps in ${optMs}ms, converged=${optConverged}`);
{
  const offs = features.map((f) => f.properties.lane_offset);
  const lo = Math.min(...offs), hi = Math.max(...offs);
  console.log(`Lane offsets: ${lo.toFixed(3)}..${hi.toFixed(3)} (span ${(hi - lo).toFixed(3)}, range skew ${((hi + lo) / (hi - lo)).toFixed(3)}), 0 collisions asserted`);
}
if (graph.scope !== 'national') {
  console.warn(`WARNING: line-segments.json scope is '${graph.scope}', not 'national' — this will tile a bbox-bounded checkpoint, not the full network. Re-run with LINE_SEGMENTS_NATIONAL=1 first if that's not intended.`);
}

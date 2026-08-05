#!/usr/bin/env node
/**
 * fill-operator-gaps.mjs — closes HOLES in an operator's attributed network by
 * routing between its own endpoints on the existing routing graph.
 *
 * THE DEFECT. Selecting CrossCountry in Database mode draws its network red and
 * leaves plain grey track in the middle of it — at York, XC's segments end
 * against neighbours tagged [NT+TP], [GC] and [GC+TP] that carry no XC at all,
 * even though CrossCountry demonstrably runs through York. The cause is the same
 * one behind the six missing branches: OSM route relations are the only source
 * of attribution, and their coverage has holes. This does not invent geometry —
 * every segment involved already exists and is already drawn.
 *
 * WHY NOT THE OBVIOUS RULE. The first attempt was topological: any chain of
 * non-carrying segments joining two carrying ones is a hole. On a dense network
 * that connects almost anything — measured 2,819 "holes" totalling 11,505 km,
 * half the network, including a 108 km "hole" for Stansted Express. Filling on
 * that basis would paint operators onto track they never touch, which is far
 * worse than a visible gap. That rule was measured, rejected and is not used.
 *
 * WHAT THIS DOES INSTEAD. For each node where an operator ARRIVES BUT DOES NOT
 * CONTINUE, a bounded Dijkstra over data/routing-graph.json looks for the
 * nearest other node carrying that operator. The gap is filled only if the whole
 * path clears three independent limits:
 *
 *   MAX_GAP_M     the path is short in absolute terms
 *   MAX_DETOUR    the path is not much longer than the straight line between
 *                 its ends — a long way round means the two ends are not really
 *                 the same corridor, which is exactly how the topological rule
 *                 wandered onto unrelated track
 *   MAX_SEGMENTS  the chain is a handful of segments, not a route of its own
 *
 * Anything that fails a limit is LEFT ALONE and counted. An operator that simply
 * terminates somewhere is not a hole and is never extended — that would invent
 * route coverage, which is the one thing this must not do.
 *
 * PROVENANCE. Filled attribution is INFERRED — no relation asserts it — so every
 * touched segment gets operator_precision[op] = 'inferred', the same marking
 * ingest-branch-ways.mjs uses and the same one dedupe-line-segments.mjs knows to
 * union. A segment already carrying that operator from a relation is never
 * downgraded.
 *
 * Usage:
 *   node scripts/fill-operator-gaps.mjs --dry-run
 *   node scripts/fill-operator-gaps.mjs --dry-run --only=XC
 *   node scripts/fill-operator-gaps.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const RG_PATH = path.join(__dirname, '..', 'data', 'routing-graph.json');
const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const MAX_GAP_M = 12000;    // 12 km. A missing stretch inside a network is short;
                            // anything longer is a route the operator does not run.
const MAX_DETOUR = 1.8;     // path length / straight-line distance between its ends.
const MAX_SEGMENTS = 6;     // chain depth.

const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
const rg = JSON.parse(readFileSync(RG_PATH, 'utf8'));
const segById = new Map(graph.segments.map((s) => [s.id, s]));

const R = 6371000, rad = (d) => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const coordOf = (n) => rg.node_coord[n] || rg.node_coord[String(n)] || null;

// Which routing-graph nodes touch a segment carrying operator `op`.
function nodesCarrying(op) {
  const out = new Set();
  for (const [node, edges] of Object.entries(rg.nodes)) {
    for (const e of edges) {
      const sid = e.edge && e.edge.segment_id;
      if (sid == null) continue;
      const s = segById.get(sid);
      if (s && (s.operators || []).includes(op)) { out.add(node); break; }
    }
  }
  return out;
}

/** Bounded Dijkstra from `start`, stopping at the first node in `targets`. */
function findGap(start, targets, op) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  // Small graph + tight bound, so a sorted-array frontier is fine here.
  const frontier = [[0, start]];
  while (frontier.length) {
    frontier.sort((a, b) => a[0] - b[0]);
    const [d, node] = frontier.shift();
    if (d > MAX_GAP_M) return null;
    if (node !== start && targets.has(node)) {
      const chain = [];
      let cur = node;
      while (prev.has(cur)) { const [p, sid] = prev.get(cur); if (sid != null) chain.push(sid); cur = p; }
      return { end: node, length: d, segments: [...new Set(chain)] };
    }
    for (const e of rg.nodes[node] || []) {
      const sid = e.edge && e.edge.segment_id;
      const s = sid == null ? null : segById.get(sid);
      // Never route THROUGH track the operator already has — that is not a gap.
      if (s && (s.operators || []).includes(op) && node !== start) continue;
      const nd = d + (e.length_m || 0);
      if (nd > MAX_GAP_M) continue;
      if (dist.has(e.to) && dist.get(e.to) <= nd) continue;
      dist.set(e.to, nd);
      prev.set(e.to, [node, sid]);
      frontier.push([nd, e.to]);
    }
  }
  return null;
}

// SCOPED TO REAL TOCs. Metro/tram systems, the London Underground lines and the
// Heritage category are deliberately excluded, and the dry run is why: District
// came out at +62 km against a 110 km existing network, which is not a gap fill,
// it is a rewrite. Tube and tram lines share track with each other far more
// densely than TOCs do, so "the nearest node carrying this operator" is a much
// weaker signal there — the Circle/District/H&C corridors are largely the same
// rails, and a gap in one is usually genuinely another line's track. Heritage is
// not an operator at all but a category shared by ~175 unrelated railways, so
// bridging between two of them would be meaningless. If metro coverage needs
// improving it needs its own rule, not this one.
const colors = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'operator-colors.json'), 'utf8'));
const TOC_KEYS = new Set(Object.keys(colors.toc || {}).filter((k) => !k.startsWith('_')));
const operators = [...new Set(graph.segments.flatMap((s) => s.operators || []))]
  .filter((op) => TOC_KEYS.has(op))
  .filter((op) => !ONLY || op === ONLY);

const report = [];
let filledSegs = 0, filledKm = 0, rejected = { tooLong: 0, detour: 0, tooDeep: 0 };

for (const op of operators) {
  const carrying = graph.segments.filter((s) => (s.operators || []).includes(op));
  if (carrying.length < 2) continue;
  const opNodes = nodesCarrying(op);
  // Nodes where the operator arrives but does not continue.
  const dead = [];
  for (const node of opNodes) {
    const edges = rg.nodes[node] || [];
    if (edges.length < 2) continue;                       // genuine line end
    const withOp = edges.filter((e) => {
      const s = segById.get(e.edge && e.edge.segment_id);
      return s && (s.operators || []).includes(op);
    });
    if (withOp.length < edges.length && withOp.length >= 1) dead.push(node);
  }
  const touched = new Set();
  let opSegs = 0, opKm = 0;
  for (const node of dead) {
    const hit = findGap(node, opNodes, op);
    if (!hit) continue;
    if (hit.segments.length > MAX_SEGMENTS) { rejected.tooDeep++; continue; }
    const a = coordOf(node), b = coordOf(hit.end);
    if (a && b) {
      const straight = metres(a, b);
      if (straight > 0 && hit.length / straight > MAX_DETOUR) { rejected.detour++; continue; }
    }
    for (const sid of hit.segments) {
      if (touched.has(sid)) continue;
      const s = segById.get(sid);
      if (!s || (s.operators || []).includes(op)) continue;
      touched.add(sid);
      opSegs++; opKm += s.length_m / 1000;
      if (!DRY) {
        s.operators = [...s.operators, op];
        s.operator_precision = { ...(s.operator_precision || {}), [op]: 'inferred' };
        s.gap_filled = true;
      }
    }
  }
  if (opSegs) {
    report.push({ op, segments: opSegs, km: +opKm.toFixed(1), deadEnds: dead.length });
    filledSegs += opSegs; filledKm += opKm;
    console.log(`  ${op.padEnd(22)} ${String(opSegs).padStart(4)} segments  ${opKm.toFixed(1).padStart(8)} km  (from ${dead.length} discontinuities)`);
  }
}

console.log(`\nTotal: ${filledSegs} segment-attributions added, ${filledKm.toFixed(1)} km`);
console.log(`Rejected by guard: ${rejected.detour} detour, ${rejected.tooDeep} too many segments`);
if (DRY) { console.log('DRY RUN — line-segments.json untouched.'); process.exit(0); }
graph.gap_fill = { generated_at: new Date().toISOString(), max_gap_m: MAX_GAP_M, max_detour: MAX_DETOUR, max_segments: MAX_SEGMENTS, filled: report };
writeFileSync(SEG_PATH, JSON.stringify(graph));
console.log('Written:', SEG_PATH);

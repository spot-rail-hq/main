#!/usr/bin/env node
/**
 * fill-operator-gaps.mjs — closes SHORT HOLES in an operator's attributed
 * network, so a selected operator draws as a continuous line.
 *
 * THE DEFECT. Selecting an operator in Database mode drew its network with small
 * breaks in it — grey base track showing through an otherwise continuous
 * coloured line, at Cambridge, Battersea, York, Shortlands and many other
 * places. The cause is that OSM route relations are the sole source of
 * attribution, and relations routinely omit the short connecting pieces between
 * the long running lines they do cover: junction stubs, crossovers, platform
 * links. No geometry is missing — the segment is already there and already
 * drawn — only the operator list on it is incomplete.
 *
 * THE RULE. A segment is filled only if ALL of these hold:
 *   1. it does not already carry the operator;
 *   2. it has a neighbour carrying that operator at EACH END — so the operator
 *      demonstrably arrives on one side and leaves on the other, and the
 *      segment sits inside its network rather than extending it;
 *   3. it is shorter than MAX_STUB_M.
 *
 * The measurement that produced this rule: 974 segments are sandwiched with a
 * carrier at both ends, and 730 of them are UNDER 100 METRES. That distribution
 * is the whole finding — these are stubs, not routes. Capped at 2 km it is 929
 * segments and 121.5 km, about 0.5% of the network's 22,742 km.
 *
 * TWO EARLIER RULES WERE MEASURED AND REJECTED, recorded so neither is retried:
 *
 *   - ANY chain of non-carrying segments joining two carriers (depth <= 4).
 *     On a dense network this connects almost anything: 2,819 "holes" totalling
 *     11,505 km, half the network, including a 108 km "hole" for Stansted
 *     Express. It would paint operators onto track they never touch.
 *   - BOUNDED DIJKSTRA between an operator's own endpoints. Better behaved
 *     (314 segments / 863 km) but it did NOT fix the reported York case, and
 *     because it mutated the graph as it went, results depended on operator
 *     iteration order — a dry run said 314 segments where the live run produced
 *     209. Both disqualifying.
 *
 * ORDER-INDEPENDENT BY CONSTRUCTION. Every fill is decided against the ORIGINAL
 * operator lists and applied only afterwards, so no operator can see another
 * operator's fills and the output does not depend on iteration order. This is
 * the specific bug that sank the Dijkstra version.
 *
 * WHAT IT WILL NOT DO. It never extends an operator past the end of its network
 * (that needs a carrier at BOTH ends), and it never bridges a long gap — the
 * 12 km "hole" at Shortlands is a real route the operator does not run, and the
 * length cap is what keeps it out. Filling either would invent service.
 *
 * PROVENANCE. No relation asserts these, so every fill sets
 * operator_precision[op] = 'inferred' — the same marking ingest-branch-ways.mjs
 * uses and dedupe-line-segments.mjs knows to union. A relation-sourced
 * attribution is never touched or downgraded.
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
const DRY = process.argv.includes('--dry-run');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

// 2 km. Chosen from the measured distribution, not picked round: 730 of 974
// sandwiched segments are under 100 m and only 31 are over 5 km, so the cap sits
// in the empty space between "stub" and "route". Raising it past ~5 km starts
// admitting real alternative routes such as the 12 km Shortlands case.
const MAX_STUB_M = 2000;

const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
const segs = graph.segments;

// Endpoint index. Junctions only ever occur at segment endpoints (see
// build-line-segments.mjs), so this is the complete adjacency.
const atNode = new Map();
for (const s of segs) {
  for (const n of [s.nodes[0], s.nodes[s.nodes.length - 1]]) {
    if (n == null) continue;
    if (!atNode.has(n)) atNode.set(n, []);
    atNode.get(n).push(s);
  }
}
// Snapshot of the ORIGINAL operator lists — every decision reads this, never the
// mutating segment objects. See "order-independent" above.
const originalOps = new Map(segs.map((s) => [s.id, new Set(s.operators || [])]));
const carriesAt = (node, op, selfId) =>
  (atNode.get(node) || []).some((x) => x.id !== selfId && originalOps.get(x.id).has(op));

const operators = [...new Set(segs.flatMap((s) => s.operators || []))].filter((op) => !ONLY || op === ONLY);
const plan = [];   // {seg, op}
for (const s of segs) {
  if (s.length_m > MAX_STUB_M) continue;
  const a = s.nodes[0], b = s.nodes[s.nodes.length - 1];
  if (a == null || b == null || a === b) continue;      // loop/spur: no "both ends"
  for (const op of operators) {
    if (originalOps.get(s.id).has(op)) continue;
    if (!carriesAt(a, op, s.id) || !carriesAt(b, op, s.id)) continue;
    plan.push({ seg: s, op });
  }
}

const byOp = {};
for (const p of plan) {
  byOp[p.op] = byOp[p.op] || { n: 0, km: 0 };
  byOp[p.op].n++; byOp[p.op].km += p.seg.length_m / 1000;
}
for (const [op, v] of Object.entries(byOp).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${op.padEnd(22)} ${String(v.n).padStart(4)} segments ${v.km.toFixed(1).padStart(8)} km`);
}
const totalKm = plan.reduce((t, p) => t + p.seg.length_m / 1000, 0);
console.log(`\nTotal: ${plan.length} segment-attributions, ${totalKm.toFixed(1)} km (cap ${MAX_STUB_M} m per segment)`);
const lens = plan.map((p) => p.seg.length_m).sort((a, b) => a - b);
if (lens.length) {
  console.log(`Filled-segment length: median ${Math.round(lens[Math.floor(lens.length / 2)])} m, max ${Math.round(lens[lens.length - 1])} m`);
}
if (DRY) { console.log('DRY RUN — line-segments.json untouched.'); process.exit(0); }

for (const { seg, op } of plan) {
  seg.operators = [...seg.operators, op];
  seg.operator_precision = { ...(seg.operator_precision || {}), [op]: 'inferred' };
  seg.gap_filled = true;
}
graph.gap_fill = {
  generated_at: new Date().toISOString(),
  rule: 'depth-1 sandwiched stub: no carrier on this segment, a carrier at BOTH endpoints, length <= max_stub_m',
  max_stub_m: MAX_STUB_M,
  attributions: plan.length,
  km: +totalKm.toFixed(1),
  by_operator: Object.fromEntries(Object.entries(byOp).map(([k, v]) => [k, { segments: v.n, km: +v.km.toFixed(1) }])),
};
writeFileSync(SEG_PATH, JSON.stringify(graph));
console.log('Written:', SEG_PATH);

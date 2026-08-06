#!/usr/bin/env node
/**
 * scripts/build-graph-bridges.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Finds coordinate-proximity bridge edges to reconnect routing-graph islands
 * that are topologically disconnected from the main graph due to OSM node-ID
 * mismatches at complex station throats (the same class of issue found for
 * LNER/Grand Central at Doncaster in Phase 2, and confirmed concretely for
 * Manchester Piccadilly via a live Overpass check: a `railway=buffer_stop`
 * node ~26m from the station's own stop-position node, never node-sharing
 * with it) — NOT real physical gaps.
 *
 * 2026-07-26 REWRITE — was an explicit 8-anchor allow-list, tag-checked
 * against a local Overpass instance. Two problems with that:
 *   1. Coverage. It only ever bridged the eight islands someone had already
 *      investigated by hand. A full sweep of the graph found ~30 more
 *      station-bearing islands sitting 2-90m from the main network — the
 *      Greenford branch, Emerson Park, Windermere, the Looe/Newquay
 *      branches, Bishop's Stortford's neighbours and so on — each one a set
 *      of stations that silently returned "no direct route found" for every
 *      journey.
 *   2. The mode guard needed a local Overpass instance running on :12345,
 *      so the whole step was un-runnable without one. It also asked a
 *      weaker question than it could: whether a single OSM NODE carries a
 *      tram/subway tag. The segment graph already knows which OPERATORS run
 *      over every piece of track either side of a candidate gap — strictly
 *      better evidence, and available offline.
 *
 * So: sweep every island, and accept the closest cross-component node pair
 * that passes ALL of:
 *   - both sides are the same MODE (heavy rail vs. light rail/tram/metro,
 *     derived from the operators on the track meeting at each node) — this
 *     is what stops the Manchester Airport false positive the old header
 *     describes, where the nearest node pair was a Metrolink tram
 *     stop-position 13m from the heavy-rail one;
 *   - the gap is within THRESHOLD_M;
 *   - the island actually carries a station (a stray 2-node fragment of
 *     siding with no station on it changes no route, so there's nothing to
 *     gain by welding it on and a false positive would be pure downside).
 * Everything rejected or left over is printed with its measured gap, so the
 * genuinely-missing-data cases stay visible instead of being papered over.
 *
 * Run: node scripts/build-graph-bridges.mjs
 * Output: scripts/output/graph-bridges.json — consumed by
 * build-routing-graph.mjs to inject the bridge edges. Run it BEFORE
 * build-routing-graph.mjs; it reads the graph that build wrote last time for
 * its node/coordinate list, but recomputes components with previously
 * injected bridge edges EXCLUDED (see computeComponents) so repeated runs
 * converge on the same answer instead of un-bridging their own work.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROUTING_GRAPH_PATH = path.join(ROOT, 'data', 'routing-graph.json');
const SEGMENTS_PATH = path.join(__dirname, 'output', 'line-segments.json');
const STATION_LINKS_PATH = path.join(__dirname, 'output', 'station-graph-links.json');
const OPERATOR_COLORS_PATH = path.join(ROOT, 'data', 'operator-colors.json');
const OUT_PATH = path.join(__dirname, 'output', 'graph-bridges.json');

// Measured gaps over every station-bearing island: a dense run from 2m to
// 143m, then 293m, then straight to kilometres. 150m takes the whole dense
// run — each of its top three was checked individually and is a junction
// throat with the SAME operator either side (Par ↔ the Newquay branch
// 143m, Penistone 119m, Broxbourne 119m) — and stops before the 293m case.
// Past that the gaps are real missing track (a line the Phase 2 Overpass
// run never ingested — Harrogate line, Bittern line, Marlow branch), where
// welding a straight line across would draw a route over ground no train
// uses. Those are reported, not bridged.
const THRESHOLD_M = 150;
const CANDIDATE_SEARCH_RADIUS_M = 150; // slightly wider than the threshold so the report can show near-misses

// Islands where the mode guard is deliberately waived, by a station on the
// island. Reviewed one at a time — this is an escape hatch for "the physical
// connection is real but the only ingested track either side of it belongs
// to a different mode", never a general relaxation.
const MODE_GUARD_WAIVERS = {
  // c2c / London, Tilbury & Southend (38 stations, Fenchurch Street to
  // Shoeburyness, plus the Gospel Oak–Barking line). Every contact this
  // network has with the rest of the ingested graph is District/
  // Hammersmith & City track through the shared Barking throat — the real
  // heavy-rail junctions (Barking ↔ the Gospel Oak line, Gospel Oak ↔ the
  // North London Line) are simply not in the Phase 2 segment graph, so the
  // nearest mode-matched node is 290m away across ground with no junction
  // on it. This 17m weld at Barking is the pre-existing, previously
  // hand-reviewed bridge for this island; without it all 38 stations return
  // "no direct route" for every journey. Revisit when a re-ingest brings
  // the Barking junctions in.
  BKG: 'Barking — LTS/District shared throat; real heavy-rail junction not in the segment graph',
};

function loadJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Components of the RAW topology: bridge edges injected by a previous run
// are skipped, so this always sees the same real OSM connectivity no matter
// how many times it has run before. Without that, the sweep would find the
// already-bridged islands sitting inside the giant component, decide they
// need no bridge, and write them out of existence — every previously
// reconnected network (the South Wales Valleys, c2c, the Highlands…) would
// silently strand itself again on the next run.
function computeComponents(nodes) {
  const visited = new Set();
  const components = [];
  for (const nodeId of Object.keys(nodes)) {
    if (visited.has(nodeId)) continue;
    const queue = [nodeId];
    visited.add(nodeId);
    const comp = [];
    while (queue.length) {
      const cur = queue.pop();
      comp.push(cur);
      for (const e of nodes[cur] || []) {
        if (e.edge && e.edge.type === 'bridge') continue;
        const to = String(e.to);
        if (!visited.has(to)) { visited.add(to); queue.push(to); }
      }
    }
    components.push(comp);
  }
  return components;
}

const rg = loadJson(ROUTING_GRAPH_PATH);
const graph = loadJson(SEGMENTS_PATH);
const stationLinks = loadJson(STATION_LINKS_PATH);
const operatorColors = loadJson(OPERATOR_COLORS_PATH);

// ─── mode of every graph node, from the track that meets at it ──────────────
// Same LIGHT/HEAVY split build-station-graph-links.mjs uses: the 11
// Underground lines + DLR + every tram/metro system are light; TOC codes,
// Heritage and the Overground lines are heavy rail.
const TUBE_LINES = ['Bakerloo', 'Central', 'Circle', 'District', 'Hammersmith & City', 'Jubilee', 'Metropolitan', 'Northern', 'Piccadilly', 'Victoria', 'Waterloo & City'];
const LIGHT_TOKENS = new Set([...TUBE_LINES, 'DLR', 'Docklands Light Railway', ...Object.keys(operatorColors.metro || {})]);

const nodeOperators = new Map(); // graph node id (string) -> Set of operator tokens
function addNodeOps(nodeId, ops) {
  const key = String(nodeId);
  if (!nodeOperators.has(key)) nodeOperators.set(key, new Set());
  const set = nodeOperators.get(key);
  for (const o of ops) set.add(o);
}
const segById = new Map(graph.segments.map((s) => [s.id, s]));
for (const seg of graph.segments) {
  // Every node ALONG the segment, not just its endpoints: a station node
  // splits a segment mid-way, and the split's interior graph nodes are real
  // routing nodes that a bridge can legitimately land on.
  for (const n of seg.nodes) addNodeOps(n, seg.operators);
}
for (const r of stationLinks.results) {
  if (!r.snapped || r.segment_id === null) continue;
  const seg = segById.get(r.segment_id);
  if (seg) addNodeOps('S:' + r.crs, seg.operators);
}
function nodeIsHeavy(nodeId) {
  const ops = nodeOperators.get(String(nodeId));
  if (!ops || ops.size === 0) return null; // unknown — treated as "no evidence", see modesCompatible()
  for (const o of ops) if (!LIGHT_TOKENS.has(o)) return true;
  return false;
}
// Unknown mode on one side is not evidence of a mismatch, but it IS a
// reason not to trust a bridge blindly, so it's reported alongside.
function modesCompatible(a, b) {
  const ma = nodeIsHeavy(a), mb = nodeIsHeavy(b);
  if (ma === null || mb === null) return { ok: true, confidence: 'unknown-mode' };
  return { ok: ma === mb, confidence: ma === mb ? 'mode-matched' : 'mode-mismatch' };
}

let components = computeComponents(rg.nodes);
components.sort((a, b) => b.length - a.length);
console.log(`Giant component: ${components[0].length} nodes (of ${components.length} total components)`);

// ─── MULTI-HOP CHAINING (2026-08-06) ──────────────────────────────────────
// The original version below searched each island against ONLY the giant
// component's nodes, one hop, once. That is provably not enough: Pontefract
// Baghill's island reaches the giant component in 4 real hops of 2-4m each,
// via THREE intermediate islands (22, 9 and 30 nodes) that carry no station
// of their own — each is a genuine node-ID mismatch at a real junction
// throat, same class of issue as every other bridge here, just chained
// instead of single. The old single-hop-against-giant search reported this
// as "gap-too-large, closest >150m" (candidates.length === 0) because the
// one node that actually was ~3m away was never in `giant` at all — it was
// sitting in the very next island over, which the search never looked at.
//
// Two changes fix this without touching the mode/threshold/waiver logic
// that already works for the 28 existing single-hop bridges:
//   1. Search against ANY node not in the current island's (dynamically
//      updated) component, not just `giant`.
//   2. After finding and accepting a hop, MERGE the two components in
//      memory and continue the same island's search from its new, larger
//      component — repeating until it reaches the giant component or the
//      next-nearest candidate exceeds THRESHOLD_M.
// A station-less island is still never a *starting point* for its own
// search (nothing to gain bridging FROM empty track on its own initiative,
// same reasoning as before) — but it is now a valid *stepping stone* when
// it happens to be the nearest thing to a real station's island, which is
// exactly the Baghill case.
const CELL_DEG = 0.005; // ~350-550m — comfortably wider than the search radius
function buildGrid(nodeIds) {
  const grid = new Map();
  const cellKey = (lon, lat) => Math.floor(lon / CELL_DEG) + ',' + Math.floor(lat / CELL_DEG);
  for (const id of nodeIds) {
    const c = rg.node_coord[id];
    if (!c) continue;
    const key = cellKey(c[0], c[1]);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ id, c });
  }
  return { grid, cellKey };
}
function nearbyNodes({ grid, cellKey }, lon, lat) {
  const [cx, cy] = cellKey(lon, lat).split(',').map(Number);
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const bucket = grid.get((cx + dx) + ',' + (cy + dy));
    if (bucket) out.push(...bucket);
  }
  return out;
}

const bridges = [];
const report = [];
const MAX_HOPS = 60; // empirically: everything that CAN chain to giant does so in <=40 hops; raising to 200 found nothing extra (BUC/BYA/CNY/REE genuinely hits a >150m wall partway, not a hop-count problem)
// Islands whose chase already failed (gap-too-large / rejected-mode) — key
// is the sorted station list, since compIdx is renumbered by every merge.
// Without this, the outer loop would re-pick and re-fail the same island
// forever: a failed chase's provisional edges are rolled back, so the
// island is still there, still station-bearing, and still first in
// component order on the next pass.
const givenUp = new Set();

for (;;) {
  const nodeToComponent = new Map();
  components.forEach((c, i) => c.forEach((n) => nodeToComponent.set(n, i)));
  const stationsByComponent = new Map();
  for (const [crs, node] of Object.entries(rg.station_node)) {
    if (!node) continue;
    const c = nodeToComponent.get(String(node));
    if (c === undefined) continue;
    if (!stationsByComponent.has(c)) stationsByComponent.set(c, []);
    stationsByComponent.get(c).push(crs);
  }

  // Pick the next not-yet-resolved, not-yet-given-up station-bearing island
  // (skip index 0, the giant component). Re-derived every outer pass
  // because merges renumber components.
  let compIdx = -1;
  for (let i = 1; i < components.length; i++) {
    const st = stationsByComponent.get(i) || [];
    if (st.length && !givenUp.has(st.slice().sort().join(','))) { compIdx = i; break; }
  }
  if (compIdx === -1) break; // every station-bearing island resolved or given up

  const originalStations = stationsByComponent.get(compIdx);
  const startCompIdx = compIdx;
  const startIslandSize = components[compIdx].length;
  const chainBridges = [];
  let hop = 0;
  let finalResult = null, finalDetail = null, finalClosestM = null;

  for (;;) {
    hop++;
    // All OTHER nodes, grouped by grid cell, excluding the current island's
    // own (possibly already-merged) component.
    const curIsland = components[compIdx];
    const curSet = new Set(curIsland);
    const otherIds = [];
    for (let i = 0; i < components.length; i++) {
      if (i === compIdx) continue;
      for (const n of components[i]) otherIds.push(n);
    }
    const idx = buildGrid(otherIds);

    const candidates = [];
    for (const id of curIsland) {
      const c = rg.node_coord[id];
      if (!c) continue;
      for (const g of nearbyNodes(idx, c[0], c[1])) {
        const d = haversineMeters(c, g.c);
        if (d <= CANDIDATE_SEARCH_RADIUS_M) candidates.push({ from: id, to: g.id, distM: d });
      }
    }
    candidates.sort((a, b) => a.distM - b.distM);
    if (hop === 1) finalClosestM = candidates.length ? Math.round(candidates[0].distM * 10) / 10 : null;

    const waiverCrs = originalStations.find((crs) => MODE_GUARD_WAIVERS[crs]);
    let chosen = null, rejection = null;
    for (const c of candidates) {
      if (c.distM > THRESHOLD_M) break;
      const mode = modesCompatible(c.from, c.to);
      if (!mode.ok) {
        rejection = rejection || `mode mismatch at ${c.from} <-> ${c.to} (${Math.round(c.distM)}m): ${[...(nodeOperators.get(String(c.from)) || [])].join('/')} vs ${[...(nodeOperators.get(String(c.to)) || [])].join('/')}`;
        if (!waiverCrs) continue;
        chosen = { ...c, confidence: 'mode-crossing-waived', waiver: MODE_GUARD_WAIVERS[waiverCrs] };
        break;
      }
      chosen = { ...c, confidence: mode.confidence };
      break;
    }

    if (!chosen) {
      finalResult = candidates.length && candidates[0].distM <= THRESHOLD_M ? 'rejected-mode' : 'gap-too-large';
      finalDetail = rejection;
      break;
    }

    chainBridges.push({
      from: chosen.from, to: chosen.to,
      distM: Math.round(chosen.distM * 100) / 100,
      confidence: chosen.confidence, waiver: chosen.waiver || null,
      fromOperators: [...(nodeOperators.get(String(chosen.from)) || [])],
      toOperators: [...(nodeOperators.get(String(chosen.to)) || [])],
    });

    // Merge in memory (as a real 'segment'-type edge for component purposes
    // — computeComponents() only skips 'bridge'-type edges so a NEWLY
    // proposed hop must count as connected while we keep chasing, exactly
    // like the real bridge edge build-routing-graph.mjs will inject later)
    // and continue the SAME island's search from its enlarged component.
    if (!rg.nodes[chosen.from]) rg.nodes[chosen.from] = [];
    if (!rg.nodes[chosen.to]) rg.nodes[chosen.to] = [];
    rg.nodes[chosen.from].push({ to: chosen.to, length_m: chosen.distM, edge: { type: 'segment' } });
    rg.nodes[chosen.to].push({ to: chosen.from, length_m: chosen.distM, edge: { type: 'segment' } });
    components = computeComponents(rg.nodes);
    components.sort((a, b) => b.length - a.length);
    const newNodeToComponent = new Map();
    components.forEach((c, i) => c.forEach((n) => newNodeToComponent.set(n, i)));
    compIdx = newNodeToComponent.get(String(originalStations && rg.station_node[originalStations[0]]));

    if (compIdx === 0) { finalResult = 'bridged'; break; } // reached the giant component
    if (hop >= MAX_HOPS) { finalResult = 'gap-too-large'; finalDetail = `stopped after ${MAX_HOPS} hops without reaching the giant component`; break; }
  }

  if (finalResult === 'bridged') {
    for (const b of chainBridges) {
      bridges.push({
        anchor: originalStations.join(','),
        crs: originalStations[0],
        from: b.from, to: b.to, distM: b.distM,
        confidence: b.confidence, waiver: b.waiver,
        fromOperators: b.fromOperators, toOperators: b.toOperators,
      });
    }
    report.push({
      compIdx: startCompIdx, islandSize: startIslandSize, stations: originalStations, closestM: finalClosestM,
      result: chainBridges.length > 1 ? 'bridged-multi-hop' : 'bridged',
      detail: chainBridges.map((b) => `${b.from} <-> ${b.to} (${Math.round(b.distM)}m, ${b.confidence})`).join(' -> '),
    });
  } else {
    // Roll back any provisional in-memory hops from this failed chase so
    // they don't leak into the next island's search or the final component
    // list — recompute fresh from the untouched rg.nodes state is simplest,
    // but rg.nodes was mutated above. Rebuild by dropping every synthetic
    // edge this chase added (they are exactly chainBridges' from/to pairs).
    for (const b of chainBridges) {
      rg.nodes[b.from] = rg.nodes[b.from].filter((e) => !(e.to === b.to && e.edge.type === 'segment' && e.length_m === b.distM));
      rg.nodes[b.to] = rg.nodes[b.to].filter((e) => !(e.to === b.from && e.edge.type === 'segment' && e.length_m === b.distM));
    }
    components = computeComponents(rg.nodes);
    components.sort((a, b) => b.length - a.length);
    givenUp.add(originalStations.slice().sort().join(','));
    report.push({
      compIdx: startCompIdx, islandSize: startIslandSize, stations: originalStations, closestM: finalClosestM,
      result: finalResult, detail: finalDetail,
    });
  }
}

writeFileSync(OUT_PATH, JSON.stringify({
  generated_at: new Date().toISOString(),
  threshold_m: THRESHOLD_M,
  bridges,
  unbridged: report.filter((r) => r.result !== 'bridged' && r.result !== 'bridged-multi-hop' && r.result !== 'skipped-no-stations'),
}, null, 2) + '\n');

console.log('\n=== Bridged ===');
for (const b of bridges) console.log(`  ${b.distM}m  ${b.from} <-> ${b.to}  [${b.confidence}]  stations: ${b.anchor}`);
console.log('\n=== Left unbridged (station-bearing islands only) ===');
for (const r of report) {
  if (r.result === 'bridged' || r.result === 'bridged-multi-hop' || r.result === 'skipped-no-stations') continue;
  console.log(`  ${r.result} (closest ${r.closestM === null ? '>' + CANDIDATE_SEARCH_RADIUS_M + 'm' : r.closestM + 'm'}): ${r.stations.join(',')}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`\n${bridges.length} bridges written to ${OUT_PATH}`);

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

const components = computeComponents(rg.nodes);
components.sort((a, b) => b.length - a.length);
const giant = components[0];
console.log(`Giant component: ${giant.length} nodes (of ${components.length} total components)`);

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

// Coarse grid over the giant component's coordinates so each island only
// compares against nearby nodes instead of all ~6,500 (the old all-pairs
// scan was fine for 8 hand-picked islands, far less so for a full sweep).
const CELL_DEG = 0.005; // ~350-550m — comfortably wider than the search radius
const grid = new Map();
const cellKey = (lon, lat) => Math.floor(lon / CELL_DEG) + ',' + Math.floor(lat / CELL_DEG);
for (const id of giant) {
  const c = rg.node_coord[id];
  if (!c) continue;
  const key = cellKey(c[0], c[1]);
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push({ id, c });
}
function nearbyGiantNodes(lon, lat) {
  const cx = Math.floor(lon / CELL_DEG), cy = Math.floor(lat / CELL_DEG);
  const out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const bucket = grid.get((cx + dx) + ',' + (cy + dy));
    if (bucket) out.push(...bucket);
  }
  return out;
}

const bridges = [];
const report = [];
for (let compIdx = 1; compIdx < components.length; compIdx++) {
  const island = components[compIdx];
  const stations = stationsByComponent.get(compIdx) || [];
  const islandCoords = island.map((id) => ({ id, c: rg.node_coord[id] })).filter((x) => x.c);

  const candidates = [];
  for (const isl of islandCoords) {
    for (const g of nearbyGiantNodes(isl.c[0], isl.c[1])) {
      const d = haversineMeters(isl.c, g.c);
      if (d <= CANDIDATE_SEARCH_RADIUS_M) candidates.push({ from: isl.id, to: g.id, distM: d });
    }
  }
  candidates.sort((a, b) => a.distM - b.distM);

  const entry = { compIdx, islandSize: island.length, stations, closestM: candidates.length ? Math.round(candidates[0].distM * 10) / 10 : null };
  if (!stations.length) { entry.result = 'skipped-no-stations'; report.push(entry); continue; }

  const waiverCrs = stations.find((crs) => MODE_GUARD_WAIVERS[crs]);
  let chosen = null, rejection = null;
  for (const c of candidates) {
    if (c.distM > THRESHOLD_M) break; // sorted ascending — nothing further will pass either
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
    entry.result = candidates.length && candidates[0].distM <= THRESHOLD_M ? 'rejected-mode' : 'gap-too-large';
    entry.detail = rejection;
    report.push(entry);
    continue;
  }
  bridges.push({
    anchor: stations.join(','),
    crs: stations[0],
    from: chosen.from,
    to: chosen.to,
    distM: Math.round(chosen.distM * 100) / 100,
    confidence: chosen.confidence,
    waiver: chosen.waiver || null,
    fromOperators: [...(nodeOperators.get(String(chosen.from)) || [])],
    toOperators: [...(nodeOperators.get(String(chosen.to)) || [])],
  });
  entry.result = 'bridged';
  entry.detail = `${chosen.from} <-> ${chosen.to} (${Math.round(chosen.distM)}m, ${chosen.confidence})`;
  report.push(entry);
}

writeFileSync(OUT_PATH, JSON.stringify({
  generated_at: new Date().toISOString(),
  threshold_m: THRESHOLD_M,
  bridges,
  unbridged: report.filter((r) => r.result !== 'bridged' && r.result !== 'skipped-no-stations'),
}, null, 2) + '\n');

console.log('\n=== Bridged ===');
for (const b of bridges) console.log(`  ${b.distM}m  ${b.from} <-> ${b.to}  [${b.confidence}]  stations: ${b.anchor}`);
console.log('\n=== Left unbridged (station-bearing islands only) ===');
for (const r of report) {
  if (r.result === 'bridged' || r.result === 'skipped-no-stations') continue;
  console.log(`  ${r.result} (closest ${r.closestM === null ? '>' + CANDIDATE_SEARCH_RADIUS_M + 'm' : r.closestM + 'm'}): ${r.stations.join(',')}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`\n${bridges.length} bridges written to ${OUT_PATH}`);

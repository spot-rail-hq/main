#!/usr/bin/env node
/**
 * scripts/build-routing-graph.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 6 — builds a slim, client-shippable routing graph for From/To
 * pathfinding, from the Phase 2 segment graph (scripts/output/
 * line-segments.json) and the Phase 3 station-snapping output (scripts/
 * output/station-graph-links.json).
 *
 * Deliberately NOT the full line-segments.json shipped as-is (39MB raw /
 * 6.2MB gzipped) — that carries every segment's full-precision geometry,
 * `nodes`/`way_ids` provenance, and per-operator duplication, none of which
 * pathfinding itself needs. This graph ships NO geometry at all — just node
 * adjacency + edge weight (real length_m) for Dijkstra, plus enough to
 * reconstruct each edge's geometry AFTER a path is resolved: `segment_id`
 * (every operators.pmtiles fan-out feature already carries this — the
 * client already has that tile source loaded for the fan-out rendering, so
 * looking a segment's coords up from it costs nothing extra to fetch), and
 * for edges created by splitting a segment at a station's mid-segment
 * attachment point, `from_coord`/`to_coord` (the two points on that segment
 * this sub-edge runs between) instead of embedding the sliced coordinates
 * directly — a first version that embedded full coordinate slices per split
 * sub-edge came out to 14.8MB/3.96MB gzipped (some splits carry nearly an
 * entire long segment's geometry when a station snaps near one end);
 * shipping two cut points instead and letting the client cut the
 * tile-sourced line at render time cut that dramatically, see the size
 * report this script prints.
 *
 * STATION ATTACHMENT: a station snaps to a POINT on a segment (Phase 3),
 * not necessarily an endpoint. Approximating to the nearest endpoint would
 * silently misplace short hops (a station 400m into a 5km segment would
 * route as if it were 5km from the far end). Instead: every segment with
 * one or more attached stations gets SPLIT into real sub-edges at each
 * attachment point (ordered along the segment via edge_index/edge_t from
 * Phase 3), each sub-edge's length computed by walking the ACTUAL coords
 * polyline (haversine sum), not a proportional/straight-line guess.
 *
 * Run:
 *   node scripts/build-routing-graph.mjs
 *
 * Output: data/routing-graph.json (committed, shipped to the client —
 * small enough, see the size report this script prints).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEGMENTS_PATH = path.join(ROOT, 'scripts', 'output', 'line-segments.json');
const STATIONS_PATH = path.join(ROOT, 'scripts', 'output', 'station-graph-links.json');
const BRIDGES_PATH = path.join(ROOT, 'scripts', 'output', 'graph-bridges.json');
const OUT_PATH = path.join(ROOT, 'data', 'routing-graph.json');

const graph = JSON.parse(readFileSync(SEGMENTS_PATH, 'utf8'));
const stationLinks = JSON.parse(readFileSync(STATIONS_PATH, 'utf8'));
let bridges = [];
try {
  bridges = JSON.parse(readFileSync(BRIDGES_PATH, 'utf8')).bridges;
} catch {
  console.log('No scripts/output/graph-bridges.json found — skipping bridge edges (run build-graph-bridges.mjs first if you want them).');
}

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function pathLength(coords) {
  let d = 0;
  for (let i = 0; i < coords.length - 1; i++) d += haversineMeters(coords[i], coords[i + 1]);
  return d;
}
// Interpolate a point at fraction t along the edge [coords[i], coords[i+1]].
function pointAt(coords, edgeIndex, t) {
  const [ax, ay] = coords[edgeIndex], [bx, by] = coords[edgeIndex + 1];
  return [ax + t * (bx - ax), ay + t * (by - ay)];
}

const segById = new Map(graph.segments.map((s) => [s.id, s]));

// Group snapped stations by segment_id.
const stationsBySegment = new Map();
for (const r of stationLinks.results) {
  if (!r.snapped || r.segment_id === null) continue;
  if (!stationsBySegment.has(r.segment_id)) stationsBySegment.set(r.segment_id, []);
  stationsBySegment.get(r.segment_id).push(r);
}

// FIXED 2026-08-05 — see build-station-graph-links.mjs's `atco` comment for the
// full story. This used to be `'S:' + crs` with no fallback, so JS's implicit
// string coercion turned EVERY non-CRS station's id into the literal
// `"S:null"` — collapsing all 800 snapped non-CRS stations nationwide (tram and
// metro stops) onto one shared graph node. That created a phantom near-zero-
// cost edge between any two of them (verified: Arsenal tube in London and
// Meadows Way West tram in Nottingham, ~180km apart, ended up "adjacent" via
// S:null for ~1.4km of graph cost), which corrupted Dijkstra shortest-path
// results for any query that happened to route near two such stops — not a
// Hull-Trains-only bug, this is the general routing graph used for From/To too.
// ATCO is unique per row (verified against station-list.json: all 815 non-CRS
// rows carry one, zero collisions), so it is the fallback key.
const nodeStationId = (crs, atco) => 'S:' + (crs || ('A:' + atco));

const adjacency = new Map(); // nodeId -> [{to, length_m, edge}]
const nodeCoord = new Map(); // nodeId -> [lon,lat] — approximate, just for fitBounds()-ing a resolved path into view before tile-querying its real geometry, not for rendering
function addEdge(a, b, length_m, edge) {
  if (!adjacency.has(a)) adjacency.set(a, []);
  if (!adjacency.has(b)) adjacency.set(b, []);
  adjacency.get(a).push({ to: b, length_m, edge });
  adjacency.get(b).push({ to: a, length_m, edge });
}

let splitSegmentCount = 0, unsplitSegmentCount = 0, totalSubEdges = 0;

for (const seg of graph.segments) {
  const stations = stationsBySegment.get(seg.id);
  const startNode = seg.nodes[0], endNode = seg.nodes[seg.nodes.length - 1];
  nodeCoord.set(startNode, seg.coords[0]);
  nodeCoord.set(endNode, seg.coords[seg.coords.length - 1]);
  if (!stations || stations.length === 0) {
    // No stations attach here — one edge, geometry looked up from the tile
    // source at render time by segment_id (no coords shipped).
    addEdge(startNode, endNode, seg.length_m, { type: 'segment', segment_id: seg.id });
    unsplitSegmentCount++;
    continue;
  }
  splitSegmentCount++;
  // Order attachment points along the segment's own coords polyline.
  const ordered = [...stations].sort((a, b) => (a.edge_index - b.edge_index) || (a.edge_t - b.edge_t));
  // Build the full ordered list of "cut points": start node, each station
  // (with its interpolated coordinate + position in the coords array), end
  // node — then slice coords between consecutive cuts for each sub-edge.
  const cuts = [{ kind: 'node', id: startNode, edgeIndex: 0, t: 0, coord: seg.coords[0] }];
  for (const st of ordered) {
    const stationCoord = pointAt(seg.coords, st.edge_index, st.edge_t);
    const sid = nodeStationId(st.crs, st.atco);
    nodeCoord.set(sid, stationCoord);
    cuts.push({ kind: 'station', id: sid, edgeIndex: st.edge_index, t: st.edge_t, coord: stationCoord });
  }
  cuts.push({ kind: 'node', id: endNode, edgeIndex: seg.coords.length - 2, t: 1, coord: seg.coords[seg.coords.length - 1] });

  for (let i = 0; i < cuts.length - 1; i++) {
    const c0 = cuts[i], c1 = cuts[i + 1];
    if (c0.id === c1.id) continue; // two stations snapped to the exact same point — collapse, no zero-length edge
    // Precise length uses the exact interpolated cut points (weight
    // accuracy matters for correctness). Rendering geometry does NOT need
    // that precision — the client just has to know WHERE along the segment
    // this sub-edge starts and ends, so it can cut the segment's line at
    // those two points, no embedded coordinate slice shipped.
    //
    // 2026-07-26 bugfix — this used to ship from_index/to_index: indices
    // into THIS file's full-precision coords array. The client doesn't have
    // that array. It reads the segment back out of operators.pmtiles, whose
    // geometry tippecanoe has simplified per zoom level and clipped per
    // tile — segment 970 is 356 points here but 36 points in a z10 tile —
    // so an index range like 60..160 addressed nothing at all and the slice
    // came back empty. The client silently skipped those sub-edges, which
    // is precisely why a Solihull→Leamington Spa highlight started somewhere
    // south of Solihull instead of at it. Coordinates survive simplification
    // (a simplified line keeps a subset of the ORIGINAL vertices, moved
    // nowhere), so a cut POINT can always be located on whatever geometry
    // the client actually got, at any zoom.
    const slice = [c0.coord];
    for (let ei = c0.edgeIndex + 1; ei <= c1.edgeIndex; ei++) slice.push(seg.coords[ei]);
    slice.push(c1.coord);
    const length_m = pathLength(slice);
    const round5 = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]; // ~1m — finer than the tile geometry it gets matched against
    addEdge(c0.id, c1.id, length_m, { type: 'partial', segment_id: seg.id, from_coord: round5(c0.coord), to_coord: round5(c1.coord) });
    totalSubEdges++;
  }
}

// Station -> graph node lookup, for every station (even unsnapped ones, so
// the client can tell "no node at all" apart from "node exists but no path").
// CRS-keyed only, deliberately — every real consumer (attribute-by-calling-
// points.mjs, From/To search) looks a station up by its CRS, so a non-CRS
// station has nothing to be keyed BY here regardless of the S:null fix above.
// Skipped rather than assigned to a shared 'null' key, which would silently
// keep the same collision this file's other fix just removed from the graph
// itself, just in a table nothing reads.
const stationNode = {};
for (const r of stationLinks.results) {
  if (!r.crs) continue;
  stationNode[r.crs] = r.snapped ? nodeStationId(r.crs, r.atco) : null;
}

// Prune known Metrolink tram-stop nodes that ended up topologically merged
// into the Manchester heavy-rail segment graph (found 2026-07-15 while
// investigating that island's connectivity — a PRE-EXISTING Phase 2 segment-
// graph artifact, unrelated to the bridge work below: several Metrolink
// lines reuse former heavy-rail alignments and apparently share an OSM node
// with the rail network somewhere in that stretch, well before any bridging
// happens here). Confirmed via live Overpass tag lookups (railway=tram_stop,
// network=Manchester Metrolink) that these 10 are real tram stop-positions,
// not rail. All 10 were also confirmed degree-1 (dead-end) in the graph, so
// this prune is a no-op for every currently-working route — it's here so a
// future segment-graph change can't accidentally make one of them a real
// through-node without anyone noticing a train route silently using tram
// track. Not a general node-mode audit (that would need tag-checking every
// node in the graph, a bigger separate pass) — scoped to exactly the nodes
// this investigation found and verified.
const EXCLUDED_TRAM_NODE_IDS = [
  32585982, 91898198, 292004860, 1495743227, 2319444508,
  5813712617, 6981520395, 6982583044, 6988577653, 7315119440,
];
let prunedEdgeCount = 0;
for (const rawId of EXCLUDED_TRAM_NODE_IDS) {
  const key = adjacency.has(rawId) ? rawId : (adjacency.has(String(rawId)) ? String(rawId) : null);
  if (key === null) continue; // not present in this build — fine, nothing to prune
  const edges = adjacency.get(key) || [];
  for (const e of edges) {
    const neighborEdges = adjacency.get(e.to);
    if (!neighborEdges) continue;
    const before = neighborEdges.length;
    adjacency.set(e.to, neighborEdges.filter((ne) => ne.to !== key));
    prunedEdgeCount += before - adjacency.get(e.to).length;
  }
  adjacency.delete(key);
  nodeCoord.delete(key);
}

// Bridge edges (scripts/build-graph-bridges.mjs) — reconnect a small,
// explicitly reviewed allow-list of major regional networks that are
// topologically disconnected due to OSM node-ID mismatches at complex
// station throats, NOT a real physical gap. No segment_id/tile geometry
// backs these (there's no mapped way for the gap itself) — the client's
// resolveFromToGeometry() already has a bounded-gap bridge-with-a-straight-
// line fallback (MAX_BRIDGEABLE_GAP_M) for exactly this shape of edge.
// graph-bridges.json's node ids came back from routing-graph.json, where
// JSON object keys are always strings — but this fresh adjacency Map keys
// numeric OSM node ids as JS numbers (straight from line-segments.json),
// since only nodeStationId()'s "S:"+crs ids are ever real strings. Without
// this coercion, Map.has("30941069") silently misses the number-keyed
// 30941069 and every numeric-node bridge gets dropped.
function resolveNodeKey(id) {
  if (adjacency.has(id)) return id;
  if (typeof id === 'string' && /^\d+$/.test(id)) {
    const n = Number(id);
    if (adjacency.has(n)) return n;
  }
  return null;
}

let bridgeEdgeCount = 0;
for (const b of bridges) {
  const fromKey = resolveNodeKey(b.from), toKey = resolveNodeKey(b.to);
  if (fromKey === null || toKey === null) {
    console.log(`SKIP bridge for ${b.anchor}: endpoint not present in this graph build (${b.from} / ${b.to}) — rerun build-graph-bridges.mjs after any segment-graph change`);
    continue;
  }
  addEdge(fromKey, toKey, b.distM, { type: 'bridge' });
  bridgeEdgeCount++;
}

const nodes = {};
for (const [id, edges] of adjacency) {
  nodes[id] = edges;
}
const nodeCoordOut = {};
for (const [id, coord] of nodeCoord) {
  if (adjacency.has(id)) nodeCoordOut[id] = [Math.round(coord[0] * 1e5) / 1e5, Math.round(coord[1] * 1e5) / 1e5];
}

const output = {
  generated_at: new Date().toISOString(),
  node_count: adjacency.size,
  edge_count: [...adjacency.values()].reduce((a, e) => a + e.length, 0) / 2,
  node_coord: nodeCoordOut,
  segments_split: splitSegmentCount,
  segments_unsplit: unsplitSegmentCount,
  sub_edges_from_splits: totalSubEdges,
  bridge_edges: bridgeEdgeCount,
  pruned_tram_nodes: EXCLUDED_TRAM_NODE_IDS.length,
  station_node: stationNode,
  nodes,
};

writeFileSync(OUT_PATH, JSON.stringify(output));

console.log(`Routing graph: ${output.node_count} nodes, ${output.edge_count} edges (${splitSegmentCount} segments split into ${totalSubEdges} sub-edges, ${unsplitSegmentCount} left whole, ${bridgeEdgeCount} bridge edges, ${prunedEdgeCount} edges pruned from ${EXCLUDED_TRAM_NODE_IDS.length} known Metrolink tram nodes)`);
console.log(`Written to ${OUT_PATH}`);

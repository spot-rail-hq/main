#!/usr/bin/env node
/**
 * scripts/build-station-graph-links.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 3 (station half) of the operator-colored rail line project. Snaps
 * each of the 2,637 NaPTAN stations (station-list.json) to its nearest
 * point on the Phase 2 segment graph (scripts/output/line-segments.json),
 * so Phase 6's From/To pathfinding has a graph node to start/end at.
 *
 * Method: nearest-point-on-polyline, not nearest-node. The segment graph's
 * `nodes` arrays are dense (every original OSM node survived the Phase 2
 * chain contraction, not just junctions), but a station can still sit
 * mid-edge between two nodes — snapping to the nearest raw NODE would
 * overstate the true distance in that case. So for every station, every
 * candidate segment's consecutive-node edges are checked with a proper
 * point-to-segment projection (clamped to the edge, not just endpoint
 * distance), and the true minimum is kept.
 *
 * Spatial index: a simple degree-based grid (not a full R-tree — station
 * count (2,637) × edge count (~427k) is far too slow unindexed, but a grid
 * with a search-radius expansion loop is enough at this scale and needs no
 * new dependency). Every edge is inserted into the grid cells its bounding
 * box overlaps; a station's search starts at a 3x3 cell window (well over
 * 200m at UK latitudes) and expands outward until either a match is found
 * or a hard cap is hit (at which point it's reported as a genuine gap, not
 * silently widened forever).
 *
 * Run:
 *   node scripts/build-station-graph-links.mjs
 *
 * Output: scripts/output/station-graph-links.json — per-station snap
 * result (segment id, edge index, snapped point, distance) or an explicit
 * "unsnapped" entry with the true nearest distance found, for review before
 * Phase 4.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(__dirname, 'output', 'station-graph-links.json');

const SNAP_TOLERANCE_M = 200;
const CELL_DEG = 0.01; // ~700-1100m at GB latitudes — generous vs. the 200m tolerance

function loadJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

const stations = loadJson(path.join(ROOT, 'station-list.json'));
const graph = loadJson(path.join(__dirname, 'output', 'line-segments.json'));
const segments = graph.segments;

console.log(`${stations.length} stations, ${segments.length} segments`);

// ─── spatial grid over every edge (consecutive coord pair) of every segment ──
const grid = new Map(); // "cx,cy" -> [{segId, i}]
function cellKey(lon, lat) {
  return Math.floor(lon / CELL_DEG) + ',' + Math.floor(lat / CELL_DEG);
}
function cellsForBbox(lon1, lat1, lon2, lat2) {
  const minLon = Math.min(lon1, lon2), maxLon = Math.max(lon1, lon2);
  const minLat = Math.min(lat1, lat2), maxLat = Math.max(lat1, lat2);
  const cx0 = Math.floor(minLon / CELL_DEG), cx1 = Math.floor(maxLon / CELL_DEG);
  const cy0 = Math.floor(minLat / CELL_DEG), cy1 = Math.floor(maxLat / CELL_DEG);
  const out = [];
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) out.push(cx + ',' + cy);
  return out;
}

for (let segIdx = 0; segIdx < segments.length; segIdx++) {
  const coords = segments[segIdx].coords;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i], [lon2, lat2] = coords[i + 1];
    for (const key of cellsForBbox(lon1, lat1, lon2, lat2)) {
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ segIdx, i });
    }
  }
}
console.log(`grid built: ${grid.size} occupied cells`);

// ─── point-to-segment distance (local equirectangular projection, accurate to a few m at sub-km scale) ──
function metersPerDegree(lat) {
  const latRad = (lat * Math.PI) / 180;
  return { mPerDegLon: 111320 * Math.cos(latRad), mPerDegLat: 110574 };
}
function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nearestPointOnEdge(px, py, ax, ay, bx, by, mPerDegLon, mPerDegLat) {
  // work in local meters (station as origin) so the projection/clamp math is plain planar geometry
  const toM = (lon, lat) => [(lon - px) * mPerDegLon, (lat - py) * mPerDegLat];
  const [axm, aym] = toM(ax, ay), [bxm, bym] = toM(bx, by);
  const dx = bxm - axm, dy = bym - aym;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((0 - axm) * dx + (0 - aym) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nx = axm + t * dx, ny = aym + t * dy;
  const distM = Math.sqrt(nx * nx + ny * ny);
  const lon = ax + t * (bx - ax), lat = ay + t * (by - ay);
  return { distM, lon, lat, t };
}

function findNearest(stationLon, stationLat) {
  const { mPerDegLon, mPerDegLat } = metersPerDegree(stationLat);
  const cx = Math.floor(stationLon / CELL_DEG), cy = Math.floor(stationLat / CELL_DEG);
  let best = null;
  let radius = 1; // start at 3x3
  const MAX_RADIUS = 15; // ~15-25km cap depending on latitude — well beyond any plausible "genuine gap"
  while (radius <= MAX_RADIUS) {
    const seen = new Set();
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        // only scan the new ring on expansion, not the whole window again, EXCEPT the first pass
        if (radius > 1 && Math.max(Math.abs(dx), Math.abs(dy)) < radius) continue;
        const key = (cx + dx) + ',' + (cy + dy);
        const bucket = grid.get(key);
        if (!bucket) continue;
        for (const { segIdx, i } of bucket) {
          const dedupeKey = segIdx + ':' + i;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const coords = segments[segIdx].coords;
          const [ax, ay] = coords[i], [bx, by] = coords[i + 1];
          const r = nearestPointOnEdge(stationLon, stationLat, ax, ay, bx, by, mPerDegLon, mPerDegLat);
          if (!best || r.distM < best.distM) best = { distM: r.distM, segIdx, edgeIndex: i, lon: r.lon, lat: r.lat, t: r.t };
        }
      }
    }
    // stop expanding once we have a confident match well inside tolerance,
    // or once we've covered a radius whose inner region guarantees we's
    // have seen anything within SNAP_TOLERANCE_M (radius*CELL_DEG*mPerDeg > tolerance)
    if (best && radius * CELL_DEG * Math.min(mPerDegLon, mPerDegLat) > SNAP_TOLERANCE_M * 1.5) break;
    radius++;
  }
  return best;
}

const results = [];
let snapped = 0, unsnapped = 0;
for (const st of stations) {
  const nearest = findNearest(st.lon, st.lat);
  const ok = nearest && nearest.distM <= SNAP_TOLERANCE_M;
  if (ok) snapped++; else unsnapped++;
  results.push({
    crs: st.crs,
    name: st.name,
    lat: st.lat,
    lon: st.lon,
    snapped: ok,
    distance_m: nearest ? Math.round(nearest.distM * 10) / 10 : null,
    segment_id: nearest ? segments[nearest.segIdx].id : null,
    snap_point: nearest ? [Math.round(nearest.lon * 1e6) / 1e6, Math.round(nearest.lat * 1e6) / 1e6] : null,
    // Phase 6 addition: WHERE along the segment the station snapped — which
    // consecutive-node edge (edge_index into that segment's coords array)
    // and how far along it (edge_t, 0=start node/1=end node) — needed to
    // split a segment precisely at the station's real position for routing,
    // rather than approximating to the nearest endpoint. Not derived from
    // anything new: nearestPointOnEdge() already computed both internally,
    // this just stops discarding them.
    edge_index: nearest ? nearest.edgeIndex : null,
    edge_t: nearest ? Math.round(nearest.t * 1e6) / 1e6 : null,
  });
}

writeFileSync(OUT_PATH, JSON.stringify({
  generated_at: new Date().toISOString(),
  tolerance_m: SNAP_TOLERANCE_M,
  station_count: stations.length,
  snapped_count: snapped,
  unsnapped_count: unsnapped,
  results,
}, null, 2) + '\n');

console.log(`\n=== Report ===`);
console.log(`Snapped within ${SNAP_TOLERANCE_M}m: ${snapped} / ${stations.length}`);
console.log(`NOT snapped: ${unsnapped}`);
const unsnappedList = results.filter((r) => !r.snapped).sort((a, b) => (b.distance_m || 0) - (a.distance_m || 0));
console.log('\nUnsnapped stations (nearest distance found, farthest first):');
for (const u of unsnappedList) {
  console.log(`  ${u.crs} ${u.name}: nearest ${u.distance_m === null ? 'NONE FOUND within search cap' : u.distance_m + 'm'}`);
}
console.log(`\nWritten to ${OUT_PATH}`);

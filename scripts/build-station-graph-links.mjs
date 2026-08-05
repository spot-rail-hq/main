#!/usr/bin/env node
/**
 * scripts/build-station-graph-links.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 3 (station half) of the operator-colored rail line project. Snaps
 * each of the 2,637 NaPTAN stations (station-list.json) to its nearest
 * point on the Phase 2 segment graph (scripts/output/line-segments.json),
 * so Phase 6's From/To pathfinding has a graph node to start/end at.
 *
 * MODE/OPERATOR AWARENESS (2026-07-26 bugfix): nearest-geometry alone is
 * NOT enough. A National Rail terminus that sits directly above an
 * Underground tunnel snaps to the TUBE line rather than its own mainline —
 * London Marylebone snapped to a Bakerloo-line segment, putting S:MYB on a
 * 3-node Bakerloo island, so "Solihull → London Marylebone" (the whole
 * Chiltern Main Line!) reported "no direct route found". The same fault hit
 * Waterloo/London Bridge/Waterloo East (snapped onto the Jubilee line),
 * Tottenham Court Road/Greenford/Ealing area (Central line), Emerson Park
 * (Liberty), and others — every one of them a station whose routing was
 * silently dead. So candidates are now ranked by TIER first and distance
 * second:
 *   1. a segment whose operators include one this station is actually served
 *      by (from stations-content.json's `operators`, canonicalised through
 *      scripts/lib/operator-classify.mjs into the same tokens
 *      build-line-segments.mjs writes onto segments)
 *   2. any segment of the right MODE (heavy rail for a National Rail
 *      station, light rail for a metro/tram-only one)
 *   3. anything at all within tolerance (unchanged old behaviour)
 * — all still capped at the same SNAP_TOLERANCE_M, so this only ever
 * re-picks among segments that were already plausible, never reaches
 * further out.
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
import { classify } from './lib/operator-classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(__dirname, 'output', 'station-graph-links.json');

const SNAP_TOLERANCE_M = 200;
const CELL_DEG = 0.01; // ~700-1100m at GB latitudes — generous vs. the 200m tolerance

function loadJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }

const stations = loadJson(path.join(ROOT, 'station-list.json'));
const graph = loadJson(path.join(__dirname, 'output', 'line-segments.json'));
const segments = graph.segments;
const stationsContent = loadJson(path.join(ROOT, 'stations-content.json'));
const operatorColors = loadJson(path.join(ROOT, 'data', 'operator-colors.json'));

console.log(`${stations.length} stations, ${segments.length} segments`);

// ─── mode classification of the operator tokens segments actually carry ─────
// The tokens on a segment are build-line-segments.mjs' canonical form: a TOC
// code ('CH'), 'Heritage', a metro system's canonical name ('Manchester
// Metrolink'), or a specific TfL line name ('Bakerloo', 'Windrush'). LIGHT =
// the 11 Underground lines + DLR + every metro/tram system. Everything else
// (TOC codes, Heritage, and the 2024-renamed Overground lines, which run on
// heavy-rail metals and interchange with the national network) is HEAVY.
const TUBE_LINES = ['Bakerloo', 'Central', 'Circle', 'District', 'Hammersmith & City', 'Jubilee', 'Metropolitan', 'Northern', 'Piccadilly', 'Victoria', 'Waterloo & City'];
const LIGHT_TOKENS = new Set([
  ...TUBE_LINES,
  'DLR', 'Docklands Light Railway',
  ...Object.keys(operatorColors.metro || {}),
]);
const isLightToken = (t) => LIGHT_TOKENS.has(t);
// A segment is heavy rail if ANY of its operators is heavy (shared track:
// e.g. a Metrolink-and-Northern stretch is still real heavy-rail track).
function segmentIsHeavy(ops) { return ops.some((o) => !isLightToken(o)); }

// ─── each station's own operators, canonicalised into the same tokens ───────
// stations-content.json carries display names ('Chiltern Railways'); classify()
// maps them to the same canonical tokens segments use ('CH'). Anything it
// can't place (Network Rail, London Midland, …) is simply dropped — an
// unknown name must never make a station look metro-only.
// stations-content.json's `operators` is OSM-sourced and occasionally
// INCOMPLETE — a heavy-rail station that also has a tram stop can end up
// listed under the tram system alone, which would make the mode rule below
// push it onto tram track. Audited exhaustively (not spot-checked): exactly
// six stations classify as light-rail-only from their operator names, and
// five of them (Brockley Whins, East Boldon, Northumberland Park, Seaburn,
// St Peter's) really are Tyne & Wear Metro-only — OSM's own Wikipedia hint
// for each reads "… Metro station". Rochdale is the sole false one (hint:
// "Rochdale railway station"): a Calder Valley line station served by
// Northern, whose OSM operator tag only records the Metrolink stop that
// shares the site. Patch the evidence, don't special-case the algorithm.
const STATION_OPERATOR_PATCHES = {
  RCD: ['Northern'], // Rochdale — Northern (Calder Valley line) missing from OSM operator tags; without this it snaps to the Metrolink island and every Rochdale route dies
};
// Operator names stations-content.json uses that classify() doesn't know.
// classify()'s table is built from the OSM strings the LINE data carries;
// the station data has its own vocabulary, and a name it can't place is
// dropped, which silently costs those stations their operator evidence.
const EXTRA_STATION_NAME_TOKENS = {
  'Transport for Wales Rail': 'AW',  // 238 stations — classify() only knows the bare "Transport for Wales"
  'Stansted Express': 'LE',          // a Greater Anglia brand, tagged as plain LE on the line side
};
// Tokens that name the SAME network on the line side. Matching purely on
// exact token wrongly splits these apart and pushes a station onto a
// further-away piece of the same railway: Whyteleafe lists "Southern" (SN)
// but its own track is tagged at parent-company level as GTR (see CLAUDE.md
// — most of Southern/Thameslink/Great Northern/Gatwick Express is tagged
// "Greater Thameslink Railway" in OSM), which moved it 190m up the line
// before this was added. Same story for West Midlands Trains' two brands.
const TOKEN_EQUIVALENTS = {
  SN: ['GTR'], TL: ['GTR'], GN: ['GTR'], GX: ['GTR'],
  GTR: ['SN', 'TL', 'GN', 'GX'],
  LN: ['WMR'], WMR: ['LN'],
};
function stationTokens(crs) {
  const entry = stationsContent[crs] || stationsContent[(crs || '').toUpperCase()];
  const names = ((entry && entry.operators) || []).concat(STATION_OPERATOR_PATCHES[crs] || []);
  const tokens = new Set();
  for (const name of names) {
    if (EXTRA_STATION_NAME_TOKENS[name]) { tokens.add(EXTRA_STATION_NAME_TOKENS[name]); continue; }
    const c = classify(name);
    if (c.bucket === 'toc') tokens.add(c.code);
    else if (c.bucket === 'metro') tokens.add(c.canonical);
    else if (c.bucket === 'heritage') tokens.add('Heritage');
  }
  for (const t of [...tokens]) for (const eq of (TOKEN_EQUIVALENTS[t] || [])) tokens.add(eq);
  return tokens;
}
// A bare 'Transport for London' on a STATION covers both Underground and
// London Overground (the station data doesn't split them the way the line
// data does), so it can never be the evidence that a station is light-rail
// only — otherwise every Overground station would be pushed off the heavy
// rail it actually sits on.
const AMBIGUOUS_MODE_TOKENS = new Set(['Transport for London']);
function stationIsHeavyRail(tokens) {
  if (tokens.size === 0) return true; // no operator data (107 stations) — assume National Rail, the overwhelming default
  for (const t of tokens) if (!isLightToken(t) || AMBIGUOUS_MODE_TOKENS.has(t)) return true;
  return false;
}

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

// Candidate tiers, best first. `preferHeavy` is the station's own mode:
// a National Rail station wants heavy-rail track, a tram-only one wants
// light. Tier 0 additionally requires the segment to be run by an operator
// this station is actually served by.
const TIER_OPERATOR_MATCH = 0, TIER_MODE_MATCH = 1, TIER_ANY = 2;
function candidateTier(segOps, tokens, preferHeavy) {
  const modeOk = segmentIsHeavy(segOps) === preferHeavy;
  if (modeOk) {
    for (const op of segOps) if (tokens.has(op)) return TIER_OPERATOR_MATCH;
    return TIER_MODE_MATCH;
  }
  return TIER_ANY;
}

function findNearest(stationLon, stationLat, tokens, preferHeavy) {
  const { mPerDegLon, mPerDegLat } = metersPerDegree(stationLat);
  const cx = Math.floor(stationLon / CELL_DEG), cy = Math.floor(stationLat / CELL_DEG);
  // Best candidate per tier — a better tier always wins, distance only
  // breaks ties WITHIN a tier, and every tier is still capped at
  // SNAP_TOLERANCE_M by the caller (see `best` selection below).
  const bestByTier = [null, null, null];
  let best = null; // nearest overall, regardless of tier — kept for the unsnapped report's "nearest distance found"
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
          const tier = candidateTier(segments[segIdx].operators, tokens, preferHeavy);
          const cand = { distM: r.distM, segIdx, edgeIndex: i, lon: r.lon, lat: r.lat, t: r.t, tier };
          if (!bestByTier[tier] || r.distM < bestByTier[tier].distM) bestByTier[tier] = cand;
          if (!best || r.distM < best.distM) best = cand;
        }
      }
    }
    // stop expanding once we have a confident match well inside tolerance,
    // or once we've covered a radius whose inner region guarantees we's
    // have seen anything within SNAP_TOLERANCE_M (radius*CELL_DEG*mPerDeg > tolerance)
    if (best && radius * CELL_DEG * Math.min(mPerDegLon, mPerDegLat) > SNAP_TOLERANCE_M * 1.5) break;
    radius++;
  }
  // Pick the best tier that actually has a candidate INSIDE tolerance;
  // if none does, fall back to the nearest overall so the report can still
  // show how far the real nearest track is.
  for (const tier of [TIER_OPERATOR_MATCH, TIER_MODE_MATCH, TIER_ANY]) {
    const c = bestByTier[tier];
    if (c && c.distM <= SNAP_TOLERANCE_M) return { chosen: c, nearest: best };
  }
  return { chosen: best, nearest: best };
}

const results = [];
let snapped = 0, unsnapped = 0;
const tierCounts = { operator: 0, mode: 0, any: 0 };
for (const st of stations) {
  const tokens = stationTokens(st.crs);
  const preferHeavy = stationIsHeavyRail(tokens);
  const { chosen: nearest, nearest: absoluteNearest } = findNearest(st.lon, st.lat, tokens, preferHeavy);
  const ok = nearest && nearest.distM <= SNAP_TOLERANCE_M;
  if (ok) snapped++; else unsnapped++;
  if (ok) tierCounts[['operator', 'mode', 'any'][nearest.tier]]++;
  results.push({
    crs: st.crs,
    // ATCO, carried through 2026-08-05. 815 of 3,443 stations have no CRS (tram/
    // metro stops), and every downstream consumer that built a per-station
    // routing-graph node id out of `'S:' + crs` was coercing all of them to the
    // literal string "S:null" — collapsing 800 snapped, unrelated stations
    // nationwide onto ONE shared graph node. Dijkstra could then "teleport"
    // between any two of them for the sum of their two real (short) snap
    // distances, e.g. Arsenal tube (London) <-> Meadows Way West tram (Nottingham)
    // for ~1.4km of graph cost. That produced a real, wrong shortest path for
    // Hull Trains' Stevenage->Grantham leg, routing via the Nottingham tram
    // network instead of the East Coast Main Line. ATCO is unique per row
    // (verified: all 815 non-CRS rows carry one, zero collisions), so
    // build-routing-graph.mjs now keys non-CRS stations on it instead.
    atco: st.atco || null,
    name: st.name,
    lat: st.lat,
    lon: st.lon,
    snapped: ok,
    distance_m: nearest ? Math.round(nearest.distM * 10) / 10 : null,
    segment_id: nearest ? segments[nearest.segIdx].id : null,
    // Why this segment was chosen ('operator' = run by a TOC/system this
    // station is served by, 'mode' = right mode but no operator evidence,
    // 'any' = neither, nothing better within tolerance) plus what the
    // geometrically closest track was, so a re-review can see where the
    // tier ranking overrode plain distance.
    snap_tier: nearest ? ['operator', 'mode', 'any'][nearest.tier] : null,
    snap_operators: nearest ? segments[nearest.segIdx].operators : null,
    nearest_distance_m: absoluteNearest ? Math.round(absoluteNearest.distM * 10) / 10 : null,
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
console.log(`  by tier: ${tierCounts.operator} operator-matched, ${tierCounts.mode} mode-matched only, ${tierCounts.any} neither (nothing better in range)`);
console.log(`NOT snapped: ${unsnapped}`);
const unsnappedList = results.filter((r) => !r.snapped).sort((a, b) => (b.distance_m || 0) - (a.distance_m || 0));
console.log('\nUnsnapped stations (nearest distance found, farthest first):');
for (const u of unsnappedList) {
  console.log(`  ${u.crs} ${u.name}: nearest ${u.distance_m === null ? 'NONE FOUND within search cap' : u.distance_m + 'm'}`);
}
console.log(`\nWritten to ${OUT_PATH}`);

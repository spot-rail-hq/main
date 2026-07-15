#!/usr/bin/env node
/**
 * scripts/build-graph-bridges.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Finds coordinate-proximity bridge edges to reconnect a small, explicitly
 * reviewed allow-list of major regional networks that are topologically
 * disconnected from the main routing graph due to OSM node-ID mismatches at
 * complex station throats (the same class of issue found for LNER/Grand
 * Central at Doncaster in Phase 2, and confirmed concretely for Manchester
 * Piccadilly via a live Overpass check: a `railway=buffer_stop` node ~26m
 * from the station's own stop-position node, never node-sharing with it).
 *
 * Deliberately NOT a blanket "bridge anything within N metres" pass — that
 * would also catch components explicitly left for a separate future review
 * (Waterloo/London Bridge, Charing Cross's smaller neighbours, etc.), and it
 * would risk false positives: the single closest node pair found near
 * Manchester Airport during investigation (13m) turned out to be a Metrolink
 * TRAM stop-position next to the heavy-rail one, not a real track gap.
 * Bridging that blindly would wrongly stitch the tram network onto National
 * Rail. So: (1) islands are selected by an explicit anchor-station allow­
 * list, not by size or distance threshold, and (2) every real-OSM-node
 * candidate is tag-checked against Overpass before being accepted, requiring
 * it NOT be a tram/subway/light-rail feature.
 *
 * Run: node scripts/build-graph-bridges.mjs
 * Requires: a local Overpass instance on :12345 (tag-checks only, cheap).
 * Output: scripts/output/graph-bridges.json — consumed by
 * build-routing-graph.mjs to inject the bridge edges.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROUTING_GRAPH_PATH = path.join(ROOT, 'data', 'routing-graph.json');
const OUT_PATH = path.join(ROOT, 'scripts', 'output', 'graph-bridges.json');
const OVERPASS_URL = 'http://localhost:12345/api/interpreter';

const THRESHOLD_M = 50; // confirmed-safe islands all measured 9-38m; genuinely isolated ones measured 7.4km+ — wide margin, no ambiguous middle ground found
const CANDIDATE_SEARCH_RADIUS_M = 100; // cast a slightly wider net than the threshold so the mode guard has more than one candidate to fall through to
const CANDIDATES_PER_ISLAND = 8;

// Explicit allow-list — anchor CRS chosen from the investigation, one per
// confirmed-safe island. Membership is resolved fresh at run time via this
// station's graph node, NOT by a hardcoded component array index (unstable
// across reruns).
const ANCHORS = [
  { name: 'South Wales Valley Lines', crs: 'CDQ' },
  { name: 'Essex / c2c (Fenchurch St branch)', crs: 'FST' },
  { name: 'Manchester (Piccadilly + Victoria)', crs: 'MAN' },
  { name: 'Scottish Highlands (Inverness / Far North / Kyle)', crs: 'INV' },
  { name: 'Liverpool / Wrexham corridor', crs: 'LVC' },
  { name: 'Branch cluster (ELE)', crs: 'ELE' },
  { name: 'Branch cluster (GNW)', crs: 'GNW' },
  { name: 'Charing Cross area', crs: 'CHX' },
];

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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
        const to = String(e.to);
        if (!visited.has(to)) { visited.add(to); queue.push(to); }
      }
    }
    components.push(comp);
  }
  return components;
}

const rg = JSON.parse(readFileSync(ROUTING_GRAPH_PATH, 'utf8'));
const components = computeComponents(rg.nodes);
components.sort((a, b) => b.length - a.length);
const giant = components[0];
console.log(`Giant component: ${giant.length} nodes (of ${components.length} total components)`);

const nodeToComponent = new Map();
components.forEach((c, i) => c.forEach((n) => nodeToComponent.set(n, i)));

const giantCoords = giant.map((id) => ({ id, c: rg.node_coord[id] })).filter((x) => x.c);

const perIsland = [];
const allRealNodeIds = new Set();

for (const anchor of ANCHORS) {
  const anchorNode = rg.station_node[anchor.crs];
  if (!anchorNode) { console.log(`SKIP ${anchor.name} (${anchor.crs}): not in station_node map`); continue; }
  const compIdx = nodeToComponent.get(String(anchorNode));
  if (compIdx === undefined) { console.log(`SKIP ${anchor.name}: anchor node not found in graph adjacency`); continue; }
  if (compIdx === 0) { console.log(`SKIP ${anchor.name}: already in the giant component — nothing to bridge`); continue; }
  const island = components[compIdx];
  const islandCoords = island.map((id) => ({ id, c: rg.node_coord[id] })).filter((x) => x.c);

  const candidates = [];
  for (const isl of islandCoords) {
    for (const g of giantCoords) {
      const d = haversineMeters(isl.c, g.c);
      if (d <= CANDIDATE_SEARCH_RADIUS_M) candidates.push({ from: isl.id, to: g.id, distM: d });
    }
  }
  candidates.sort((a, b) => a.distM - b.distM);
  const top = candidates.slice(0, CANDIDATES_PER_ISLAND);
  top.forEach((c) => {
    if (!String(c.from).startsWith('S:')) allRealNodeIds.add(c.from);
    if (!String(c.to).startsWith('S:')) allRealNodeIds.add(c.to);
  });
  perIsland.push({ anchor: anchor.name, crs: anchor.crs, compIdx, islandSize: island.length, candidates: top });
  console.log(`${anchor.name} (${anchor.crs}): island size ${island.length}, ${top.length} candidates within ${CANDIDATE_SEARCH_RADIUS_M}m (closest: ${top[0] ? Math.round(top[0].distM) + 'm' : 'none'})`);
}

// ── Tag-check every real-OSM-node candidate against Overpass ──────────────
const idList = [...allRealNodeIds];
console.log(`\nQuerying Overpass for tags on ${idList.length} candidate nodes...`);
let nodeTags = new Map();
if (idList.length) {
  const query = `[out:json][timeout:25];(${idList.map((id) => `node(id:${id});`).join('')});out body;`;
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
  const data = await res.json();
  for (const el of data.elements || []) {
    if (el.type === 'node') nodeTags.set(String(el.id), el.tags || {});
  }
}

const LIGHT_MODE_MARKERS = /tram|light_rail|subway|metro/i;
function isHeavyRailSafe(nodeId) {
  if (String(nodeId).startsWith('S:')) return true; // synthetic station node — only exists for stations with a National Rail CRS code, safe by construction
  const tags = nodeTags.get(String(nodeId));
  if (!tags || Object.keys(tags).length === 0) return true; // untagged shape/junction vertex — the common case, no evidence of being a light-rail feature
  const joined = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(' ');
  if (LIGHT_MODE_MARKERS.test(joined)) return false;
  if (tags.railway === 'tram_stop') return false;
  return true;
}

// ── Pick the first mode-safe candidate per island ──────────────────────────
const bridges = [];
for (const island of perIsland) {
  let chosen = null;
  for (const c of island.candidates) {
    if (c.distM > THRESHOLD_M) break; // sorted ascending — nothing further will pass either
    const fromOk = isHeavyRailSafe(c.from);
    const toOk = isHeavyRailSafe(c.to);
    if (fromOk && toOk) { chosen = c; break; }
    console.log(`  REJECTED candidate for ${island.anchor}: ${c.from} <-> ${c.to} (${Math.round(c.distM)}m) — mode guard failed (from tags: ${JSON.stringify(nodeTags.get(String(c.from)) || {})}, to tags: ${JSON.stringify(nodeTags.get(String(c.to)) || {})})`);
  }
  if (!chosen) { console.log(`NO SAFE BRIDGE FOUND for ${island.anchor} within ${THRESHOLD_M}m — left unbridged, needs manual review`); continue; }
  bridges.push({
    anchor: island.anchor,
    crs: island.crs,
    from: chosen.from,
    to: chosen.to,
    distM: Math.round(chosen.distM * 100) / 100,
    fromTags: nodeTags.get(String(chosen.from)) || null,
    toTags: nodeTags.get(String(chosen.to)) || null,
  });
  console.log(`BRIDGE ${island.anchor}: ${chosen.from} <-> ${chosen.to} (${Math.round(chosen.distM)}m)`);
}

writeFileSync(OUT_PATH, JSON.stringify({ generated_at: new Date().toISOString(), threshold_m: THRESHOLD_M, bridges }, null, 2));
console.log(`\n${bridges.length}/${ANCHORS.length} islands bridged. Written to ${OUT_PATH}`);

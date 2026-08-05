#!/usr/bin/env node
/**
 * attribute-by-calling-points.mjs — gives an operator its line by routing
 * between the stations it actually calls at.
 *
 * WHY. Hull Trains has ZERO segments in the graph, not because its track is
 * missing but because no OSM route relation carries "Hull Trains" as operator.
 * Every kilometre it runs on already exists under NT, TP, GC/GR/LD and GTR.
 * So this is an attribution fix, not an extraction one, and it needs a source
 * of truth that OSM does not have: the published calling pattern.
 *
 * HOW. Dijkstra between consecutive calling points over data/routing-graph.json,
 * collecting the segment_id of every edge traversed. That graph already encodes
 * real track connectivity (it is what From/To pathfinding uses), so the route it
 * returns is track the trains can physically take.
 *
 * PROVENANCE. Routing-derived, so nothing upstream asserts it — every touched
 * segment gets operator_precision[op] = 'inferred', the same marking used by
 * ingest-branch-ways.mjs and the Askern split. A relation-sourced attribution is
 * never touched.
 *
 * AMBIGUITY IS REPORTED, NOT HIDDEN. Between two calling points there is often
 * more than one physically valid path (relief lines, avoiding curves, freight
 * chords). Dijkstra returns the shortest, which is usually the fast line, but
 * "shortest" is not evidence. Any leg whose second-best path is within
 * AMBIGUITY_MARGIN of the best is flagged in the report so a human can check it,
 * rather than silently accepting one.
 *
 * Usage:
 *   node scripts/attribute-by-calling-points.mjs --dry-run
 *   node scripts/attribute-by-calling-points.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const RG_PATH = path.join(__dirname, '..', 'data', 'routing-graph.json');
const DRY = process.argv.includes('--dry-run');
const AMBIGUITY_MARGIN = 1.15;   // second-best within 15% of best => flag the leg
// A routed leg must not be wildly longer than the straight line between its two
// stations. THIS GUARD IS NOT THEORETICAL: the first run routed Hull->Cottingham
// as 87.7 km and Cottingham->Beverley as 99.9 km, against real distances of
// roughly 8 km and 5 km — the Hull-Beverley line is not connected in the routing
// graph, so Dijkstra went the long way round via the whole of East Yorkshire and
// would have painted Hull Trains onto ~190 km of track it never touches. A leg
// failing this is REPORTED AND DROPPED, never attributed on a guess.
const MAX_LEG_DETOUR = 2.5;

/**
 * Calling patterns, in route order, each verified against a real source rather
 * than inferred from the network's shape.
 */
const PATTERNS = [
  {
    op: 'HT',
    label: 'Hull Trains (London King\'s Cross - Hull/Beverley)',
    source: 'Wikipedia "Hull Trains", checked 2026-08-05: KGX, Stevenage (limited), Grantham, Retford, Doncaster, Selby, Howden, Brough, Hull Paragon, then Cottingham (CGM, not COT which is Cottingley near Leeds) and Beverley on two services (one weekday, one weekend).',
    legs: [
      // Main route.
      ['KGX', 'SVG', 'GRA', 'RET', 'DON', 'SBY', 'HOW', 'BUH', 'HUL'],
      // Beverley extension — a genuine if infrequent service, so the track is
      // really run over and belongs on the map.
      ['HUL', 'CGM', 'BEV'],
    ],
  },
];

const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
const rg = JSON.parse(readFileSync(RG_PATH, 'utf8'));
const segById = new Map(graph.segments.map((s) => [s.id, s]));
// Station coordinates by CRS. NOT from routing-graph's node_coord: station_node
// maps a CRS to a synthetic node id like "S:HUL", which node_coord (keyed by real
// OSM node ids) has no entry for — so the first version of the detour guard
// silently never fired and the 87.7 km Hull->Cottingham leg sailed through.
const stationList = JSON.parse(readFileSync(path.join(__dirname, '..', 'station-list.json'), 'utf8'));
const crsCoord = new Map();
for (const r of stationList) if (r.crs && r.lat != null && r.lon != null) crsCoord.set(r.crs, [r.lon, r.lat]);

/** Shortest path by length_m. Returns {length, segments:[id], nodes:[n]} or null. */
function shortestPath(from, to, banEdge) {
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const seen = new Set();
  const frontier = [[0, from]];
  while (frontier.length) {
    frontier.sort((a, b) => a[0] - b[0]);
    const [d, node] = frontier.shift();
    if (seen.has(node)) continue;
    seen.add(node);
    if (node === to) {
      const segments = [], nodes = [node];
      let cur = node;
      while (prev.has(cur)) {
        const [p, sid] = prev.get(cur);
        if (sid != null) segments.push(sid);
        cur = p; nodes.push(cur);
      }
      return { length: d, segments: [...new Set(segments)], nodes: nodes.reverse() };
    }
    for (const e of rg.nodes[node] || []) {
      const sid = e.edge && e.edge.segment_id;
      if (banEdge && banEdge === node + '>' + e.to) continue;
      const nd = d + (e.length_m || 0);
      if (dist.has(e.to) && dist.get(e.to) <= nd) continue;
      dist.set(e.to, nd);
      prev.set(e.to, [node, sid]);
      frontier.push([nd, e.to]);
    }
  }
  return null;
}

const report = [];
for (const pat of PATTERNS) {
  console.log(`\n[${pat.op}] ${pat.label}`);
  console.log(`  source: ${pat.source}`);
  const all = new Set();
  const ambiguous = [];
  const dropped = [];
  let failed = 0;
  for (const leg of pat.legs) {
    for (let i = 0; i < leg.length - 1; i++) {
      const a = rg.station_node[leg[i]], b = rg.station_node[leg[i + 1]];
      if (!a || !b) { console.log(`    ${leg[i]}->${leg[i + 1]}: station not in routing graph`); failed++; continue; }
      const best = shortestPath(a, b);
      if (!best) { console.log(`    ${leg[i]}->${leg[i + 1]}: NO PATH`); failed++; continue; }
      // Straight-line sanity check — see MAX_LEG_DETOUR.
      const ca = crsCoord.get(leg[i]);
      const cb = crsCoord.get(leg[i + 1]);
      let detour = null;
      if (ca && cb) {
        const rad = (d) => d * Math.PI / 180;
        const dLat = rad(cb[1] - ca[1]), dLon = rad(cb[0] - ca[0]);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(ca[1])) * Math.cos(rad(cb[1])) * Math.sin(dLon / 2) ** 2;
        const straight = 2 * 6371000 * Math.asin(Math.sqrt(h));
        if (straight > 0) detour = best.length / straight;
      }
      if (detour !== null && detour > MAX_LEG_DETOUR) {
        console.log(`    ${leg[i]} -> ${leg[i + 1]}: ${(best.length / 1000).toFixed(1)} km but only ${(best.length / detour / 1000).toFixed(1)} km apart ` +
          `(${detour.toFixed(1)}x detour) — DROPPED, the direct line is missing from the routing graph`);
        dropped.push(`${leg[i]}->${leg[i + 1]} (${detour.toFixed(1)}x detour)`);
        continue;
      }
      best.segments.forEach((s) => all.add(s));
      // Second-best: ban the first hop of the best path and re-route. Cheap
      // proxy for "is there another plausible way round".
      let alt = null;
      if (best.nodes.length > 1) alt = shortestPath(a, b, best.nodes[0] + '>' + best.nodes[1]);
      const ratio = alt ? alt.length / best.length : Infinity;
      const flag = ratio < AMBIGUITY_MARGIN ? '  ⚠ AMBIGUOUS' : '';
      if (flag) ambiguous.push(`${leg[i]}->${leg[i + 1]} (alt route within ${((ratio - 1) * 100).toFixed(1)}%)`);
      console.log(`    ${leg[i]} -> ${leg[i + 1]}: ${(best.length / 1000).toFixed(1)} km, ${best.segments.length} segments${flag}`);
    }
  }
  const fresh = [...all].filter((id) => segById.get(id) && !segById.get(id).operators.includes(pat.op));
  const km = fresh.reduce((t, id) => t + segById.get(id).length_m, 0) / 1000;
  console.log(`  -> ${fresh.length} segments to attribute, ${km.toFixed(1)} km` + (failed ? `, ${failed} legs FAILED` : ''));
  if (ambiguous.length) {
    console.log(`  ⚠ ${ambiguous.length} leg(s) with a plausible alternative route — check these by hand:`);
    ambiguous.forEach((x) => console.log(`      ${x}`));
  }
  if (dropped.length) {
    console.log(`  ⚠ ${dropped.length} leg(s) DROPPED as implausible detours (direct track missing from the graph):`);
    dropped.forEach((x) => console.log(`      ${x}`));
  }
  report.push({ op: pat.op, segments: fresh.length, km: +km.toFixed(1), ambiguous_legs: ambiguous, dropped_legs: dropped, source: pat.source });
  if (!DRY) {
    for (const id of fresh) {
      const s = segById.get(id);
      s.operators = [...s.operators, pat.op];
      s.operator_precision = { ...(s.operator_precision || {}), [pat.op]: 'inferred' };
      s.calling_point_routed = true;
    }
  }
}

if (DRY) { console.log('\nDRY RUN — line-segments.json untouched.'); process.exit(0); }
graph.calling_point_attribution = { generated_at: new Date().toISOString(), patterns: report };
writeFileSync(SEG_PATH, JSON.stringify(graph));
console.log('\nWritten:', SEG_PATH);

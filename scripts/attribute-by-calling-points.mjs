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
  {
    op: 'NT',
    label: 'Northern (Pontefract Baghill - Moorthorpe - South Elmsall)',
    source: 'Northern\'s own March 2026 network map (user-supplied PDF, checked 2026-08-06): Pontefract Baghill, Moorthorpe and South Elmsall all appear as served stations. Matches existing 2023/24 station-to-station journey data already on record (353 Baghill<->Moorthorpe, 290 Baghill<->Swinton). Segment 2304 (Moorthorpe) carried XC only and segment 2316 (South Elmsall) carried GR only before this — the track was already in the graph, just missing the NT attribution, same shape of gap as Hull Trains above.',
    legs: [
      ['PFR', 'MRP', 'SES'],
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
  // ── PARALLEL-TRACK EXPANSION ───────────────────────────────────────────
  // A shortest path picks ONE track. Main lines are modelled as several
  // parallel segments (fast and slow lines are separate ways in OSM), so the
  // raw path attributes one of them and leaves its neighbours bare — the
  // rendered line then hops between parallels and reads as broken. Measured at
  // Huntingdon: 4 segments in the area, only 1 attributed, the other three
  // being the same corridor's other tracks.
  //
  // So every segment that runs ALONGSIDE the routed path is pulled in too: it
  // must lie within PARALLEL_M of the path along most of its length AND already
  // carry at least one operator the path itself runs with. The second condition
  // is what stops this leaking onto crossing branches and depot roads that
  // merely pass close by — they are not part of the corridor and do not share
  // its operators.
  const PARALLEL_M = 120;
  {
    const pathSegs = [...all].map((id) => segById.get(id)).filter(Boolean);
    const corridorOps = new Set(pathSegs.flatMap((s) => s.operators || []));
    const rad = (d) => d * Math.PI / 180;
    const near = (a, b) => {
      const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
      return 2 * 6371000 * Math.asin(Math.sqrt(h));
    };
    // Coarse grid over the path so this stays O(n) rather than O(n*m).
    const grid = new Map();
    const cell = (c) => Math.round(c[0] * 200) + ':' + Math.round(c[1] * 200);
    for (const s of pathSegs) for (const c of s.coords) {
      const k = cell(c);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(c);
    }
    let added = 0;
    for (const s of graph.segments) {
      if (all.has(s.id)) continue;
      if (!(s.operators || []).some((o) => corridorOps.has(o))) continue;
      let hits = 0, checked = 0;
      for (let i = 0; i < s.coords.length; i += Math.max(1, Math.floor(s.coords.length / 12))) {
        const c = s.coords[i];
        checked++;
        let best = Infinity;
        const cx = Math.round(c[0] * 200), cy = Math.round(c[1] * 200);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          for (const p of grid.get((cx + dx) + ':' + (cy + dy)) || []) {
            const d = near(c, p);
            if (d < best) best = d;
          }
        }
        if (best <= PARALLEL_M) hits++;
      }
      if (checked && hits / checked >= 0.8) { all.add(s.id); added++; }
    }
    if (added) console.log(`    parallel-track expansion: +${added} segments alongside the routed path`);
  }

  // ── OVERSHOOT SPLIT ────────────────────────────────────────────────────
  // Attribution is WHOLE-SEGMENT, so a route using part of a long segment
  // paints all of it: segment 2548 is 80.7 km and pushed Hull Trains 44 km past
  // Beverley toward Driffield. TWO BLUNTER FIXES WERE TRIED AND REJECTED first,
  // recorded so neither is retried:
  //   - corridor containment (70% within 6 km of the calling-point polyline)
  //     dropped 42 segments and took Selby AND Beverley to zero coverage, because
  //     real track curves far from the chord — Doncaster to Selby is 60 km of
  //     railway across a 30 km gap;
  //   - dropping any segment reaching outside the calling-point envelope removed
  //     the overshoot but also removed Selby, Howden, Cottingham and Beverley,
  //     since the segments serving them are long ones that continue past.
  // Both failed the same way: a segment is genuinely PART on-route and PART not,
  // and no keep/drop rule can express that.
  //
  // So split it. The portion inside the envelope keeps the original id and gains
  // the operator; the portion outside becomes a NEW segment carrying the
  // original operators but not this one. Safe because every downstream consumer
  // is regenerated from this file afterwards — the routing graph (and therefore
  // map.html's geometry pointers) is rebuilt in stages 6-9, so new ids are
  // picked up rather than dangling.
  const OVERSHOOT_M = 5000;
  {
    const pts = [];
    for (const leg of pat.legs) for (const crs of leg) { const c = crsCoord.get(crs); if (c) pts.push(c); }
    const minLon = Math.min(...pts.map((c) => c[0])), maxLon = Math.max(...pts.map((c) => c[0]));
    const minLat = Math.min(...pts.map((c) => c[1])), maxLat = Math.max(...pts.map((c) => c[1]));
    const dLat = OVERSHOOT_M / 111320;
    const dLon = OVERSHOOT_M / (111320 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
    const inside = (c) => c[0] >= minLon - dLon && c[0] <= maxLon + dLon && c[1] >= minLat - dLat && c[1] <= maxLat + dLat;
    const rad = (d) => d * Math.PI / 180;
    const dist = (a, b) => {
      const dla = rad(b[1] - a[1]), dlo = rad(b[0] - a[0]);
      const h = Math.sin(dla / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dlo / 2) ** 2;
      return 2 * 6371000 * Math.asin(Math.sqrt(h));
    };
    const lenOf = (cs) => { let t = 0; for (let i = 1; i < cs.length; i++) t += dist(cs[i - 1], cs[i]); return t; };
    let maxId = Math.max(...graph.segments.map((x) => x.id));
    const split = [];
    for (const id of [...all]) {
      const s2 = segById.get(id);
      if (!s2 || s2.coords.every(inside)) continue;
      // Keep the single longest run of consecutive in-envelope points.
      let bestA = -1, bestB = -1, curA = -1;
      for (let i = 0; i <= s2.coords.length; i++) {
        const ok = i < s2.coords.length && inside(s2.coords[i]);
        if (ok && curA < 0) curA = i;
        if (!ok && curA >= 0) { if (i - curA > bestB - bestA) { bestA = curA; bestB = i; } curA = -1; }
      }
      if (bestA < 0 || bestB - bestA < 2) { all.delete(id); split.push(`${id} wholly outside — dropped`); continue; }
      // NODES MUST BE SLICED WITH THE COORDS. The first version created the
      // remainders with `nodes: []`, which silently destroyed topology: the
      // routing graph builds adjacency from endpoint node ids, so a segment with
      // none connects to nothing. That orphaned the Bridlington line (ATB, BDT,
      // BEM, DRF, FIL, HUB, HUT, NFN, SOM) into its own island and produced a
      // bridge with an `undefined` endpoint that the routing build then skipped
      // every run — 28 bridges written, 27 applied, stable across passes, which
      // is exactly the mismatch CLAUDE.md says to treat as a failure.
      const hasNodes = Array.isArray(s2.nodes) && s2.nodes.length === s2.coords.length;
      const keep = s2.coords.slice(bestA, bestB);
      const keepNodes = hasNodes ? s2.nodes.slice(bestA, bestB) : [];
      const restPairs = [
        [s2.coords.slice(0, Math.max(1, bestA + 1)), hasNodes ? s2.nodes.slice(0, Math.max(1, bestA + 1)) : []],
        [s2.coords.slice(bestB - 1), hasNodes ? s2.nodes.slice(bestB - 1) : []],
      ].filter(([a]) => a.length >= 2);
      const rest = restPairs.map(([a]) => a);
      for (const [r, rn] of restPairs) {
        maxId += 1;
        graph.segments.push({
          id: maxId, nodes: rn, coords: r,
          operators: s2.operators.slice(), way_ids: (s2.way_ids || []).slice(),
          length_m: Math.round(lenOf(r)),
          ...(s2.operator_precision ? { operator_precision: { ...s2.operator_precision } } : {}),
          split_from: s2.id, split_reason: `off-route remainder after ${pat.op} overshoot split`,
        });
      }
      s2.coords = keep;
      if (hasNodes) s2.nodes = keepNodes;
      s2.length_m = Math.round(lenOf(keep));
      s2.split_for = pat.op;
      split.push(`${id}: kept ${(s2.length_m / 1000).toFixed(1)} km on-route, ${rest.length} remainder segment(s)`);
    }
    if (split.length) {
      console.log(`    overshoot split: ${split.length} segment(s) cut at the route envelope:`);
      split.slice(0, 8).forEach((x) => console.log(`      ${x}`));
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

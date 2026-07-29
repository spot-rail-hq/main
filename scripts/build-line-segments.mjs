#!/usr/bin/env node
/**
 * scripts/build-line-segments.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 2 of the operator-colored rail line project (see the approved plan,
 * "Operator-colored rail line rendering" — mossy-drifting-shore.md — for
 * full context). Builds the physical track SEGMENT GRAPH that Phase 5's
 * rendering fans out per operator: distinct colored lines side-by-side
 * wherever track is genuinely shared.
 *
 * ─── Method (validated empirically against local Overpass before writing
 * this, per the plan's investigation) ───────────────────────────────────
 * 1. Pull all GB train/light_rail/tram/subway route relations (id + tags),
 *    classify each via scripts/lib/operator-classify.mjs (same mapping as
 *    Phase 0/1 — one operator key per relation).
 * 2. Pull each relation's WAY members with an EMPTY role only — role=""
 *    is the actual running track; "platform"/"platform_entry_only"/
 *    "platform_exit_only" way members are station platform geometry, not
 *    track, and are excluded (confirmed against a real relation: 468 of
 *    486 members were empty-role track ways, the rest were platform/stop).
 * 3. Pull geometry for the union of referenced ways (`out geom;` — a single
 *    request returns both the OSM node IDs AND their coordinates, aligned
 *    by index, so node-ID graph-building needs no separate node fetch).
 * 4. Build a fine-grained node graph: one edge per consecutive node pair
 *    in each way, tagged with the set of operator keys that traverse it
 *    (union across every way that contains that literal node pair, which
 *    is what makes shared track "shared" in the graph).
 * 5. A node is SIGNIFICANT (a segment boundary) if its degree != 2, OR its
 *    degree is 2 but the two incident edges carry different operator sets
 *    — i.e. a segment boundary is either a real physical junction/dead end,
 *    or the point where "which operators run here" changes, even without a
 *    physical junction (e.g. one of several parallel services turns off).
 *    Station stop-position nodes are NOT yet folded in as significant —
 *    that's Phase 3, reusing the already-verified PTv2 stop nodes from
 *    fetch-osm-facts.mjs rather than rebuilding node verification here.
 * 6. Contract each maximal run between two significant nodes into one
 *    segment (handles closed loops — e.g. Glasgow Subway — as a special
 *    case with no significant node at all).
 *
 * ─── Scope: bounded checkpoint by default ─────────────────────────────
 * Per the plan's explicit checkpoint-before-national-run requirement, this
 * script defaults to the Doncaster–York–Newcastle ECML corridor (the
 * hardest known case — see the plan's LNER/Grand Central zero-node-overlap
 * finding) plus whatever branch lines fall inside that bbox (the York–
 * Harrogate line, a simple single/few-operator contrast case, falls inside
 * it for free). Set LINE_SEGMENTS_NATIONAL=1 to run the full GB network —
 * do not do this until the checkpoint report has been reviewed.
 *
 * Run:
 *   node scripts/build-line-segments.mjs                  # checkpoint (bbox)
 *   LINE_SEGMENTS_NATIONAL=1 node scripts/build-line-segments.mjs   # full GB
 *
 * Output: scripts/output/line-segments-checkpoint.json (or
 * scripts/output/line-segments.json for a national run) — segments +
 * a stats report for review before Phase 3 touches this.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classify, classifyTags, splitTflLine, applyRelationOverride, RELATION_ID_OVERRIDES, heritageOverrideStatus, unmappedHeritageNames } from './lib/operator-classify.mjs';
import { HERITAGE_CANONICAL, HERITAGE_META } from './lib/heritage-canonical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');

const OVERPASS_URL = process.env.OVERPASS_URL || 'http://localhost:12345/api/interpreter';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

const NATIONAL = process.env.LINE_SEGMENTS_NATIONAL === '1';
// s, w, n, e — Doncaster (53.52,-1.13) / York (53.96,-1.09) / Newcastle
// (54.97,-1.61) corridor, widened slightly to also catch the York–
// Harrogate branch as a simple contrast case, per the plan's checkpoint
// requirement (ECML corridor + one simple branch line).
const CHECKPOINT_BBOX = process.env.LINE_SEGMENTS_BBOX
  ? process.env.LINE_SEGMENTS_BBOX.split(',').map(Number)
  : [53.35, -1.75, 55.05, -0.85];
// Optional label so a second/third checkpoint corridor (e.g. a Scotland or
// South West run, for cross-corridor validation) writes to its own file
// instead of overwriting the default corridor's output.
const LABEL = process.env.LINE_SEGMENTS_LABEL || '';
const OUT_PATH = path.join(OUT_DIR, NATIONAL ? 'line-segments.json' : `line-segments-checkpoint${LABEL ? '-' + LABEL : ''}.json`);

async function overpassQuery(ql, { retries = 3, timeoutMs = 180000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status === 504) && attempt < retries) {
        const waitMs = attempt * 1000;
        console.warn(`  Overpass ${res.status}, retrying in ${waitMs}ms (attempt ${attempt}/${retries})…`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const body = await res.text();
      throw new Error(`Overpass request failed: HTTP ${res.status}\n${body.slice(0, 300)}`);
    } catch (err) {
      clearTimeout(t);
      if (attempt < retries) {
        console.warn(`  Overpass request errored (${err.message}), retrying (attempt ${attempt}/${retries})…`);
        continue;
      }
      throw err;
    }
  }
}

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function edgeKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }

// Live track only. Anything outside this set is closed/planned and must never
// enter the segment graph — see the reject-logging block in Step 3 for the
// measured damage this prevents. Kept as one shared constant so the heritage
// way-level path and the relation path cannot drift apart.
const LIVE_RAILWAY_VALUES = ['rail', 'narrow_gauge', 'preserved', 'light_rail', 'tram', 'subway', 'funicular', 'monorail'];
const LIVE_RAILWAY_CLAUSE = `["railway"~"^(${LIVE_RAILWAY_VALUES.join('|')})$"]`;
const rejectedWayIds = new Set();

function operatorKeyFor(rel) {
  if (rel.bucket === 'toc') return rel.code;
  if (rel.bucket === 'metro') return rel.canonical;
  return 'Heritage';
}

async function main() {
  console.log(NATIONAL ? '=== NATIONAL run ===' : `=== Checkpoint run — bbox [${CHECKPOINT_BBOX.join(', ')}] (Doncaster–York–Newcastle corridor + York–Harrogate branch) ===`);
  const bboxClause = NATIONAL ? '' : `[bbox:${CHECKPOINT_BBOX.join(',')}]`;

  // ─── Step 1: relations in scope ─────────────────────────────────────
  console.log('\n[1/5] Querying route relations…');
  const relQ = `[out:json][timeout:180]${bboxClause};rel["type"="route"]["route"~"^(train|light_rail|tram|subway|railway)$"];out tags;`;
  const relData = await overpassQuery(relQ);
  const relById = new Map();
  // Phase 3: "Transport for London" is a single bare operator tag covering
  // all 137 Underground+Overground relations — split each one out to its
  // real specific line via the relation's own `name` tag (see splitTflLine
  // in operator-classify.mjs for why this is reliable). Tracked here so the
  // checkpoint can report exactly how many split cleanly vs. fell back to
  // the generic bucket (should be 0, confirmed empirically beforehand, but
  // not assumed for every future re-run — flagged, not silently dropped).
  let tflSplitCount = 0, tflUnsplitCount = 0;
  let overrideCount = 0;
  for (const r of relData.elements) {
    const rawOp = r.tags.operator || r.tags.brand || '(none)';
    // classifyTags, not classify: heritage relations overwhelmingly have NO
    // operator tag (5 of 72 carry one), so the join must fall back to `name`.
    let cls = classifyTags(r.tags);
    if (cls.bucket === 'metro' && cls.canonical === 'Transport for London') {
      const line = splitTflLine(r.tags.name);
      if (line) { cls.canonical = line; tflSplitCount++; }
      else tflUnsplitCount++;
    }
    // Phase 3 follow-up: only ever overrides relations classify() would
    // otherwise EXCLUDE — a hand-verified per-relation-ID table (see
    // RELATION_ID_OVERRIDES), not a blanket rule, so this can never
    // silently reclassify something that was already toc/metro/heritage.
    if (cls.bucket === 'excluded' && RELATION_ID_OVERRIDES[r.id]) {
      cls = applyRelationOverride(r.id, cls);
      overrideCount++;
    }
    relById.set(r.id, { id: r.id, raw: rawOp, ...cls, route: r.tags.route, name: r.tags.name, from: r.tags.from, to: r.tags.to });
  }
  // CONTAINMENT (2026-07-29, decision — not provisional). The relation query was
  // widened to route=railway because that is how heritage relations are tagged
  // (Bluebell, Swanage, Llangollen). Main-line route=railway relations arriving
  // alongside is a SIDE EFFECT and is excluded here: a route=railway relation is
  // admitted only if it classifies as heritage.
  //
  // Measured cost of NOT containing it: non-heritage track 21,485 -> 28,401 km
  // (+6,916 km) and the graph 5,371 -> 8,836 segments. Declined because the base
  // rail tileset already draws that track as grey context, so admitting it to the
  // OPERATOR graph mainly adds unattributable, unclickable segments — a heavier
  // hover expression, more clutter, and empty panels on click, since most of it
  // has no passenger operator to colour it with.
  //
  // Worth revisiting in a narrower form: admit only route=railway track that
  // resolves to a real passenger operator, with service=* (yard/siding/spur/
  // crossover) and usage=industrial excluded. See LINE-COLORING-RUNBOOK.md.
  const relations = [...relById.values()].filter((r) => {
    if (r.bucket !== 'toc' && r.bucket !== 'metro' && r.bucket !== 'heritage') return false;
    if (r.route === 'railway' && r.bucket !== 'heritage') return false;
    return true;
  });
  const railwayExcluded = [...relById.values()].filter((r) => r.route === 'railway' && r.bucket !== 'heritage' && (r.bucket === 'toc' || r.bucket === 'metro')).length;
  console.log(`  ${relData.elements.length} relations in scope, ${relations.length} colorable (toc/metro/heritage — excluded/unrecognized dropped)`);
  console.log(`  ${railwayExcluded} route=railway relations classified toc/metro were EXCLUDED by containment (heritage-only admission — see the comment above)`);
  if (tflSplitCount || tflUnsplitCount) {
    console.log(`  TfL line split: ${tflSplitCount} relations split to their real specific line, ${tflUnsplitCount} fell back to generic 'Transport for London'`);
  }
  if (overrideCount) {
    console.log(`  Relation-ID overrides applied: ${overrideCount} (recovered from 'excluded' via hand-verified real-world operator lookup)`);
  }

  // ─── Step 2: way members per relation (track ways only, role="") ──────
  console.log('\n[2/5] Fetching way members per relation…');
  const relationWays = new Map(); // relId -> [wayId,...]
  const RCHUNK = 100;
  for (let i = 0; i < relations.length; i += RCHUNK) {
    const batch = relations.slice(i, i + RCHUNK).map((r) => r.id);
    const q = `[out:json][timeout:180];rel(id:${batch.join(',')});out body;`;
    const data = await overpassQuery(q);
    for (const el of data.elements) {
      if (el.type !== 'relation') continue;
      const wayIds = el.members.filter((m) => m.type === 'way' && (m.role || '') === '').map((m) => m.ref);
      relationWays.set(el.id, wayIds);
    }
    console.log(`  ${Math.min(i + RCHUNK, relations.length)}/${relations.length} relations`);
  }

  // ─── Step 2b: WAY-LEVEL heritage path (2026-07-29) ────────────────────
  // Most heritage railways have no route relation at all — there is no
  // scheduled service to model, so the track is mapped as plain ways. An
  // operator-only, relation-only net found 10 railways; the real population is
  // ~180. This pass pulls heritage track directly and synthesises ONE
  // PSEUDO-RELATION per canonicalised railway, so everything from Step 3
  // onward (geometry, edge graph, segment contraction) is completely unchanged
  // — it cannot tell a pseudo-relation from a real one.
  //
  // Deduplicated by way ID against the relation path: ~922 ways are reachable
  // both ways and must not be counted twice.
  console.log('\n[2b/5] Way-level heritage extraction…');
  const heritageWayIds = new Map(); // wayId -> canonical railway
  const seenHeritageStrings = new Set();
  const heritageWayTags = [];       // for the pair-override guard
  {
    const q = `[out:json][timeout:250]${bboxClause};way${LIVE_RAILWAY_CLAUSE}["name"];out ids tags;`;
    const data = await overpassQuery(q, { timeoutMs: 300000 });
    for (const w of data.elements) {
      if (w.type !== 'way') continue;
      const t = w.tags || {};
      const cls = classifyTags(t);
      if (cls.bucket !== 'heritage' || !cls.heritageRailway) continue;
      heritageWayIds.set(w.id, cls.heritageRailway);
      if (t.name) seenHeritageStrings.add(t.name);
      if (t.operator) seenHeritageStrings.add(t.operator);
      heritageWayTags.push({ name: t.name, operator: t.operator });
    }
    console.log(`  ${data.elements.length} named live-track ways scanned, ${heritageWayIds.size} matched the heritage map`);
  }
  // Pair-override guard — warning only, never throws. See
  // heritageOverrideStatus() for why a corrected upstream must be visible.
  for (const line of heritageOverrideStatus(heritageWayTags)) console.log(`  ${line}`);

  // Synthesise pseudo-relations, one per canonical railway. Negative IDs so
  // they can never collide with a real OSM relation ID.
  const byRailway = new Map();
  for (const [wid, railway] of heritageWayIds) {
    if (!byRailway.has(railway)) byRailway.set(railway, []);
    byRailway.get(railway).push(wid);
  }
  let pseudoId = -1, pseudoAdded = 0, pseudoWaysNew = 0;
  const alreadyReferenced = new Set();
  for (const ways of relationWays.values()) for (const w of ways) alreadyReferenced.add(w);
  for (const [railway, ways] of byRailway) {
    const fresh = ways.filter((w) => !alreadyReferenced.has(w));
    pseudoWaysNew += fresh.length;
    const meta = HERITAGE_META[railway] || {};
    const rel = {
      id: pseudoId, raw: railway, bucket: 'heritage', canonical: 'Heritage', code: null,
      name: railway, heritageRailway: railway, heritageSlug: meta.slug || null,
      heritageType: meta.type || null, heritageTypeSecondary: meta.secondary || null,
      heritageBand: meta.band || null, pseudo: true,
    };
    relById.set(pseudoId, rel);
    relations.push(rel);
    relationWays.set(pseudoId, ways);
    pseudoId -= 1; pseudoAdded += 1;
  }
  console.log(`  ${pseudoAdded} pseudo-relations synthesised covering ${byRailway.size} railways (${pseudoWaysNew} ways not already reachable via a real relation)`);
  const unmapped = unmappedHeritageNames(seenHeritageStrings);
  if (unmapped.length) {
    console.log(`  UNMAPPED HERITAGE: ${unmapped.length} strings seen on heritage-adjacent track but absent from HERITAGE_CANONICAL — these railways are DROPPED SILENTLY. Add them to scripts/lib/heritage-canonical.mjs:`);
    for (const u of unmapped.slice(0, 40)) console.log(`    ${u}`);
    if (unmapped.length > 40) console.log(`    … and ${unmapped.length - 40} more`);
  } else {
    console.log('  UNMAPPED HERITAGE: none — every heritage string seen is in the map');
  }

  // ─── Step 3: geometry for the union of referenced ways ────────────────
  const allWayIds = new Set();
  for (const ways of relationWays.values()) for (const w of ways) allWayIds.add(w);
  console.log(`\n[3/5] Fetching geometry for ${allWayIds.size} distinct track ways${NATIONAL ? '' : ' (bbox-filtered to the corridor)'}…`);
  const wayGeom = new Map(); // wayId -> {nodeIds, coords}
  const wayIdsArr = [...allWayIds];
  const WCHUNK = 300;
  // NOTE: a global `[bbox:...]` setting does NOT filter an explicit
  // `way(id:...)` id-list query (confirmed empirically — Overpass only
  // applies the global bbox to tag-based selectors). The per-statement
  // form `way(id:...)(s,w,n,e)` is what actually clips to the corridor;
  // using the global form here silently pulled in the FULL national
  // extent of every relation that merely passes through the corridor
  // (caught via a 349km "segment" that turned out to run to Plymouth).
  const wayBboxSuffix = NATIONAL ? '' : `(${CHECKPOINT_BBOX.join(',')})`;
  for (let i = 0; i < wayIdsArr.length; i += WCHUNK) {
    const batch = wayIdsArr.slice(i, i + WCHUNK);
    // 2026-07-29 BUGFIX — THE RELATION NET HAD NO RAILWAY FILTER.
    // `way(id:...)` returned every member of every in-scope relation regardless
    // of its `railway` value, so route relations that trace a historic
    // alignment dragged abandoned/razed/disused track into the segment graph.
    // Measured against the live extract: 849 closed-tagged ways reached the
    // heritage extraction (774 of them through this net), and 30 reached
    // line-segments.json itself — producing six main-line segments that are
    // 100% demolished track rendering as live operator lines (2999 TP,
    // 1969/1984 GW, 4778/4790/4797 SR) plus segment 5730, a 31 km "Heritage"
    // line on the Lynton & Barnstaple alignment that is 78% abandoned.
    //
    // The filter belongs HERE and nowhere else: this is the single choke point
    // every way passes through, whichever relation referenced it, so one rule
    // covers the main-line and heritage paths together. Filtering at the
    // RELATION query instead would drop whole relations rather than the closed
    // ways inside otherwise-live ones, which is not the failure.
    //
    // Rejects are COUNTED AND LOGGED, never dropped silently — a way removed
    // here shortens or splits a segment, and that must be visible in build
    // output rather than showing up later as an unexplained geometry change.
    const q = `[out:json][timeout:180];way(id:${batch.join(',')})${wayBboxSuffix}${LIVE_RAILWAY_CLAUSE};out geom;`;
    const data = await overpassQuery(q);
    for (const w of data.elements) {
      if (w.type !== 'way' || !w.geometry) continue;
      wayGeom.set(w.id, { nodeIds: w.nodes, coords: w.geometry.map((g) => [g.lon, g.lat]) });
    }
    // ONLY meaningful on a national run. In a bbox-bounded checkpoint a way can
    // be missing because it is outside the corridor, which has nothing to do
    // with its railway value — attributing that to the filter produced a log
    // claiming the Midland Main Line was 95% closed track. A national run has
    // no bbox, so there a missing way IS a filter rejection.
    if (NATIONAL) { for (const id of batch) if (!wayGeom.has(id)) rejectedWayIds.add(id); }
    console.log(`  ${Math.min(i + WCHUNK, wayIdsArr.length)}/${wayIdsArr.length} ways queried, ${wayGeom.size} resolved so far`);
  }
  const droppedWays = allWayIds.size - wayGeom.size;
  if (droppedWays > 0) {
    console.log(`  ${droppedWays} referenced ways had no geometry in scope (expected for a bbox-bounded checkpoint — relations extend beyond the corridor)`);
  }
  // PER-RELATION REJECT REPORT. A relation losing a handful of ways is normal
  // (closed spurs off a live line); a relation losing MOST of its ways means it
  // traces a historic alignment and should probably not be in scope at all.
  // Both cases are printed so neither is invisible.
  if (!NATIONAL) {
    console.log('  (reject-by-railway-value accounting is suppressed on a bbox checkpoint — a missing way here is usually just outside the corridor, not filtered. Run nationally for a meaningful reject report.)');
  }
  if (rejectedWayIds.size) {
    const perRel = [];
    for (const [relId, ways] of relationWays) {
      const rejected = ways.filter((w) => rejectedWayIds.has(w)).length;
      if (rejected) perRel.push({ relId, rejected, total: ways.length, pct: (100 * rejected) / ways.length, name: relById.get(relId)?.name });
    }
    perRel.sort((a, b) => b.pct - a.pct || b.rejected - a.rejected);
    console.log(`  REJECTED ${rejectedWayIds.size} ways as non-live track (railway not in ${LIVE_RAILWAY_VALUES.join('/')}) across ${perRel.length} relations:`);
    for (const p of perRel.slice(0, 25)) {
      // A HIGH RATIO MEANS "INSPECT", NOT "DROP". Lynton & Barnstaple is the
      // counter-example that matters: ~30 km of its 1935 alignment is abandoned
      // and only ~1.5 km at Woody Bay is live, so it scores ~95% rejected while
      // being a real operating railway. The ratio tells you a relation is mostly
      // closed track; it tells you nothing about whether the live remainder is a
      // going concern. Check each one against the heritage table before acting.
      const flag = p.pct >= 50 ? '  <-- MOSTLY CLOSED TRACK — INSPECT, do not drop on this alone (cf. Lynton & Barnstaple: 95% closed, still a live railway)' : '';
      console.log(`    rel/${p.relId} ${String(p.name || '').slice(0, 40).padEnd(40)} ${p.rejected}/${p.total} (${p.pct.toFixed(0)}%)${flag}`);
    }
    if (perRel.length > 25) console.log(`    … and ${perRel.length - 25} more relations with rejects`);
  }

  // ─── Step 4: way -> operator-key set, then fine-grained edge graph ────
  console.log('\n[4/5] Building node graph…');
  const wayOperators = new Map(); // wayId -> Set<operatorKey>
  for (const [relId, ways] of relationWays) {
    const rel = relById.get(relId);
    const opKey = operatorKeyFor(rel);
    for (const w of ways) {
      if (!wayGeom.has(w)) continue;
      if (!wayOperators.has(w)) wayOperators.set(w, new Set());
      wayOperators.get(w).add(opKey);
    }
  }

  const edgeOperators = new Map(); // edgeKey -> Set<operatorKey>
  const edgeWays = new Map(); // edgeKey -> Set<wayId> (provenance)
  const adjacency = new Map(); // nodeId -> Set<neighborNodeId>
  const nodeCoord = new Map(); // nodeId -> [lon,lat]

  for (const [wayId, geom] of wayGeom) {
    const ops = wayOperators.get(wayId);
    if (!ops || ops.size === 0) continue;
    const { nodeIds, coords } = geom;
    for (let i = 0; i < nodeIds.length; i++) nodeCoord.set(nodeIds[i], coords[i]);
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const a = nodeIds[i], b = nodeIds[i + 1];
      if (a === b) continue;
      const key = edgeKey(a, b);
      if (!edgeOperators.has(key)) edgeOperators.set(key, new Set());
      for (const op of ops) edgeOperators.get(key).add(op);
      if (!edgeWays.has(key)) edgeWays.set(key, new Set());
      edgeWays.get(key).add(wayId);
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a).add(b);
      adjacency.get(b).add(a);
    }
  }
  console.log(`  ${adjacency.size} distinct nodes, ${edgeOperators.size} distinct edges`);

  // ─── significant nodes: degree != 2, or degree 2 with an operator-set change ──
  const significant = new Set();
  for (const [node, neighbors] of adjacency) {
    if (neighbors.size !== 2) { significant.add(node); continue; }
    const [n1, n2] = [...neighbors];
    const ops1 = edgeOperators.get(edgeKey(node, n1));
    const ops2 = edgeOperators.get(edgeKey(node, n2));
    const same = ops1.size === ops2.size && [...ops1].every((o) => ops2.has(o));
    if (!same) significant.add(node);
  }
  console.log(`  ${significant.size} significant nodes (junctions, dead ends, or operator-set changes)`);

  // ─── Step 5: contract degree-2 chains into segments ────────────────────
  console.log('\n[5/5] Contracting chains into segments…');
  const consumedEdges = new Set();
  const segments = [];

  function walkFrom(start, next) {
    const nodes = [start, next];
    let prev = start, cur = next;
    consumedEdges.add(edgeKey(prev, cur));
    while (!significant.has(cur)) {
      const neighbors = [...adjacency.get(cur)];
      const other = neighbors[0] === prev ? neighbors[1] : neighbors[0];
      if (other === undefined) break; // shouldn't happen for a true degree-2 non-significant node
      consumedEdges.add(edgeKey(cur, other));
      nodes.push(other);
      prev = cur;
      cur = other;
    }
    return nodes;
  }

  for (const node of significant) {
    for (const neighbor of adjacency.get(node)) {
      const key = edgeKey(node, neighbor);
      if (consumedEdges.has(key)) continue;
      const nodes = walkFrom(node, neighbor);
      const opsKey = edgeKey(nodes[0], nodes[1]);
      const operators = [...edgeOperators.get(opsKey)].sort();
      const ways = new Set();
      for (let i = 0; i < nodes.length - 1; i++) for (const w of edgeWays.get(edgeKey(nodes[i], nodes[i + 1]))) ways.add(w);
      const coords = nodes.map((n) => nodeCoord.get(n));
      let length_m = 0;
      for (let i = 0; i < coords.length - 1; i++) length_m += haversineMeters(coords[i], coords[i + 1]);
      segments.push({ id: segments.length, nodes, coords, operators, way_ids: [...ways], length_m: Math.round(length_m) });
    }
  }

  // ─── closed loops with no significant node at all (e.g. Glasgow Subway) ──
  const visitedNodes = new Set();
  for (const seg of segments) for (const n of seg.nodes) visitedNodes.add(n);
  let loopCount = 0;
  for (const node of adjacency.keys()) {
    if (visitedNodes.has(node)) continue;
    // unvisited node implies an isolated all-degree-2, same-operator loop
    const start = node;
    const neighbors = [...adjacency.get(start)];
    if (neighbors.length !== 2) continue; // shouldn't happen — would have been significant
    const nodes = [start];
    let prev = start, cur = neighbors[0];
    nodes.push(cur);
    visitedNodes.add(start);
    while (cur !== start) {
      visitedNodes.add(cur);
      const nb = [...adjacency.get(cur)];
      const other = nb[0] === prev ? nb[1] : nb[0];
      if (other === undefined) break;
      nodes.push(other);
      prev = cur;
      cur = other;
    }
    const opsKey = edgeKey(nodes[0], nodes[1]);
    const opsSet = edgeOperators.get(opsKey);
    if (!opsSet) continue;
    const operators = [...opsSet].sort();
    const ways = new Set();
    for (let i = 0; i < nodes.length - 1; i++) for (const w of edgeWays.get(edgeKey(nodes[i], nodes[i + 1]))) ways.add(w);
    const coords = nodes.map((n) => nodeCoord.get(n));
    let length_m = 0;
    for (let i = 0; i < coords.length - 1; i++) length_m += haversineMeters(coords[i], coords[i + 1]);
    segments.push({ id: segments.length, nodes, coords, operators, way_ids: [...ways], length_m: Math.round(length_m), loop: true });
    loopCount++;
  }
  if (loopCount) console.log(`  ${loopCount} closed-loop segments (no physical junction anywhere on the loop)`);

  console.log(`  ${segments.length} segments emitted`);

  // ─── stats report ───────────────────────────────────────────────────
  const opCounts = {};
  for (const s of segments) {
    const n = s.operators.length;
    opCounts[n] = (opCounts[n] || 0) + 1;
  }
  const maxOps = Math.max(...segments.map((s) => s.operators.length));
  const maxOpsSegments = segments.filter((s) => s.operators.length === maxOps).slice(0, 5);

  // Known open question from the plan: does LNER (GR) ever share a segment
  // with Grand Central (GC) through Doncaster, or do they truly share zero
  // nodes (as found in the original scoping investigation)? Reported
  // directly rather than assumed either way.
  const grGcTogether = segments.filter((s) => s.operators.includes('GR') && s.operators.includes('GC'));
  const grSegments = segments.filter((s) => s.operators.includes('GR')).length;
  const gcSegments = segments.filter((s) => s.operators.includes('GC')).length;

  mkdirSync(OUT_DIR, { recursive: true });
  const output = {
    generated_at: new Date().toISOString(),
    scope: NATIONAL ? 'national' : 'checkpoint',
    bbox: NATIONAL ? null : CHECKPOINT_BBOX,
    relation_count: relations.length,
    way_count: wayGeom.size,
    node_count: adjacency.size,
    edge_count: edgeOperators.size,
    significant_node_count: significant.size,
    segment_count: segments.length,
    operators_per_segment_histogram: opCounts,
    tfl_line_split: { split: tflSplitCount, unsplit: tflUnsplitCount },
    segments,
  };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');

  console.log('\n=== Report ===');
  console.log(`Relations: ${relations.length} colorable in scope`);
  console.log(`Ways: ${wayGeom.size} with geometry (of ${allWayIds.size} referenced)`);
  console.log(`Nodes: ${adjacency.size}, Edges: ${edgeOperators.size}, Significant nodes: ${significant.size}`);
  console.log(`Segments: ${segments.length}`);
  if (tflSplitCount || tflUnsplitCount) {
    console.log(`TfL line split: ${tflSplitCount} split, ${tflUnsplitCount} unsplit (generic 'Transport for London')`);
  }
  console.log('Operators-per-segment distribution:', JSON.stringify(opCounts));
  console.log(`Max operators on one segment: ${maxOps}`);
  for (const s of maxOpsSegments) console.log(`  segment ${s.id}: [${s.operators.join(', ')}] (${(s.length_m / 1000).toFixed(2)}km, ${s.nodes.length} nodes)`);
  console.log(`\nLNER (GR) segments: ${grSegments}, Grand Central (GC) segments: ${gcSegments}, GR+GC together on same segment: ${grGcTogether.length}`);
  if (grGcTogether.length === 0 && grSegments > 0 && gcSegments > 0) {
    console.log('  → Confirms the plan\'s open question: LNER and Grand Central share ZERO segments via node-ID matching in this corridor, despite both plausibly running the same physical Doncaster–York–Newcastle track. This means either (a) they are genuinely on separate physical tracks here (e.g. slow/fast pairs), or (b) OSM mapped their route relations onto parallel-but-distinct way objects for the same real track. A coordinate-proximity fallback pass (turf.js) would be needed to distinguish these — NOT yet implemented, deferred pending your review of this finding.');
  }
  console.log(`\nWritten to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

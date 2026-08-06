#!/usr/bin/env node
/**
 * ingest-branch-ways.mjs — adds WAY-LEVEL track for branches that no OSM route
 * relation covers, so their stations stop rendering with no operator line.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT build-line-segments.mjs.
 * The main extraction is RELATION-driven: step 3 fetches geometry only for ways
 * a route relation references. That is the right default — a route relation is
 * an explicit upstream assertion of which operator runs a line. But six real
 * branches have NO route relation at all (verified 2026-08-04: a `rel(bw)` query
 * against the Wharfedale Line's 67 ways returns zero route relations), so the
 * relation path cannot reach them however it is tuned. Their stations sit
 * 2.4-7.3 km from the nearest attributed track while the track itself is right
 * there, already drawn as grey context by gb-railways.pmtiles.
 *
 * This script is SUPPLEMENTARY and ADDITIVE. It never edits or removes an
 * existing segment; it only appends segments for ways not already present by
 * way_id. That is what keeps it isolated: everything the relation path already
 * produced is byte-identical afterwards.
 *
 * WHY NOT INGEST FROM gb-railways.pmtiles. That tileset proves the track exists
 * but cannot be the source: its features carry only {kind, status, name} — no
 * OSM way or node ids — and tippecanoe has simplified the geometry per zoom. The
 * segment schema needs `nodes` (OSM node ids) for the routing graph's topology,
 * so tile geometry would produce segments that cannot participate in routing.
 * Overpass is the only source that carries both.
 *
 * ── THE ATTRIBUTION IS INFERRED, AND THAT IS THE WHOLE REASON FOR THE FLAG ──
 * These ways tag `operator=Network Rail` — the INFRASTRUCTURE owner, not the
 * train operator. Nothing in the way tags says "Northern runs this". Assigning
 * NT/EM here is our inference from which TOC serves the stations on the branch.
 * The geometry is sourced; the attribution is not. Every segment this script
 * writes therefore carries:
 *
 *     operator_precision: { NT: "inferred" }
 *
 * A MAP, not a bare string, and deliberately so. dedupe-line-segments.mjs UNIONS
 * `operators` when it merges two digitizations of one corridor — so a segment
 * can end up carrying an inferred operator alongside a relation-sourced one. A
 * single segment-level "inferred" would then be a lie in one direction or the
 * other. Keyed by operator, the merge stays truthful: absent key = sourced from
 * a real route relation, which also makes every pre-existing segment correct
 * with no field at all and no backfill.
 *
 * WHICH WAYS COUNT. Name match alone is not safe: within 600 m of Knottingley
 * there are 13 named lines including `Departure`, `Arrival` and
 * `Up Goole Goods Loop`; Corby's second-nearest is `British Steel Corby Branch`
 * and Heysham's is `Heysham Power Station`. Painting those in a passenger
 * operator's colour would be a worse bug than the missing line. So a way is
 * admitted only if it is named in its branch's list AND carries a `usage` tag
 * AND carries NO `service` tag — `service` is what OSM puts on sidings, yard
 * roads and crossovers. Measured at Knottingley: 11 running lines kept of 50
 * ways, every siding and yard road dropped.
 *
 * Usage: node scripts/ingest-branch-ways.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const DRY = process.argv.includes('--dry-run');
// Restricts the run to one branch by key, e.g. --only=pontefract_baghill_spur.
// Exists because the script has no per-branch idempotency guarantee against
// upstream OSM drift: a plain run can pick up newly-mapped ways in an
// unrelated branch (verified 2026-08-06 — a dry run surfaced 7 new Askern-
// branch ways with no connection to the branch actually being worked on).
// Without this flag, fixing one branch would silently also ingest whatever
// else changed upstream since the last run.
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.slice('--only='.length) : null;

/**
 * The branches. `names` are OSM `name` values observed on active track
 * within 600 m of the affected stations (derived from the base tileset, not
 * hand-listed from memory). `bbox` is [S,W,N,E] and exists so a generic name
 * cannot pull in track from elsewhere in the country — "Down Goole" and
 * "Up Doncaster" are exactly the kind of directional running-line name that
 * could plausibly recur. (Originally six — Askern was split out of
 * `pontefract` 2026-08-04, and `pontefract_baghill_spur` was added
 * 2026-08-06 using `wayIds` instead of `names`; see that entry below.)
 */
const BRANCHES = [
  { key: 'wharfedale', op: 'NT', label: 'Wharfedale Line (Leeds/Bradford-Ilkley)',
    stations: ['GSY', 'MNN', 'BUW', 'ILK', 'BEY', 'BLD'],
    names: ['Wharfedale Line', 'Ilkley Branch'],
    bbox: [53.79, -1.90, 53.96, -1.66] },
  { key: 'harrogate', op: 'NT', label: 'Harrogate Line',
    stations: ['SBE', 'KNA'],
    names: ['Harrogate Line'],
    bbox: [53.90, -1.62, 54.06, -1.35] },
  { key: 'pontefract', op: 'NT', label: 'Pontefract / Knottingley / Goole',
    stations: ['SHC', 'PFM', 'POT', 'KNO', 'FEA', 'RWC', 'GLH', 'PFR'],
    names: ['Pontefract Line', 'Wakefield and Goole Line',
      'Castleford and Pontefract Monkhill Line',
      'Down Goole', 'Up Goole', 'Down Doncaster', 'Up Doncaster'],
    bbox: [53.63, -1.55, 53.76, -0.90] },
  // SPLIT OUT OF `pontefract` 2026-08-04, after external verification. The
  // Askern branch was originally swept up by the Pontefract name list and
  // attributed to NT along with it — wrong: Northern runs NO passenger service
  // over Knottingley West Jn - Shaftholme Jn. It is a freight-primary line
  // (Freightliner, DB Cargo UK, GB Railfreight) plus two passenger operators,
  // Grand Central (its Bradford services run via Pontefract Monkhill and
  // Askern) and LNER.
  //
  // ONLY THE PASSENGER OPERATORS ARE RENDERED, and that is a model limit, not
  // a judgement: data/operator-colors.json has no entry for any freight
  // operator, so there is nothing to colour them with. Adding freight would
  // mean new palette entries, which forces a regeneration — and CLAUDE.md
  // requires the hand-set Heritage colour to be re-verified by hand whenever
  // that happens. Out of scope here; flagged instead of forced.
  //
  // The short `Down Doncaster` / `Up Doncaster` ways stay with `pontefract`
  // above: all three are sub-kilometre and sit at Knottingley itself
  // (53.703-53.706), i.e. the junction throat, not the branch corridor.
  { key: 'askern', op: ['GC', 'GR'], label: 'Askern branch (Knottingley-Shaftholme, freight-primary)',
    stations: [],
    names: ['Knottingley West Junction and Shaftholme Junction Line'],
    bbox: [53.55, -1.40, 53.76, -1.00] },
  { key: 'south_fylde', op: 'NT', label: 'South Fylde (Preston-Blackpool South)',
    stations: ['LTM', 'AFV', 'MOS'],
    names: ['South Fylde Community Railway Line', 'Preston and Wyre Joint Railway'],
    bbox: [53.71, -3.08, 53.83, -2.68] },
  { key: 'morecambe', op: 'NT', label: 'Morecambe / Heysham branch',
    stations: ['HHB'],
    names: ['Morecambe Branch Line'],
    bbox: [53.98, -2.95, 54.09, -2.72] },
  { key: 'corby', op: 'EM', label: 'Corby branch (Midland Main Line)',
    stations: ['COR'],
    names: ['Kettering North Junction and Melton Mowbray Line'],
    bbox: [52.35, -0.80, 52.60, -0.60] },
  // WAY-ID SELECTED, not name-matched — the track this branch needs carries
  // NO `name` tag at all (confirmed via Overpass 2026-08-06: every other way
  // in a 1km box around Pontefract Baghill is either 'Pontefract Line',
  // 'Wakefield and Goole Line' or 'Castleford and Pontefract Monkhill Line',
  // none of which run past Baghill — PFR sits 709m from the nearest of
  // those). So the `names` mechanism above structurally cannot reach it: it
  // is a filter over a `name` tag that doesn't exist here. See `wayIds`
  // handling in the fetch loop below.
  //
  // The two ways below (`ref:lor=LN804`, `ref=SMJ2` — Swinton & Knottingley
  // Joint) are the Up/Down pair running directly past Baghill: verified by
  // perpendicular distance from PFR (53.69188,-1.30335) to each way's
  // polyline, not just to a bbox — 243765934 passes 5.7m from the station,
  // 302911126 passes 9.3m. Both carry usage=branch and no service tag, same
  // admission criteria as the name-matched branches above.
  //
  // NOT INCLUDED: the continuation south of that pair (263248057 ->
  // 263248089 -> 263248096, and their Down-line counterparts 302911139 ->
  // 302911122 -> 302911128), which carries on toward Knottingley — all
  // 108m+ from PFR, not needed to close this station's snap gap, and every
  // station further down that line (Fitzwilliam, Moorthorpe, South Elmsall)
  // is already snapped via a *different* line (the Dearne Valley line,
  // segments 2511/2304/2316) so extending the ingest that far serves no
  // unsnapped station. Left out deliberately, not overlooked — flagged here
  // rather than silently ingesting more track than the fix needs.
  { key: 'pontefract_baghill_spur', op: 'NT',
    label: 'Pontefract Baghill spur (Swinton & Knottingley Joint, Streethouse Jn – Baghill leg)',
    stations: ['PFR'],
    wayIds: [243765934, 302911126],
    bbox: [53.690, -1.305, 53.701, -1.281] },
];

async function overpass(q) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    // BOTH headers are required against the public endpoint, and getting either
    // wrong produces an HTTP 406 with an HTML body that looks exactly like a
    // rate limit. It is not one — backing off will never clear it. Verified
    // 2026-08-04: identical query, no User-Agent -> 406, with User-Agent -> 200.
    // node's fetch() sends no UA by default and defaults a string body to
    // text/plain, so both have to be set explicitly. A local Overpass does not
    // care, which is why build-line-segments.mjs has never needed them.
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'srhq.uk-line-ingest/1.0 (+https://srhq.uk)',
      },
      body: 'data=' + encodeURIComponent(q),
    });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
    // Public Overpass answers rate limits with an XML error document, not JSON.
    const wait = attempt * 12000;
    console.log(`    Overpass busy (HTTP ${res.status}), retry ${attempt}/4 in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('Overpass failed after 4 attempts');
}

const R = 6371000, rad = (d) => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lengthOf = (coords) => {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += metres(coords[i - 1], coords[i]);
  return t;
};

async function main() {
  const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
  const existingWays = new Set();
  for (const s of graph.segments) for (const w of (s.way_ids || [])) existingWays.add(w);
  let maxId = 0;
  for (const s of graph.segments) if (s.id > maxId) maxId = s.id;
  console.log(`Existing graph: ${graph.segments.length} segments, ${existingWays.size} distinct way ids, max id ${maxId}`);
  console.log(`Overpass: ${OVERPASS_URL}${DRY ? '  [DRY RUN — nothing will be written]' : ''}\n`);

  const branches = ONLY ? BRANCHES.filter((b) => b.key === ONLY) : BRANCHES;
  if (ONLY && branches.length === 0) throw new Error(`--only=${ONLY} matched no branch key`);
  if (ONLY) console.log(`--only=${ONLY}: restricting run to this branch\n`);

  const added = [];
  const report = [];
  for (const b of branches) {
    // Two mutually exclusive selectors: `names` (the default — matches any
    // way tagged with one of these names, scoped by bbox so a generic name
    // can't pull in track from elsewhere) or `wayIds` (an explicit list,
    // for track that carries no `name` tag at all and so can never be
    // reached by the name filter — see the pontefract_baghill_spur branch
    // above for why this exists). `wayIds` skips the bbox filter in the
    // query itself since the ids are already exact; `bbox` is kept on the
    // branch entry purely as a documented sanity check, not queried against.
    const q = b.wayIds
      ? `[out:json][timeout:120];way(id:${b.wayIds.join(',')});out geom;`
      : (() => {
          const [s, w, n, e] = b.bbox;
          const nameFilter = b.names.map((nm) => `way["railway"="rail"]["name"="${nm}"](${s},${w},${n},${e});`).join('');
          return `[out:json][timeout:120];(${nameFilter});out geom;`;
        })();
    console.log(`[${b.key}] ${b.label} -> ${[].concat(b.op).join('+')}`);
    const data = await overpass(q);
    const ways = (data.elements || []).filter((x) => x.type === 'way');

    let kept = 0, dropService = 0, dropNoUsage = 0, dropDup = 0, addedKm = 0;
    for (const way of ways) {
      const t = way.tags || {};
      if (t.service) { dropService++; continue; }        // siding / yard / crossover
      if (!t.usage) { dropNoUsage++; continue; }          // not a classified running line
      if (existingWays.has(way.id)) { dropDup++; continue; }
      const coords = (way.geometry || []).map((g) => [g.lon, g.lat]);
      if (coords.length < 2) continue;
      maxId += 1;
      const len = lengthOf(coords);
      // `op` may be one key or several — the Askern branch carries two
      // passenger operators and no single correct answer.
      const ops = Array.isArray(b.op) ? b.op : [b.op];
      added.push({
        id: maxId,
        nodes: way.nodes || [],
        coords,
        operators: ops,
        way_ids: [way.id],
        length_m: len,
        // See the header: keyed by operator so a dedupe union stays truthful.
        operator_precision: Object.fromEntries(ops.map((o) => [o, 'inferred'])),
        operator_source: 'way-tag',
        ingested_by: 'ingest-branch-ways.mjs',
        ingest_branch: b.key,
      });
      existingWays.add(way.id);
      kept++; addedKm += len / 1000;
    }
    console.log(`    ${ways.length} ways matched ${b.wayIds ? 'by id' : 'by name'} | kept ${kept} (${addedKm.toFixed(1)} km)` +
      ` | dropped: ${dropService} service, ${dropNoUsage} no-usage, ${dropDup} already in graph`);
    report.push({ ...b, matched: ways.length, kept, km: addedKm, dropService, dropNoUsage, dropDup });
  }

  console.log(`\nTotal new segments: ${added.length} (${added.reduce((a, s) => a + s.length_m, 0) / 1000 | 0} km)`);
  if (DRY) { console.log('DRY RUN — line-segments.json untouched.'); return; }

  graph.segments.push(...added);
  graph.segment_count = graph.segments.length;
  // Merge by key rather than replace outright — with --only, `report` covers
  // just the branches actually run this time, and a plain overwrite would
  // erase the record of every other branch's prior ingestion even though
  // their segments are still sitting in graph.segments untouched.
  const prevBranches = graph.branch_ingest?.branches || [];
  const thisRun = report.map((r) => ({ key: r.key, operator: r.op, segments: r.kept, km: +r.km.toFixed(1) }));
  const thisRunKeys = new Set(thisRun.map((r) => r.key));
  graph.branch_ingest = {
    generated_at: new Date().toISOString(),
    note: 'Way-level ingestion for branches with no OSM route relation. Attribution is inferred — see operator_precision.',
    branches: [...prevBranches.filter((r) => !thisRunKeys.has(r.key)), ...thisRun],
  };
  writeFileSync(SEG_PATH, JSON.stringify(graph));
  console.log(`Written: ${SEG_PATH} (${graph.segments.length} segments)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

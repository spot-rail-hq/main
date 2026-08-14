#!/usr/bin/env node
/**
 * scripts/build-historical-stations.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Builds scripts/output/historical-stations.geojson — every GB railway
 * station that has ever existed, with the year(s) it was open, for the
 * historical map slider. Deterministic, no AI.
 *
 *   node scripts/build-historical-stations.mjs
 *
 * Optional env vars:
 *   REFETCH=1   ignore the cached Wikipedia/Wikidata download and re-query.
 *               ~450 API round-trips, several minutes; cached at
 *               scripts/output/wikipedia-station-years.json.
 *
 * ─── WHY NOT OHM ──────────────────────────────────────────────────────────
 * OHM holds 1,361 GB station elements for ALL of history — fewer than the
 * ~2,600 open today, and only 426 Beeching-era closures against a real
 * ~2,000-2,500 (Phase 1). Wikipedia's year categories hold 9,421 distinct
 * stations, ~8x the Beeching coverage, and 97.6% of them are geolocatable.
 * So the DATE comes from the category name (structured, exact, no extraction)
 * and the COORDINATES come from Wikidata P625. Wikidata's own date properties
 * are deliberately ignored — P571 inception is present on 7% and P576
 * dissolved on 1.5%, measured, so they would add nothing but noise.
 *
 * ─── SOURCES DELIBERATELY NOT USED ────────────────────────────────────────
 * StopsGB (British Library / Living with Machines) is CC BY-NC-SA 4.0 — the
 * non-commercial clause is incompatible with this site, and ShareAlike would
 * propagate to derived output. Michael Quick's "Railway Passenger Stations in
 * Great Britain: a Chronology" is the definitive reference but is not openly
 * licensed. NEITHER is accessed, downloaded, parsed or derived from here.
 * Both remain future permission-seeking opportunities only.
 *
 * ─── PERIODS, NOT A DATE PAIR ─────────────────────────────────────────────
 * 421 currently-open stations also appear in a closure category — they closed
 * and later reopened (Alloa, Aigburth, Ardrossan Town…). A single start/end
 * pair cannot represent that, and a naive "latest closure wins" read would
 * retire 421 stations that are demonstrably open today. So each station gets
 * an ordered `periods` array of {start_year, end_year}, end_year null meaning
 * still open.
 *
 * Periods are derived by sorting every opening and closing year the
 * categories give and requiring them to ALTERNATE open/close/open/close. A
 * station whose events do not cleanly alternate, or whose periods would
 * overlap, is NOT auto-resolved — it goes on the review list and falls back
 * to ONE continuous period from first opening to last closing, with the
 * intermediate gaps marked unknown. That way we never assert a closure we
 * cannot evidence; we only ever under-claim.
 *
 * ─── GB CLIP ──────────────────────────────────────────────────────────────
 * Real point-in-polygon against OHM's own England/Scotland/Wales boundaries,
 * not a bbox. Wikipedia's "…in Great Britain" categories are supposed to
 * exclude Northern Ireland but are not perfectly policed, so this is the
 * enforcing filter.
 *
 * ─── FIELD OWNERSHIP ──────────────────────────────────────────────────────
 * Sole writer of scripts/output/historical-stations.geojson,
 * scripts/output/historical-stations-report.json and
 * scripts/output/historical-stations-review.json. Reads station-list.json
 * (authoritative for "open now"), scripts/output/historical-lines.geojson
 * (for line-inherited opening years) and scripts/output/ohm-gb-boundary.json.
 * Never writes to data/ or to any *-content.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { USER_AGENT, makeGbContainsFn, overpass, GB_AREAS } from './lib/historical-era.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'scripts', 'output');
const CACHE_PATH = path.join(OUTPUT_DIR, 'wikipedia-station-years.json');
const BOUNDARY_PATH = path.join(OUTPUT_DIR, 'ohm-gb-boundary.json');
const LINES_PATH = path.join(OUTPUT_DIR, 'historical-lines.geojson');
const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');
const STATIONS_CONTENT_PATH = path.join(ROOT, 'stations-content.json');
const OUT_GEOJSON = path.join(OUTPUT_DIR, 'historical-stations.geojson');
const OUT_REPORT = path.join(OUTPUT_DIR, 'historical-stations-report.json');
const OUT_REVIEW = path.join(OUTPUT_DIR, 'historical-stations-review.json');
const OUT_HIDDEN = path.join(ROOT, 'data', 'history-hidden-stations.json');
const ORPHANED_NOTES_PATH = path.join(OUTPUT_DIR, `historical-stations-orphaned-annotations-${Date.now()}.json`);

// ─── read-merge-preserve (inverted allowlist) ──────────────────────────────
// Same convention as build-line-segments.mjs / build-heritage-content.mjs /
// build-heritage-client-data.mjs (see CLAUDE.md's "Generator safety" section)
// — this is the 4th generator getting it, not a new mechanism. Nothing is
// currently hand-curated in this file's output (confirmed empty at the time
// this guard was added), but build-heritage-client-data.mjs was in the exact
// same "latent, not yet used" state when it was fixed, and the AGR
// investigation that prompted this fix depends on the guard existing BEFORE
// any hand data is written, not after.
//
// Keying: `wikidata_qid`, confirmed live against the current output —
// present on all 8,884 features, 100% unique, zero collisions. Deliberately
// NOT `crs`: `crs` being stale/orphaned in stations-content.json is the
// exact bug this session's AGR fix corrects (see openNow below), so keying
// preservation on the same fragile signal that caused the bug would be
// circular. A Wikidata QID is a real, permanent external identifier, the
// same stability class as heritage's hand-assigned `slug`.
export const STATION_OWNED_KEYS = new Set([
  'name', 'wikipedia_title', 'crs', 'periods', 'start_year', 'end_year',
  'start_precision', 'end_precision', 'periods_uncertain',
  'periods_same_year_reorder', 'triage', 'source', 'wikidata_qid', 'license',
  'coord_source',
]);

function loadExistingGeojson() {
  if (!existsSync(OUT_GEOJSON)) return null;
  try {
    return JSON.parse(readFileSync(OUT_GEOJSON, 'utf8'));
  } catch (err) {
    throw new Error(`Existing output at ${OUT_GEOJSON} is not valid JSON, refusing to overwrite blind: ${err.message}`);
  }
}

export function foreignFields(properties, ownedKeys) {
  const out = {};
  for (const [k, v] of Object.entries(properties)) {
    if (!ownedKeys.has(k)) out[k] = v;
  }
  return out;
}

// Merges hand-curated fields from the previous output onto the freshly
// built features, matched by wikidata_qid. Returns { mergedFeatures,
// orphaned } — orphaned is every old feature that carried a foreign field
// but whose QID no longer appears in this run (article merged/QID changed/
// station dropped by a triage rule change), so there is nowhere honest to
// reattach it. Never guessed onto whatever feature happens to share a name.
export function mergeStationAnnotations(existingGeojson, freshFeatures) {
  if (!existingGeojson) return { mergedFeatures: freshFeatures, orphaned: [] };

  const oldNoted = new Map(); // qid -> { feature, foreign }
  for (const old of existingGeojson.features || []) {
    const qid = old.properties && old.properties.wikidata_qid;
    if (!qid) continue;
    const foreign = foreignFields(old.properties, STATION_OWNED_KEYS);
    if (Object.keys(foreign).length === 0) continue;
    oldNoted.set(qid, { feature: old, foreign });
  }

  const consumed = new Set();
  const mergedFeatures = freshFeatures.map((f) => {
    const qid = f.properties.wikidata_qid;
    const hit = qid && oldNoted.get(qid);
    if (!hit) return f;
    consumed.add(qid);
    return { ...f, properties: { ...f.properties, ...hit.foreign } };
  });

  const orphaned = [];
  for (const [qid, hit] of oldNoted) {
    if (!consumed.has(qid)) {
      orphaned.push({ qid, name: hit.feature.properties.name, wikipedia_title: hit.feature.properties.wikipedia_title, foreign: hit.foreign });
    }
  }

  return { mergedFeatures, orphaned };
}

// Fails loudly by default: if this run would silently drop hand-curated
// content, abort and write nothing. ALLOW_ORPHANED_STATION_NOTES=1 lets the
// write proceed but archives everything dropped to a side ledger, same
// escape-hatch shape as build-line-segments.mjs's
// ALLOW_ORPHANED_SEGMENT_NOTES.
export function assertNoStationAnnotationLoss(orphaned) {
  if (orphaned.length === 0) return;

  console.error(`\n✗ STATION ANNOTATION LOSS DETECTED`);
  console.error(`${orphaned.length} station(s) with hand-curated fields have no matching wikidata_qid in this run:`);
  for (const o of orphaned) {
    console.error(`  ${o.qid} (${o.name} — ${o.wikipedia_title}):`);
    console.error(`    ${JSON.stringify(o.foreign)}`);
  }

  if (process.env.ALLOW_ORPHANED_STATION_NOTES === '1') {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(ORPHANED_NOTES_PATH, JSON.stringify({ generated_at: new Date().toISOString(), reason: 'no matching wikidata_qid in rebuild', orphaned }, null, 2) + '\n');
    console.error(`\nALLOW_ORPHANED_STATION_NOTES=1 set — proceeding anyway. Orphaned content archived to ${ORPHANED_NOTES_PATH}. Re-triage by hand.`);
    return;
  }

  console.error(`\nRefusing to write ${OUT_GEOJSON} — this would silently drop the content above.`);
  console.error(`If this loss is expected, re-run with ALLOW_ORPHANED_STATION_NOTES=1 after reviewing the diagnostic — dropped content is archived, never just discarded.`);
  throw new Error('station annotation loss guard tripped — see diagnostic above');
}

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

// Verified in Phase 1B rather than assumed: the closure parent is "by year of
// closing", NOT "closure", and the opening series starts at 1812 not 1830.
const PARENTS = {
  opened: 'Category:Railway stations in Great Britain by year of opening',
  closed: 'Category:Railway stations in Great Britain by year of closing',
};

// Wikipedia rate-limits a run of this size (~450 round-trips) and returns 429
// partway through — hit live on the first build. A polite inter-request delay
// plus exponential backoff on 429/5xx keeps a full run inside the limits
// without needing an API key, and makes the quarterly re-run unattended.
const REQUEST_DELAY_MS = 120;
const MAX_RETRIES = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (url) => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) {
      await sleep(REQUEST_DELAY_MS);
      return res.json();
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
    if (attempt === MAX_RETRIES) throw new Error(`HTTP ${res.status} after ${MAX_RETRIES} retries: ${url}`);
    // Respect Retry-After when the server sends one, otherwise back off
    // 2s, 4s, 8s, … Capped so a wedged endpoint fails in minutes not hours.
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 60000);
    console.log(`    HTTP ${res.status} — backing off ${(waitMs / 1000).toFixed(0)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }
  throw new Error(`unreachable`);
};

async function fetchYearMemberships() {
  const out = { opened: {}, closed: {}, categoryCounts: { opened: 0, closed: 0 } };
  for (const [kind, parent] of Object.entries(PARENTS)) {
    const sub = await get(
      `${WIKI_API}?action=query&list=categorymembers&cmtype=subcat&cmlimit=500&format=json` +
        `&cmtitle=${encodeURIComponent(parent)}`,
    );
    const cats = sub.query.categorymembers.map((c) => c.title).filter((t) => / in \d{4}$/.test(t));
    out.categoryCounts[kind] = cats.length;
    console.log(`  ${kind}: ${cats.length} year categories`);
    for (const cat of cats) {
      const year = parseInt(cat.match(/(\d{4})$/)[1], 10);
      let cont = null;
      do {
        const r = await get(
          `${WIKI_API}?action=query&list=categorymembers&cmtype=page&cmlimit=500&format=json` +
            `&cmtitle=${encodeURIComponent(cat)}` +
            (cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ''),
        );
        for (const m of r.query.categorymembers) {
          (out[kind][m.title] = out[kind][m.title] || []).push(year);
        }
        cont = r.continue && r.continue.cmcontinue;
      } while (cont);
    }
  }
  return out;
}

// Resolves article titles -> Wikidata QID -> P625 coordinates, plus the
// article's own categories (used for the triage in classifyUnlisted below).
async function fetchStationDetail(titles) {
  const detail = {};
  for (let i = 0; i < titles.length; i += 45) {
    const batch = titles.slice(i, i + 45);
    const r = await get(
      `${WIKI_API}?action=query&prop=pageprops|categories&ppprop=wikibase_item` +
        `&cllimit=500&format=json&titles=${encodeURIComponent(batch.join('|'))}`,
    );
    // `normalized` maps our requested title to the API's canonical form.
    const back = {};
    for (const n of r.query.normalized || []) back[n.to] = n.from;
    for (const p of Object.values(r.query.pages)) {
      const requested = back[p.title] || p.title;
      detail[requested] = {
        title: p.title,
        qid: (p.pageprops && p.pageprops.wikibase_item) || null,
        categories: (p.categories || []).map((c) => c.title),
      };
    }
    if (i % 2250 === 0) console.log(`    wikipedia ${i}/${titles.length}`);
  }
  const qids = [...new Set(Object.values(detail).map((d) => d.qid).filter(Boolean))];
  const coords = {};
  for (let i = 0; i < qids.length; i += 45) {
    const r = await get(
      `${WIKIDATA_API}?action=wbgetentities&props=claims&format=json&ids=${qids.slice(i, i + 45).join('|')}`,
    );
    for (const [qid, e] of Object.entries(r.entities || {})) {
      const claim = e.claims && e.claims.P625 && e.claims.P625[0];
      const v = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
      if (v && typeof v.longitude === 'number') coords[qid] = [v.longitude, v.latitude];
    }
    if (i % 2250 === 0) console.log(`    wikidata ${i}/${qids.length}`);
  }
  for (const d of Object.values(detail)) d.coords = d.qid ? coords[d.qid] || null : null;
  return detail;
}

async function loadCache() {
  if (!process.env.REFETCH && existsSync(CACHE_PATH)) {
    console.log(`Using cached Wikipedia/Wikidata download — REFETCH=1 to re-query`);
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  }
  console.log('Fetching Wikipedia year categories...');
  const years = await fetchYearMemberships();
  const titles = [...new Set([...Object.keys(years.opened), ...Object.keys(years.closed)])];
  console.log(`  ${titles.length} distinct station articles; resolving coordinates...`);
  const detail = await fetchStationDetail(titles);
  const payload = { fetched_at: new Date().toISOString(), years, detail };
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(payload));
  return payload;
}

async function loadBoundary() {
  if (existsSync(BOUNDARY_PATH)) return JSON.parse(readFileSync(BOUNDARY_PATH, 'utf8'));
  console.log('Fetching OHM GB boundary geometry...');
  const ids = Object.values(GB_AREAS).map((a) => a - 3600000000);
  const j = await overpass(`(${ids.map((i) => `relation(${i});`).join('')});\nout geom;`, { timeout: 600 });
  writeFileSync(BOUNDARY_PATH, JSON.stringify(j));
  return j;
}

// ─── Period derivation ────────────────────────────────────────────────────
// Returns { periods, uncertain, reason }. `openNow` comes from
// station-list.json, which is authoritative — if a station is in it, the
// final period is open-ended no matter what the closure categories claim.
function derivePeriods(openings, closings, openNow) {
  const opens = [...new Set(openings)].sort((a, b) => a - b);
  const closes = [...new Set(closings)].sort((a, b) => a - b);

  if (!opens.length) return { periods: [], uncertain: true, sameYearReorder: false, reason: 'no-opening-year' };

  // Interleave as an event stream and require strict alternation starting
  // with an open.
  //
  // SAME-YEAR TIE-BREAK: the categories are year-granular, so when a station
  // has both an opening and a closing in the SAME year the data itself gives
  // no intra-year order. Both readings are legitimate — "closed and reopened
  // in 1843" and "opened and closed in 1848" are both real patterns — so both
  // orderings are attempted and whichever produces a clean alternation wins.
  // This is completing the sort, not resolving a conflict: a station that
  // needed the swap is still recorded (same_year_reorder) and still listed for
  // human verification, so nothing is silently auto-resolved. Found live on
  // the first build: 294 stations failed alternation, and the overwhelming
  // majority were this exact close-then-reopen-within-one-year shape
  // (Kilmarnock: opens 1812/1843/1846, closes 1843/1846).
  const attempt = (closeFirstOnTie) => {
    const events = [
      ...opens.map((y) => ({ y, kind: 'open' })),
      ...closes.map((y) => ({ y, kind: 'close' })),
    ].sort((a, b) => {
      if (a.y !== b.y) return a.y - b.y;
      if (a.kind === b.kind) return 0;
      return closeFirstOnTie ? (a.kind === 'close' ? -1 : 1) : a.kind === 'open' ? -1 : 1;
    });
    const built = [];
    let expecting = 'open';
    for (const e of events) {
      if (e.kind !== expecting) {
        return { ok: false, reason: `got ${e.kind} at ${e.y} while expecting ${expecting}` };
      }
      if (e.kind === 'open') built.push({ start_year: e.y, end_year: null });
      else built[built.length - 1].end_year = e.y;
      expecting = expecting === 'open' ? 'close' : 'open';
    }
    return { ok: true, periods: built };
  };

  let sameYearReorder = false;
  let result = attempt(false);
  if (!result.ok) {
    const swapped = attempt(true);
    if (swapped.ok) {
      result = swapped;
      sameYearReorder = true;
    }
  }
  if (!result.ok) {
    return {
      periods: fallbackPeriods(opens, closes, openNow),
      uncertain: true,
      sameYearReorder: false,
      reason: `events do not alternate under either same-year ordering (${result.reason})`,
    };
  }
  const periods = result.periods;

  // Overlap / ordering sanity — alternation alone does not guarantee a
  // period is non-degenerate.
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (p.end_year !== null && p.end_year < p.start_year) {
      return {
        periods: fallbackPeriods(opens, closes, openNow),
        uncertain: true,
        sameYearReorder,
        reason: `period ${i} ends (${p.end_year}) before it starts (${p.start_year})`,
      };
    }
    if (i > 0 && periods[i - 1].end_year !== null && p.start_year < periods[i - 1].end_year) {
      return {
        periods: fallbackPeriods(opens, closes, openNow),
        uncertain: true,
        sameYearReorder,
        reason: `period ${i} starts (${p.start_year}) before period ${i - 1} ends (${periods[i - 1].end_year})`,
      };
    }
  }

  // station-list.json wins over any closure category. This is what stops the
  // 421 reopened stations being retired by a stale/partial closure record.
  if (openNow) periods[periods.length - 1].end_year = null;
  return { periods, uncertain: false, sameYearReorder, reason: null };
}

// One continuous period, first opening to last closing. Deliberately
// under-claims: we never assert an intermediate closure we cannot evidence,
// we only record the outer span and mark the gaps unknown.
function fallbackPeriods(opens, closes, openNow) {
  const start = opens[0];
  const end = openNow ? null : closes.length ? closes[closes.length - 1] : null;
  return [{ start_year: start, end_year: end }];
}

// ─── Triage for stations absent from station-list.json ────────────────────
// Phase 1B found 678 stations with an opening year, no closure category, and
// no match in our current station list — i.e. we cannot evidence whether they
// are open or closed. Rather than defaulting them to "still open" (which
// leaves them on the map forever) they are triaged into buckets, and anything
// still untriaged is HIDDEN in v1 per the locked decision.
const NON_HEAVY_RAIL_RE =
  /(London Underground|Underground stations|Docklands Light Railway|Tramlink|tram stops?|Tramway|Metrolink|Tyne and Wear Metro|Glasgow Subway|Supertram|Nottingham Express Transit|Edinburgh Trams|heritage railway|Heritage railway|preserved railway|funicular|cliff railway|Cliff railways|miniature railway|Monorail|people mover)/i;
const OUT_OF_SCOPE_RE = /(Northern Ireland|Isle of Man|Channel Islands|Republic of Ireland|County (Antrim|Armagh|Down|Fermanagh|Londonderry|Tyrone))/i;

function classifyUnlisted(detail, inGb, nearOpenStation) {
  // Order matters: geography first (a NI tram stop is out of scope, not
  // "non-heavy-rail"), then mode, then a possible name-match failure.
  if (detail.coords && !inGb(detail.coords[0], detail.coords[1])) return 'd_out_of_scope_geo';
  const cats = (detail.categories || []).join(' | ');
  if (OUT_OF_SCOPE_RE.test(cats)) return 'd_out_of_scope_category';
  if (NON_HEAVY_RAIL_RE.test(cats)) return 'a_non_heavy_rail';
  if (detail.coords && nearOpenStation(detail.coords[0], detail.coords[1])) return 'c_name_match_failure';
  return 'b_closure_unrecorded';
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function main() {
  const cache = await loadCache();
  const boundary = await loadBoundary();
  const inGb = makeGbContainsFn(boundary.elements);

  const stationList = JSON.parse(readFileSync(STATION_LIST_PATH, 'utf8'));
  const stationsContent = JSON.parse(readFileSync(STATIONS_CONTENT_PATH, 'utf8'));

  // station-list.json is authoritative for "open now". Map its CRS entries to
  // the curated wikipedia_title in stations-content.json so a Wikipedia
  // article can be recognised as a currently-open station.
  const titleToCrs = {};
  for (const crs of Object.keys(stationsContent)) {
    if (crs === '_notes') continue;
    const t = stationsContent[crs].wikipedia_title;
    if (t) titleToCrs[t] = crs;
  }
  const crsToCoords = {};
  for (const s of stationList) crsToCoords[s.crs] = [s.lon, s.lat];
  // BUGFIX (2026-08-15, AGR/Angel Road investigation — see this file's own
  // header comment and _notes on historical-stations-report.json for the
  // full writeup). `titleToCrs` above is built from stations-content.json's
  // OWN keys, not from station-list.json — so `crs` can be non-null for a
  // station stations-content.json still has a row for, even after the real
  // CRS has been retired from station-list.json (the actually-live NaPTAN
  // source) and never pruned from stations-content.json. `openNow` below
  // must check LIVE membership, not mere presence of a `crs` value, or a
  // closed station with a stale stations-content.json row renders as
  // perpetually open regardless of what its own Wikipedia article says.
  // liveCrsSet is also used further down for the tab-consistency hide list
  // — one set, not two (that block used to declare its own copy; now reuses
  // this one, hoisted here so both call sites see the identical live set).
  const liveCrsSet = new Set(stationList.filter((s) => s.crs).map((s) => s.crs));

  // Proximity index for the name-match-failure bucket.
  const openPoints = stationList.map((s) => [s.lon, s.lat]);
  const nearOpenStation = (lon, lat) =>
    openPoints.some((p) => Math.abs(p[0] - lon) < 0.01 && Math.abs(p[1] - lat) < 0.006 && haversineKm(p, [lon, lat]) < 0.4);

  // Historical line vertices, for inheriting an opening year (the locked
  // fallback for stations with no opening date at all).
  const lines = JSON.parse(readFileSync(LINES_PATH, 'utf8'));
  const lineVerts = [];
  for (const f of lines.features) {
    const sy = f.properties.start_year;
    if (sy === null) continue;
    for (const c of f.geometry.coordinates) lineVerts.push([c[0], c[1], sy]);
  }
  function inheritYearFromLine(lon, lat) {
    let best = null;
    let bestD = Infinity;
    for (const v of lineVerts) {
      if (Math.abs(v[0] - lon) > 0.02 || Math.abs(v[1] - lat) > 0.012) continue;
      const d = haversineKm([v[0], v[1]], [lon, lat]);
      if (d < bestD) {
        bestD = d;
        best = v[2];
      }
    }
    return bestD <= 1.0 ? best : null; // within 1 km of a dated line
  }

  const allTitles = [...new Set([...Object.keys(cache.years.opened), ...Object.keys(cache.years.closed)])];

  const stats = {
    candidate_articles: allTitles.length,
    no_coordinates: 0,
    outside_gb: 0,
    emitted: 0,
    open_now: 0,
    reopened_multi_period: 0,
    uncertain_periods: 0,
    same_year_reordered: 0,
    inherited_start_year: 0,
    unknown_start_year: 0,
    triage: {},
    hidden_untriaged: 0,
    max_periods: 0,
  };
  const review = { non_alternating: [], same_year_reordered: [], no_opening_year: [], unlisted_triage: {} };
  const features = [];

  for (const title of allTitles) {
    const d = cache.detail[title];
    if (!d) continue;
    if (!d.coords) {
      stats.no_coordinates++;
      continue;
    }
    const [lon, lat] = d.coords;
    if (!inGb(lon, lat)) {
      stats.outside_gb++;
      continue;
    }

    const crs = titleToCrs[title] || null;
    const openNow = !!(crs && liveCrsSet.has(crs));
    const openings = cache.years.opened[title] || [];
    const closings = cache.years.closed[title] || [];

    let { periods, uncertain, reason, sameYearReorder } = derivePeriods(openings, closings, openNow);
    let startPrecision = 'exact';

    // Locked fallback: a station with no opening year inherits one from the
    // nearest dated line, recorded as `inferred` so the UI can say so.
    if (!periods.length || periods[0].start_year === undefined) {
      const inherited = inheritYearFromLine(lon, lat);
      if (inherited !== null) {
        periods = [
          { start_year: inherited, end_year: openNow ? null : closings.length ? Math.max(...closings) : null },
        ];
        startPrecision = 'inferred';
        stats.inherited_start_year++;
        uncertain = false;
      } else {
        startPrecision = 'unknown';
        stats.unknown_start_year++;
        review.no_opening_year.push({ title, closings, reason: 'no opening year and no dated line within 1 km' });
        continue; // cannot place it in time at all — hidden per the locked rule
      }
    }

    if (uncertain) {
      stats.uncertain_periods++;
      review.non_alternating.push({ title, openings, closings, reason, fallback_periods: periods });
    } else if (sameYearReorder) {
      // Resolved by treating a same-year close as preceding the same-year
      // reopen. Legitimate, but listed for human verification rather than
      // silently accepted — see derivePeriods().
      stats.same_year_reordered++;
      review.same_year_reordered.push({ title, openings, closings, periods });
    }

    // Triage anything we cannot evidence as currently open.
    let triageBucket = null;
    if (!openNow) {
      const stillOpenClaim = periods[periods.length - 1].end_year === null;
      if (stillOpenClaim) {
        triageBucket = classifyUnlisted(d, inGb, nearOpenStation);
        stats.triage[triageBucket] = (stats.triage[triageBucket] || 0) + 1;
        (review.unlisted_triage[triageBucket] = review.unlisted_triage[triageBucket] || []).push({
          title,
          openings,
          coords: [lon, lat],
        });
      }
    }

    // LOCKED: default for anything still untriaged is HIDE in v1 — do not
    // render what we cannot place in time. Only bucket (a) non-heavy-rail is
    // plausibly genuinely open while absent from a NaPTAN-derived list; the
    // rest are held back rather than asserted either way.
    const hidden = triageBucket !== null && triageBucket !== 'a_non_heavy_rail';
    if (hidden) {
      stats.hidden_untriaged++;
      continue;
    }

    const last = periods[periods.length - 1];
    const endPrecision =
      last.end_year !== null ? 'exact' : openNow ? 'exact' : 'unknown';

    if (openNow) stats.open_now++;
    if (periods.length > 1) stats.reopened_multi_period++;
    stats.max_periods = Math.max(stats.max_periods, periods.length);

    features.push({
      type: 'Feature',
      properties: {
        name: title.replace(/ railway station$/, ''),
        wikipedia_title: title,
        crs,
        periods,
        start_year: periods[0].start_year,
        end_year: last.end_year,
        start_precision: startPrecision,
        end_precision: endPrecision,
        periods_uncertain: uncertain || undefined,
        periods_same_year_reorder: sameYearReorder || undefined,
        triage: triageBucket || undefined,
        source: `wikipedia:${title}`,
        wikidata_qid: d.qid,
        license: 'CC-BY-SA-4.0',
      },
      geometry: { type: 'Point', coordinates: [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6] },
    });
    stats.emitted++;
  }

  // ── NaPTAN COORDINATE CORRECTION (2026-08-04) ────────────────────────────
  // Wikidata coordinates run a systematic offset against NaPTAN's surveyed
  // positions — measured across 2,662 matched pairs: median 30.9 m, 41% worse
  // than 25 m, and visibly landing on the road rather than the platform
  // (Solihull was the reported case). station-list.json is NaPTAN-derived and
  // already loaded above, so the fix is a join, not a fetch.
  //
  // TWO JOIN KEYS, DIFFERENT RELIABILITY:
  //   CRS  — exact and safe. 2,461 of the 3,095 open-at-2026 stations. Measured
  //          worst case 750 m (Newsham, a genuine relocation), zero false
  //          positives.
  //   NAME — only when the name resolves to exactly ONE live station. 201 more.
  //          Median 10.8 m but it produced one 147 km false positive
  //          ("Haymarket": Edinburgh vs Newcastle Metro), which is precisely
  //          why the distance guard below is not optional.
  //
  // THE >1 km GUARD IS THE SAFETY RAIL. If the two sources disagree by more
  // than a kilometre, that is not a survey difference, it is a mismatch — the
  // Wikidata position is kept and the pair is written to the report for a human
  // to look at. Nothing is hand-excluded; Haymarket is caught by the rule.
  //
  // The remaining ~433 have no NaPTAN counterpart at all and stay on Wikidata
  // coordinates, correctly: NaPTAN registers currently-active infrastructure,
  // and a station closed in 1964 has none.
  const COORD_REJECT_KM = 1;
  const liveByName = new Map();
  for (const s of stationList) {
    if (!s.name) continue;
    const k = String(s.name).replace(/\b(rail|metro|tram|underground|dlr)?\s*(station|stop)\b/gi, '').trim().toLowerCase();
    if (!liveByName.has(k)) liveByName.set(k, []);
    liveByName.get(k).push(s);
  }
  const coordFix = { byCrs: 0, byName: 0, rejected: [], unmatched: 0, movedM: [] };
  for (const f of features) {
    const [lon, lat] = f.geometry.coordinates;
    let target = null, via = null;
    const crsKey = f.properties.crs;
    if (crsKey && crsToCoords[crsKey]) { target = crsToCoords[crsKey]; via = 'crs'; }
    else {
      const k = String(f.properties.name || '').replace(/\b(rail|metro|tram|underground|dlr)?\s*(station|stop)\b/gi, '').trim().toLowerCase();
      const cands = liveByName.get(k);
      // Exactly one candidate only — an ambiguous name is not a match.
      if (cands && cands.length === 1) { target = [cands[0].lon, cands[0].lat]; via = 'name'; }
    }
    if (!target) { coordFix.unmatched++; continue; }
    const km = haversineKm(target, [lon, lat]);
    if (km > COORD_REJECT_KM) {
      coordFix.rejected.push({ name: f.properties.name, crs: crsKey || null, via, km: Math.round(km * 10) / 10 });
      continue;
    }
    f.geometry.coordinates = [Math.round(target[0] * 1e6) / 1e6, Math.round(target[1] * 1e6) / 1e6];
    // Provenance, additive — nothing reads it yet, but "where did this dot come
    // from" is exactly the question that took an investigation to answer once.
    f.properties.coord_source = 'naptan';
    coordFix.movedM.push(km * 1000);
    if (via === 'crs') coordFix.byCrs++; else coordFix.byName++;
  }
  coordFix.movedM.sort((a, b) => a - b);
  const medMoved = coordFix.movedM.length ? coordFix.movedM[Math.floor(coordFix.movedM.length / 2)] : 0;
  console.log(`  NaPTAN coordinate correction: ${coordFix.byCrs} by CRS + ${coordFix.byName} by name = ${coordFix.byCrs + coordFix.byName} moved`);
  console.log(`    median move ${medMoved.toFixed(1)} m · rejected >${COORD_REJECT_KM}km: ${coordFix.rejected.length} · no NaPTAN match: ${coordFix.unmatched}`);
  for (const r of coordFix.rejected) console.log(`    REJECTED (${r.via}) ${r.name} — ${r.km} km apart, kept Wikidata position`);

  // ── TAB-CONSISTENCY HIDE LIST (2026-08-04) ───────────────────────────────
  // A STILL-OPEN station must not appear in History if it does not also appear
  // in Database — a user switching tabs should never watch a station vanish.
  // Summerseat was the reported case: it and its East Lancashire Railway
  // neighbours are all still open, but only Bury Bolton Street, Ramsbottom and
  // Rawtenstall made it into station-list.json via the NaPTAN heritage addition.
  //
  // CLOSED stations are deliberately NOT in scope. They exist only in History by
  // design and always should — that is what History is for.
  //
  // WHY A GENERATED LIST RATHER THAN A RUNTIME NAME MATCH. map.html cannot
  // normalise names inside a MapLibre filter: there is no regex, so trailing
  // " tram stop" / " Metro station" / " (Hampshire)" cannot be stripped at
  // filter time. An allowlist built from station-list.json names plus guessed
  // suffix variants was tried and wrongly hid 8 stations that DO have a
  // Database row (Alresford (Hampshire), Canning Town station, Shadwell DLR
  // station, Sheringham (North Norfolk Railway), ...). Matching here — where
  // the same normalisation the coordinate join already uses is available —
  // makes the result exact, and the client just checks membership.
  // "tube" is in the alternation because the historical tileset uses
  // "Acton Town tube station" where station-list.json has plain "Acton Town".
  // Leaving it out hid 142 London Underground stations that DO have a Database
  // row — caught by auditing the generated list against station-list.json
  // rather than by trusting the regex. `stations` (plural) covers
  // "Bank and Monument stations". The parenthetical strip runs FIRST so
  // "Hammersmith (District and Piccadilly lines)" reduces before the suffix
  // rule sees it.
  const normName = (n) => String(n || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+(Rail|Railway|Metro|Underground|DLR|Tram|tube)?\s*(Stations|Station|Stop)$/i, '')
    .trim().toLowerCase();
  const liveNorm = new Set(stationList.filter((s) => s.name).map((s) => normName(s.name)));
  // liveCrsSet is declared once, above, near crsToCoords — reused here.
  const hidden = [];
  for (const f of features) {
    if (f.properties.end_year !== null && f.properties.end_year !== undefined) continue; // closed — out of scope
    if (f.properties.crs && liveCrsSet.has(f.properties.crs)) continue;                  // has a Database row
    if (liveNorm.has(normName(f.properties.name))) continue;                             // matches one by name
    hidden.push(f.properties.name);
  }
  hidden.sort();
  writeFileSync(OUT_HIDDEN, JSON.stringify({
    _notes: 'GENERATED by scripts/build-historical-stations.mjs. Names of STILL-OPEN historical stations that have no counterpart in station-list.json, so History must not render them (a still-open station visible in History but not Database is a tab inconsistency). Closed stations are never listed here — they are History-only by design. map.html reads this as an exact deny-list because a MapLibre filter cannot normalise names itself.',
    generated_at: new Date().toISOString(),
    count: hidden.length,
    names: hidden,
  }, null, 2) + '\n');
  console.log(`  tab-consistency hide list: ${hidden.length} still-open stations with no Database row`);

  const existingGeojson = loadExistingGeojson();
  const { mergedFeatures, orphaned } = mergeStationAnnotations(existingGeojson, features);
  assertNoStationAnnotationLoss(orphaned);
  if (existingGeojson) {
    const preservedCount = mergedFeatures.filter((f) => Object.keys(foreignFields(f.properties, STATION_OWNED_KEYS)).length > 0).length;
    console.log(`  Preserved hand-curated fields on ${preservedCount} station(s) via wikidata_qid match; ${orphaned.length} orphaned.`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    OUT_GEOJSON,
    '{"type":"FeatureCollection","features":[\n' +
      mergedFeatures.map((f) => JSON.stringify(f)).join(',\n') +
      '\n]}\n',
  );
  writeFileSync(
    OUT_REPORT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source: 'Wikipedia year categories + Wikidata P625, GB polygon clip',
        _notes:
          'BUGFIX 2026-08-15 (AGR/Angel Road investigation, scratchpad/corrections-layer-scoping.md Section 4): openNow used to be `!!crs` — true whenever stations-content.json had ANY row for this Wikipedia title, regardless of whether that CRS is still live in station-list.json (the actual NaPTAN source). stations-content.json is never pruned when a station closes, so a closed station whose row was never removed rendered as perpetually open no matter what its own article said. Root-caused rather than patched at the one instance: checked live whether this was a one-off or a pattern (2026-08-15) — 633 stations-content.json rows have no station-list.json counterpart, but 632 of those are ATCO tram/metro codes (9400ZZ... — Underground/DLR/Metrolink/Supertram/etc.), which station-list.json never carries BY DESIGN (it is the National Rail CRS database), not a data gap; those are open in reality and were already rendering correctly by coincidence, not because openNow was right about them. AGR was the ONLY genuine 3-letter National Rail CRS in that orphaned set — a real bug, not a symptom of a wider undercount. openNow now additionally requires the crs to appear in a liveCrsSet built from station-list.json itself (hoisted once, reused by the tab-consistency hide list below, which already built the identical set independently). Verified by a real rerun against the full cached dataset (no synthetic test): exactly one stat changed across all 8,884 emitted stations (open_now 2565 -> 2564); every triage bucket, hidden count and uncertain/reorder count was byte-identical, confirming zero collateral effect on the 632 tram/metro entries. AGR itself needed no hand correction at all once fixed at the root — Wikipedia\'s own closure category already had 2019, sourced independently by both Wikidata P3999 and Wikipedia\'s infobox (National Rail Enquiries), and simply was never read because openNow overrode it. stations-content.json\'s own orphaned AGR row was NOT touched — now harmless since openNow no longer trusts it uncritically, but its cleanup (or a general prune of all 633 orphaned rows) is a separate, un-scoped hygiene question, deliberately not folded into this fix.',
        stats,
        triage_legend: {
          a_non_heavy_rail: 'Underground/metro/tram/heritage — may be genuinely open but absent from a NaPTAN-derived list. RENDERED.',
          b_closure_unrecorded: 'Looks like a real closed heavy-rail station whose closure year was never categorised. HIDDEN in v1.',
          c_name_match_failure: 'Within 400 m of a station in station-list.json — probably the same station under a different title. HIDDEN in v1.',
          d_out_of_scope_geo: 'Coordinates fall outside the GB boundary polygon. HIDDEN.',
          d_out_of_scope_category: 'Categorised as Northern Ireland / Isle of Man / Channel Islands. HIDDEN.',
        },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(OUT_REVIEW, JSON.stringify(review, null, 2) + '\n');

  console.log('');
  console.log(`Wrote ${path.relative(ROOT, OUT_GEOJSON)}`);
  console.log(`  candidate articles         ${stats.candidate_articles}`);
  console.log(`  no coordinates             ${stats.no_coordinates}`);
  console.log(`  outside GB polygon         ${stats.outside_gb}`);
  console.log(`  hidden (triage buckets b/c/d) ${stats.hidden_untriaged}`);
  console.log(`  EMITTED                    ${stats.emitted}`);
  console.log(`    open now (station-list)  ${stats.open_now}`);
  console.log(`    multi-period (reopened)  ${stats.reopened_multi_period}`);
  console.log(`    max periods on one       ${stats.max_periods}`);
  console.log(`    start_year inherited     ${stats.inherited_start_year}`);
  console.log('');
  console.log(`  TRIAGE of unevidenced-open stations:`);
  for (const [k, v] of Object.entries(stats.triage).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(26)} ${v}`);
  }
  console.log('');
  console.log(`  periods needing review     ${stats.uncertain_periods}`);
  console.log(`  same-year reorder applied  ${stats.same_year_reordered}  (verify list)`);
  console.log(`  no opening year at all     ${stats.unknown_start_year}`);
  console.log(`Wrote ${path.relative(ROOT, OUT_REPORT)} and ${path.relative(ROOT, OUT_REVIEW)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

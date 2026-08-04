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
    const openNow = !!crs;
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

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    OUT_GEOJSON,
    '{"type":"FeatureCollection","features":[\n' +
      features.map((f) => JSON.stringify(f)).join(',\n') +
      '\n]}\n',
  );
  writeFileSync(
    OUT_REPORT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source: 'Wikipedia year categories + Wikidata P625, GB polygon clip',
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

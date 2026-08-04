#!/usr/bin/env node
/**
 * build-year-event-index.mjs
 *   scripts/output/historical-stations.geojson  ─┐
 *   scripts/output/historical-lines.geojson     ─┴─>  data/year-events.json
 *
 *   node scripts/build-year-event-index.mjs
 *   node scripts/build-year-event-index.mjs --check   (verify only, no write)
 *
 * WHAT THIS IS FOR. The History slider's blurb panel shows supplementary lines
 * per year: "Stations opened: A, B, C and 346 more", "Lines closed: X, Y, Z and
 * 82 more". All DERIVED from data already in the system, not freshly researched,
 * so none of it goes through notable-years.json's reviewed:true gate — but it
 * all gets the plausibility filter below, because deriving a public claim from a
 * malformed row is exactly the failure that gate protects against elsewhere.
 *
 * (Was build-year-station-index.mjs until 2026-08-04; renamed when lines were
 * added so the name stops describing only half of what it emits.)
 *
 * SOURCES, AND ONE THAT LOOKS RIGHT AND IS NOT.
 *   stations: historical-stations.geojson — `periods: [{start_year, end_year}]`,
 *             8,884 stations, 99.9% exact start precision.
 *   lines:    historical-lines.geojson — flat start_year/end_year per way
 *             segment, 11,021 segments collapsing to 1,002 distinct named lines.
 *   NOT stations-content.json's `opened_year`: it covers only currently-open
 *   stations, has no closure field at all, and its parentheticals are all
 *   "rebuilt"/"reopened" — never "closed". Investigated and ruled out 2026-08-04.
 *   NOT line-segments.json: it carries no dates at all.
 *
 * THE TWO SOURCES NEED DIFFERENT end_precision HANDLING, and getting it wrong
 * costs real data:
 *   - STATIONS have a periods[] array while `end_precision` is a FEATURE-level
 *     field describing only the LAST period's end. Testing every period against
 *     it threw away 140 genuine closures — Pelaw Metro has periods
 *     [1843-1979, 1985-null] and end_precision "unknown", where the "unknown"
 *     is the still-open 1985 period and the 1979 closure is real. So the guard
 *     is scoped to the final period only.
 *   - LINES have NO periods[] array (0 of 11,021), so end_precision maps 1:1 to
 *     end_year and the trap cannot occur. Verified: all 5,703 "unknown" rows
 *     have a null end_year, all 5,318 "exact" rows have one.
 *
 * ORDERING IS BY LIFESPAN for both, and it is honestly degenerate for OPENINGS
 * in both. Within one year's opens list every row shares a start year, so every
 * still-open entity ties at the same lifespan and the alphabetical tiebreak
 * decides (1848: 349 stations across 57 lifespans, 109 tied at the top; 51 lines
 * across 8 lifespans, 40 tied). For CLOSURES it works properly, differentiating
 * by how long the thing lasted (1964: 522 stations / 103 lifespans; 85 lines /
 * 44 lifespans). Platform-count tiering was ruled out as the alternative — it
 * resolves for only 23% of historical stations and 5% of 1964's closures, which
 * would name the survivors and bury the actual closures.
 *
 * LINKING PAYLOAD. Each named item carries what the client needs to act on a
 * click, resolved here because the build already holds the full record:
 *   stations: { name, crs?, lon, lat, start_year, end_year? } — crs on ~45%
 *   lines:    { name, lon, lat, start_year, end_year? }
 * See map.html's yearEventLinesHtml() for how each is dispatched.
 *
 * IDEMPOTENT: output depends only on the two sources and the current year. Ties
 * break alphabetically so the ordering is total and the bytes are stable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIONS_SRC = path.join(ROOT, 'scripts', 'output', 'historical-stations.geojson');
const LINES_SRC = path.join(ROOT, 'scripts', 'output', 'historical-lines.geojson');
const OUT = path.join(ROOT, 'data', 'year-events.json');

const NAMED = 3;
const NOW = new Date().getUTCFullYear();
const MIN_YEAR = 1800;
const MAX_YEAR = NOW + 1;
const round5 = (n) => Math.round(n * 1e5) / 1e5; // ~1m precision, keeps the file small

// PLAUSIBILITY FILTER. Outside this range is a malformed row, not a historical
// event — the real data spans 1812-2026.
const plausible = (y) => Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;

const stats = {
  stationFeatures: 0, lineFeatures: 0,
  stationOpens: 0, stationCloses: 0, lineOpens: 0, lineCloses: 0,
  rejectedImplausibleYear: 0, rejectedUnknownEndPrecision: 0, rejectedNoName: 0,
};

/** Midpoint of a LineString — good enough to fly to, and one coordinate pair
 *  instead of hundreds. */
function lineMidpoint(geom) {
  if (!geom) return null;
  const c = geom.type === 'MultiLineString' ? geom.coordinates.flat() : geom.coordinates;
  if (!c || !c.length) return null;
  return c[Math.floor(c.length / 2)];
}

function collectStations() {
  const fc = JSON.parse(readFileSync(STATIONS_SRC, 'utf8'));
  stats.stationFeatures = fc.features.length;
  const opens = new Map(), closes = new Map();
  const push = (map, year, item) => {
    if (!map.has(year)) map.set(year, []);
    map.get(year).push(item);
  };
  for (const f of fc.features) {
    const p = f.properties || {};
    const name = (p.name || '').trim();
    const coords = (f.geometry && f.geometry.coordinates) || null;
    const periods = p.periods && p.periods.length ? p.periods
      : [{ start_year: p.start_year, end_year: p.end_year }];
    for (const per of periods) {
      if (!name) { stats.rejectedNoName++; continue; }
      const start = per.start_year, end = per.end_year;
      // Lifespan is PER PERIOD — a station open 1848-1900 and again 1920-1964
      // has two separate lives, and its 1964 closure is honestly ranked by the
      // 1920-1964 span. A missing end means "still open", measured to now.
      const lifespan = (Number.isInteger(end) ? end : NOW) - start;
      // start_year/end_year travel with the item because History's own
      // selectHistoricalStation() reads them to drive the slider-follow span.
      // Without them a link click would open the panel with no span at all.
      const item = { name, lifespan, start_year: start };
      if (Number.isInteger(end)) item.end_year = end;
      if (coords) { item.lon = round5(coords[0]); item.lat = round5(coords[1]); }
      if (p.crs) item.crs = p.crs;

      if (plausible(start)) { push(opens, start, item); stats.stationOpens++; }
      else if (start != null) stats.rejectedImplausibleYear++;

      if (Number.isInteger(end)) {
        // Scoped to the FINAL period only — see the Pelaw note in the header.
        const isFinalPeriodEnd = Number.isInteger(p.end_year) && end === p.end_year;
        if (isFinalPeriodEnd && p.end_precision === 'unknown') stats.rejectedUnknownEndPrecision++;
        else if (plausible(end)) { push(closes, end, { ...item, lifespan: end - start }); stats.stationCloses++; }
        else stats.rejectedImplausibleYear++;
      }
    }
  }
  return { opens, closes };
}

function collectLines() {
  const fc = JSON.parse(readFileSync(LINES_SRC, 'utf8'));
  stats.lineFeatures = fc.features.length;
  // A named line is spread across many way segments (median 2, max 452), so it
  // is collapsed to ONE entry per name per year before anything is counted —
  // otherwise "Lines opened" would report way counts, not lines.
  const opens = new Map(), closes = new Map();
  const merge = (map, year, item) => {
    if (!map.has(year)) map.set(year, new Map());
    const byName = map.get(year);
    const prev = byName.get(item.name);
    // Keep the longest-lived segment as the representative for this line/year.
    if (!prev || item.lifespan > prev.lifespan) byName.set(item.name, item);
  };
  for (const f of fc.features) {
    const p = f.properties || {};
    const name = (p.name || '').trim();
    if (!name) { stats.rejectedNoName++; continue; }
    const start = p.start_year, end = p.end_year;
    const mid = lineMidpoint(f.geometry);
    const base = { name, start_year: start };
    if (mid) { base.lon = round5(mid[0]); base.lat = round5(mid[1]); }
    if (Number.isInteger(end)) base.end_year = end;

    if (plausible(start)) {
      merge(opens, start, { ...base, lifespan: (Number.isInteger(end) ? end : NOW) - start });
      stats.lineOpens++;
    } else if (start != null) stats.rejectedImplausibleYear++;

    if (Number.isInteger(end)) {
      // No periods[] on lines, so end_precision maps straight to end_year and
      // this is a plain guard rather than the scoped one stations need.
      if (p.end_precision === 'unknown') stats.rejectedUnknownEndPrecision++;
      else if (plausible(end)) { merge(closes, end, { ...base, lifespan: end - start }); stats.lineCloses++; }
      else stats.rejectedImplausibleYear++;
    }
  }
  const flatten = (m) => new Map([...m].map(([y, byName]) => [y, [...byName.values()]]));
  return { opens: flatten(opens), closes: flatten(closes) };
}

const rank = (a, b) => (b.lifespan - a.lifespan) || a.name.localeCompare(b.name, 'en');

/** Top-3 named items + a remainder count. `more` is omitted entirely when
 *  everything fits, so the renderer never has an "and 0 more" case. */
function pack(rows) {
  if (!rows || !rows.length) return null;
  const seen = new Set(), uniq = [];
  for (const r of [...rows].sort(rank)) {
    if (seen.has(r.name)) continue;
    seen.add(r.name); uniq.push(r);
  }
  const strip = ({ lifespan, ...rest }) => rest; // lifespan is a sort key, not payload
  const out = { items: uniq.slice(0, NAMED).map(strip), total: uniq.length };
  if (uniq.length > NAMED) out.more = uniq.length - NAMED;
  return out;
}

const stations = collectStations();
const lines = collectLines();

const years = {};
const allYears = new Set([
  ...stations.opens.keys(), ...stations.closes.keys(),
  ...lines.opens.keys(), ...lines.closes.keys(),
].filter(plausible));
for (const year of [...allYears].sort((a, b) => a - b)) {
  const entry = {};
  const st = {}, ln = {};
  const so = pack(stations.opens.get(year)), sc = pack(stations.closes.get(year));
  const lo = pack(lines.opens.get(year)), lc = pack(lines.closes.get(year));
  if (so) st.opened = so;
  if (sc) st.closed = sc;
  if (lo) ln.opened = lo;
  if (lc) ln.closed = lc;
  if (Object.keys(st).length) entry.stations = st;
  if (Object.keys(ln).length) entry.lines = ln;
  if (Object.keys(entry).length) years[String(year)] = entry;
}

const payload = {
  _notes: 'GENERATED by scripts/build-year-event-index.mjs from scripts/output/historical-stations.geojson and historical-lines.geojson. DO NOT HAND-EDIT — re-run the script. Derived data, so it does NOT use notable-years.json\'s reviewed:true gate; the plausibility filter in the script is the safety check instead. Each list holds up to 3 `items` ordered by LIFESPAN (longest-lived first, alphabetical tiebreak), a `total`, and `more` (= total - 3) only when there is a remainder. Station items carry crs (when the station still exists) plus lon/lat; line items carry lon/lat and their year span — enough for the client to select or fly to them without a second lookup. Closures exclude unconfirmed end dates.',
  generated_from: ['scripts/output/historical-stations.geojson', 'scripts/output/historical-lines.geojson'],
  named_limit: NAMED,
  year_range_filter: [MIN_YEAR, MAX_YEAR],
  stats,
  years,
};

const json = JSON.stringify(payload, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = null;
  try { current = readFileSync(OUT, 'utf8'); } catch { /* not written yet */ }
  if (current === json) { console.log('year-events.json is up to date (byte-identical).'); process.exit(0); }
  console.error('year-events.json DIFFERS from a fresh build — re-run without --check.');
  process.exit(1);
}

writeFileSync(OUT, json);
console.log(`Wrote ${path.relative(ROOT, OUT)}`);
console.log(`  years with events        : ${Object.keys(years).length}`);
console.log(`  station opens / closes   : ${stats.stationOpens} / ${stats.stationCloses}`);
console.log(`  line opens / closes      : ${stats.lineOpens} / ${stats.lineCloses}  (way segments, pre-dedupe)`);
console.log(`  rejected — implausible yr: ${stats.rejectedImplausibleYear}`);
console.log(`  rejected — unknown end   : ${stats.rejectedUnknownEndPrecision}`);
console.log(`  rejected — no name       : ${stats.rejectedNoName}`);
console.log(`  size                     : ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);

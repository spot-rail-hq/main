#!/usr/bin/env node
/**
 * build-year-station-index.mjs
 *   scripts/output/historical-stations.geojson  ->  data/year-station-events.json
 *
 *   node scripts/build-year-station-index.mjs
 *   node scripts/build-year-station-index.mjs --check   (verify only, no write)
 *
 * WHAT THIS IS FOR. The History slider's blurb panel shows a supplementary line
 * per year: "Stations opened: A, B, C and 346 more". That is DERIVED from data
 * already in the system, not freshly researched, so it does not go through
 * notable-years.json's reviewed:true gate — but it does get the plausibility
 * filter below, because deriving a public claim from a malformed row is exactly
 * the failure the gate protects against everywhere else.
 *
 * THE SOURCE IS historical-stations.geojson, NOT stations-content.json.
 * stations-content.json has an `opened_year` field that looks like it would do,
 * and it will not: it covers only the ~2,630 CURRENTLY OPEN National Rail
 * stations, it has no closure field at all, and its parentheticals are all
 * "rebuilt"/"reopened"/"relocated" — never "closed". Investigated and ruled out
 * 2026-08-04. The geojson's `periods: [{start_year, end_year}]` is the real
 * open-periods data: 8,884 stations, 99.9% exact start precision.
 *
 * WHY THE OUTPUT IS TINY. The source is 3.7 MB of point geometry. This keeps
 * three names and two integers per year and throws the rest away, so what ships
 * is a few tens of KB.
 *
 * ORDERING IS BY LIFESPAN, NOT PLATFORM COUNT. The map's major/mid/minor dot
 * tiering is keyed on platform counts from stations-content.json, which only
 * resolve for 23.2% of historical stations — and for CLOSURES it collapses to
 * 5% (28 of 1964's 522). Ordering by that would name only the handful of
 * closures whose sites still exist today and bury the other 494 in "and N more",
 * which inverts the meaning of the line. Lifespan is available for 100% of rows
 * from the same field, so it is used instead. Decision taken 2026-08-04.
 *
 * IDEMPOTENT: output depends only on the source file and the current year.
 * Ties are broken alphabetically so the ordering is total and stable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'scripts', 'output', 'historical-stations.geojson');
const OUT = path.join(ROOT, 'data', 'year-station-events.json');

const NAMED = 3;                     // names listed before "and N more"
const NOW = new Date().getUTCFullYear();
const MIN_YEAR = 1800;
const MAX_YEAR = NOW + 1;            // +1 so a station opening next year is not silently dropped

// PLAUSIBILITY FILTER. A year outside this range is a malformed row, not a
// historical event — the source's real range is 1812–2026, so anything outside
// 1800..NOW+1 is bad data rather than an edge case worth rendering.
const plausible = (y) => Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;

function build() {
  const fc = JSON.parse(readFileSync(SRC, 'utf8'));
  const byYear = new Map();
  const stats = {
    features: fc.features.length, periodsSeen: 0,
    opensKept: 0, closesKept: 0,
    rejectedImplausibleYear: 0, rejectedUnknownEndPrecision: 0, rejectedNoName: 0,
  };

  const bucket = (year) => {
    if (!byYear.has(year)) byYear.set(year, { opens: [], closes: [] });
    return byYear.get(year);
  };

  for (const f of fc.features) {
    const p = f.properties || {};
    const name = (p.name || '').trim();
    const periods = p.periods && p.periods.length ? p.periods
      : [{ start_year: p.start_year, end_year: p.end_year }];

    for (const per of periods) {
      stats.periodsSeen++;
      if (!name) { stats.rejectedNoName++; continue; }
      const start = per.start_year, end = per.end_year;

      // LIFESPAN IS PER PERIOD, not per station. A station open 1848-1900 and
      // again 1920-1964 has two separate lives; ranking its 1964 closure by the
      // 1920-1964 span is the honest figure for that event.
      //
      // A missing end_year means "still open / no closure recorded", so the
      // period is measured to the present. That satisfies "treat as maximally
      // long-lived" — within any one year's OPENS list every row shares a start
      // year, so an open-ended period is necessarily the longest — while still
      // giving a real number that breaks ties between still-open stations by
      // age instead of collapsing them all into one Infinity.
      const lifespan = (Number.isInteger(end) ? end : NOW) - start;

      if (plausible(start)) {
        bucket(start).opens.push({ name, lifespan });
        stats.opensKept++;
      } else if (start !== undefined && start !== null) {
        stats.rejectedImplausibleYear++;
      }

      if (Number.isInteger(end)) {
        // UNKNOWN-END-PRECISION GUARD — scoped to the FINAL period only, and the
        // scoping is the whole point.
        //
        // `end_precision` is a FEATURE-level field: it describes the feature's
        // own `end_year`, i.e. the end of its LAST period. The objects inside
        // `periods[]` carry nothing but start_year/end_year — there is no
        // per-period precision. So testing every period's end against the
        // feature's precision is a category error, and an expensive one:
        // Pelaw Metro has periods [1843-1979, 1985-null] and end_precision
        // "unknown" — the unknown refers to the still-open 1985 period, while
        // the 1979 closure is real and documented. A blanket test threw away
        // 140 genuine closures like that one.
        //
        // Scoped correctly, the guard currently rejects NOTHING, because all 530
        // unknown-precision features have a null feature-level end_year and so
        // reach this branch with no year to assert. It is kept as a guard rather
        // than deleted: if the source ever gains an unknown-precision feature
        // that DOES carry an end year, that year must not be published as a
        // closure. `stats.rejectedUnknownEndPrecision` reports the real count.
        const isFinalPeriodEnd = Number.isInteger(p.end_year) && end === p.end_year;
        if (isFinalPeriodEnd && p.end_precision === 'unknown') {
          stats.rejectedUnknownEndPrecision++;
        } else if (plausible(end)) {
          bucket(end).closes.push({ name, lifespan });
          stats.closesKept++;
        } else {
          stats.rejectedImplausibleYear++;
        }
      }
    }
  }

  // Longest-lived first; alphabetical tiebreak keeps the sort total and the
  // output byte-identical between runs.
  const rank = (a, b) => (b.lifespan - a.lifespan) || a.name.localeCompare(b.name, 'en');

  const years = {};
  for (const [year, v] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const pack = (rows) => {
      // Dedupe by name — a station with two periods starting in the same year
      // must not be listed twice.
      const seen = new Set(), uniq = [];
      for (const r of rows.sort(rank)) {
        if (seen.has(r.name)) continue;
        seen.add(r.name); uniq.push(r);
      }
      if (!uniq.length) return null;
      const out = { names: uniq.slice(0, NAMED).map((r) => r.name), total: uniq.length };
      // `more` is omitted entirely when everything fits, so the renderer has
      // nothing to decide — no "and 0 more".
      if (uniq.length > NAMED) out.more = uniq.length - NAMED;
      return out;
    };
    const opened = pack(v.opens), closed = pack(v.closes);
    if (!opened && !closed) continue;
    years[String(year)] = {};
    if (opened) years[String(year)].opened = opened;
    if (closed) years[String(year)].closed = closed;
  }

  return {
    payload: {
      _notes: 'GENERATED by scripts/build-year-station-index.mjs from scripts/output/historical-stations.geojson. DO NOT HAND-EDIT — re-run the script. Derived data, so it does NOT use notable-years.json\'s reviewed:true gate; the plausibility filter in the script is the safety check instead. `names` is up to 3 stations ordered by LIFESPAN (longest-lived first, alphabetical tiebreak), `total` is the real count for that year, and `more` (= total - 3) is present only when there is a remainder. Closures exclude rows whose end_precision is "unknown" — an unconfirmed end date must not be asserted as a closure year.',
      generated_from: 'scripts/output/historical-stations.geojson',
      named_limit: NAMED,
      year_range_filter: [MIN_YEAR, MAX_YEAR],
      stats,
      years,
    },
    stats,
  };
}

const { payload, stats } = build();
const json = JSON.stringify(payload, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = null;
  try { current = readFileSync(OUT, 'utf8'); } catch { /* not written yet */ }
  if (current === json) { console.log('year-station-events.json is up to date (byte-identical).'); process.exit(0); }
  console.error('year-station-events.json DIFFERS from a fresh build — re-run without --check.');
  process.exit(1);
}

writeFileSync(OUT, json);
const yearCount = Object.keys(payload.years).length;
console.log(`Wrote ${path.relative(ROOT, OUT)}`);
console.log(`  years with events        : ${yearCount}`);
console.log(`  opens kept               : ${stats.opensKept}`);
console.log(`  closes kept              : ${stats.closesKept}`);
console.log(`  rejected — implausible yr: ${stats.rejectedImplausibleYear}`);
console.log(`  rejected — unknown end   : ${stats.rejectedUnknownEndPrecision}`);
console.log(`  rejected — no name       : ${stats.rejectedNoName}`);
console.log(`  size                     : ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`);

#!/usr/bin/env node
/**
 * scripts/build-historical-lines.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Builds scripts/output/historical-lines.geojson — the pre-1994 railway line
 * layer for the historical map slider, from OpenHistoricalMap. Deterministic,
 * no AI: every property is either read straight off an OHM tag or resolved
 * through data/big4-constituents.json.
 *
 *   node scripts/build-historical-lines.mjs
 *
 * Optional env vars:
 *   REFETCH=1   ignore the cached OHM download and re-query Overpass. The raw
 *               response is cached at scripts/output/ohm-gb-railway-geom.json
 *               (~21 MB) so iterating on the property mapping does not
 *               re-hammer OHM's public Overpass on every run.
 *
 * ─── WHAT THIS EMITS ──────────────────────────────────────────────────────
 * One LineString feature per OHM way, with:
 *   start_year, end_year          int | null   (null end = still open)
 *   start_precision, end_precision              "exact" | "inferred" | "unknown"
 *   co_pre1923, co_big4, co_br, co_modern       string | null
 *   license                        string      per-feature, carried to tiles
 *   source                         "ohm:way/{id}"
 *   name, railway                  passthrough for popups/styling
 *
 * NO era_band field. 94.5% of dated OHM lines span more than one band and
 * half span all four (Phase 1B), so a stored band would be wrong for almost
 * every feature. Band is a property of the SLIDER POSITION and is computed
 * globally at render time; the four co_* fields exist so a paint expression
 * can pick the right company with a plain property read once the band is
 * known, instead of a per-feature range test.
 *
 * ─── THE co_* FIELDS ──────────────────────────────────────────────────────
 * Each is null unless the way was actually alive during that band, so a line
 * closed in 1900 carries no Big Four or BR attribution and cannot be
 * mis-painted by a band expression.
 *
 *   co_pre1923  the operating/building company from OHM's own tags. Used for
 *               the POPUP only — the pre1923 band renders a single neutral
 *               colour per the locked decision, so this never drives paint.
 *   co_big4     the 1923 group (Great Western Railway / London, Midland and
 *               Scottish Railway / London and North Eastern Railway /
 *               Southern Railway), resolved through data/big4-constituents.json.
 *               KNOWN-ONLY: null where the lookup does not resolve, and the
 *               band renders neutral there. No territorial inference — see
 *               build-big4-lookup.mjs's header for why a chain-walk would be
 *               confidently wrong.
 *   co_br       the constant "British Railways" for anything alive 1948-1993.
 *               A single nationalised operator needs no lookup, which is why
 *               Phase 1's finding that "British Railways" appears exactly once
 *               in OHM's GB tags turned out not to matter.
 *   co_modern   ALWAYS NULL on OHM-sourced features. See the FLAGGED
 *               AMBIGUITY note at the bottom of this header.
 *
 * ─── LICENCE GATE ─────────────────────────────────────────────────────────
 * Every element's license=* tag is resolved against LICENCE_ALLOW_LIST in
 * scripts/lib/historical-era.mjs and the build ABORTS on anything unknown.
 * OHM is CC0 by default but lets contributors override per element, and GB
 * carries ~1,900 National Library of Scotland CC-BY elements that require
 * attribution. Per Phase 1B this must be a refusal, not a warning: an
 * unreviewed CC-BY-NC element would otherwise be absorbed silently into a
 * commercially-monetised map. The resolved licence is carried onto every
 * feature so the UI can credit per feature — data/attribution.json is built
 * from the same census.
 *
 * ─── FLAGGED AMBIGUITY: co_modern ─────────────────────────────────────────
 * The locked schema specifies four co_* fields "for cheap paint expressions",
 * but the locked source-switch means OHM features are only ever painted
 * BEFORE 1994 — after that the map renders data/line-segments.json instead.
 * So co_modern is structurally unreachable on an OHM feature and is emitted
 * as a literal null on every one.
 *
 * The field is kept rather than dropped because it is only meaningful if the
 * modern segments are later emitted into THIS SAME tileset with co_modern
 * populated from their operator codes — which would make the 1994 cross-fade
 * a paint-expression change rather than a source swap, and is arguably the
 * cleaner design. That is a Phase 2B decision, not one to make silently here.
 * Flagged in HISTORICAL-SLIDER-FINDINGS.md § Phase 2A rather than resolved.
 *
 * ─── FIELD OWNERSHIP ──────────────────────────────────────────────────────
 * Sole writer of scripts/output/historical-lines.geojson and
 * scripts/output/historical-lines-report.json. Reads
 * data/big4-constituents.json (built by scripts/build-big4-lookup.mjs).
 * Never writes to data/ or to any *-content.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ERA_BANDS,
  currentYear,
  parseYear,
  datePrecisionOf,
  normalizeCompanyName,
  looksLikeCompanyName,
  resolveLicence,
  LicenceNotAllowedError,
  isLinearRailway,
  gbScopedQuery,
  overpass,
} from './lib/historical-era.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'scripts', 'output');
const CACHE_PATH = path.join(OUTPUT_DIR, 'ohm-gb-railway-geom.json');
const OUT_GEOJSON = path.join(OUTPUT_DIR, 'historical-lines.geojson');
const OUT_REPORT = path.join(OUTPUT_DIR, 'historical-lines-report.json');
const BIG4_PATH = path.join(ROOT, 'data', 'big4-constituents.json');

const BAND = Object.fromEntries(
  ERA_BANDS.map((b) => [b.key, { from: b.from, to: b.to === null ? currentYear() : b.to }]),
);

// A feature is alive during a band if its lifespan overlaps the band at all.
function aliveDuring(startYear, endYear, band) {
  if (startYear === null) return false;
  return startYear <= band.to && (endYear === null || endYear >= band.from);
}

async function loadOhm() {
  if (!process.env.REFETCH && existsSync(CACHE_PATH)) {
    console.log(`Using cached OHM download (${path.relative(ROOT, CACHE_PATH)}) — REFETCH=1 to re-query`);
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  }
  console.log('Querying OHM Overpass for GB railway ways with geometry (~21 MB, slow)...');
  const json = await overpass(gbScopedQuery('way["railway"]', 'geom'));
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(json));
  console.log(`  cached to ${path.relative(ROOT, CACHE_PATH)}`);
  return json;
}

function main(ohm) {
  const elements = ohm.elements || [];
  if (elements.length === 0) {
    throw new Error(
      'OHM returned zero elements. The GB_AREAS relation ids in scripts/lib/historical-era.mjs ' +
        'are probably stale — a renamed/split boundary relation returns an empty set rather than ' +
        'an error. Verify them on openhistoricalmap.org before trusting any output.',
    );
  }

  const big4 = JSON.parse(readFileSync(BIG4_PATH, 'utf8'));
  const big4Lookup = big4.lookup;
  const groupNames = big4.groups;

  // ── Licence gate. Sweep EVERY element (not just the ones we keep) so an
  // unreviewed licence cannot hide on a feature that happens to be filtered
  // out today and kept tomorrow.
  const licenceCensus = {};
  const unknownLicences = new Set();
  for (const el of elements) {
    const raw = el.tags && el.tags.license;
    const key = raw || '(none — OHM CC0 default)';
    licenceCensus[key] = (licenceCensus[key] || 0) + 1;
    try {
      resolveLicence(raw);
    } catch (err) {
      if (err instanceof LicenceNotAllowedError) unknownLicences.add(raw);
      else throw err;
    }
  }
  if (unknownLicences.size) throw new LicenceNotAllowedError([...unknownLicences]);
  console.log('Licence gate passed. Census:');
  for (const [k, v] of Object.entries(licenceCensus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }

  const stats = {
    elements_total: elements.length,
    linear: 0,
    dropped_undated: 0,
    dropped_no_geometry: 0,
    dropped_modern_only: 0,
    emitted: 0,
    start_precision: {},
    end_precision: {},
    co_pre1923: 0,
    co_big4: 0,
    co_br: 0,
    big4_band_alive: 0,
    big4_candidates: 0,
    by_licence: {},
    unresolved_big4_names: {},
  };

  const features = [];
  for (const el of elements) {
    if (!isLinearRailway(el.tags)) continue;
    stats.linear++;
    if (!el.geometry || el.geometry.length < 2) {
      stats.dropped_no_geometry++;
      continue;
    }

    const tags = el.tags;
    const startYear = parseYear(tags.start_date);
    const endYear = parseYear(tags.end_date);

    // LOCKED: undated lines are hidden. A line with no start year cannot be
    // placed on the slider at all, so it is dropped here rather than shipped
    // and filtered client-side.
    if (startYear === null) {
      stats.dropped_undated++;
      continue;
    }

    // This layer covers the historical bands only — the modern band renders
    // from data/line-segments.json instead (locked source-switch at 1994).
    // A way that did not exist before 1994 has nothing to contribute here.
    if (startYear >= BAND.modern.from) {
      stats.dropped_modern_only++;
      continue;
    }

    const licence = resolveLicence(tags.license);

    // Company candidate: OHM's own operator tag first (an explicit assertion
    // of who ran it), falling back to a `name` that looks like a company
    // rather than a route ("Liverpool and Manchester Railway", not
    // "Settle-Carlisle Line"). Phase 1 measured operator at ~7% and
    // company-like names at 28.7%, so the fallback is doing most of the work.
    const companyCandidate =
      tags.operator || (looksLikeCompanyName(tags.name) ? tags.name : null);

    const aliveBig4 = aliveDuring(startYear, endYear, BAND.big4);
    const aliveBr = aliveDuring(startYear, endYear, BAND.br);
    const alivePre = aliveDuring(startYear, endYear, BAND.pre1923);

    let coBig4 = null;
    if (aliveBig4) {
      stats.big4_band_alive++;
      if (companyCandidate) {
        stats.big4_candidates++;
        const group = big4Lookup[normalizeCompanyName(companyCandidate)];
        if (group) coBig4 = groupNames[group];
        else {
          stats.unresolved_big4_names[companyCandidate] =
            (stats.unresolved_big4_names[companyCandidate] || 0) + 1;
        }
      }
    }

    const coPre = alivePre ? companyCandidate || null : null;
    const coBr = aliveBr ? 'British Railways' : null;

    const startPrecision = datePrecisionOf(tags.start_date);
    const endPrecision = tags.end_date ? datePrecisionOf(tags.end_date) : 'unknown';

    stats.start_precision[startPrecision] = (stats.start_precision[startPrecision] || 0) + 1;
    stats.end_precision[endPrecision] = (stats.end_precision[endPrecision] || 0) + 1;
    if (coPre) stats.co_pre1923++;
    if (coBig4) stats.co_big4++;
    if (coBr) stats.co_br++;
    stats.by_licence[licence.code] = (stats.by_licence[licence.code] || 0) + 1;

    features.push({
      type: 'Feature',
      properties: {
        start_year: startYear,
        end_year: endYear,
        start_precision: startPrecision,
        // An absent end_date is genuinely ambiguous in OHM — it can mean
        // "still open" or "nobody recorded the closure". end_year stays null
        // (rendered as still-present) but the precision records that we do
        // not actually know, so the UI can say so rather than assert it.
        end_precision: endPrecision,
        co_pre1923: coPre,
        co_big4: coBig4,
        co_br: coBr,
        co_modern: null, // see the FLAGGED AMBIGUITY note in this file's header
        license: licence.code,
        source: `ohm:way/${el.id}`,
        name: tags.name || null,
        railway: tags.railway,
      },
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map((g) => [
          Math.round(g.lon * 1e6) / 1e6,
          Math.round(g.lat * 1e6) / 1e6,
        ]),
      },
    });
    stats.emitted++;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  // Newline-delimited GeoJSON features inside a FeatureCollection: tippecanoe
  // reads either, and one-feature-per-line keeps the file greppable and
  // diffable rather than a single 20 MB line.
  const head = '{"type":"FeatureCollection","features":[\n';
  const body = features.map((f) => JSON.stringify(f)).join(',\n');
  writeFileSync(OUT_GEOJSON, head + body + '\n]}\n');

  const report = {
    generated_at: new Date().toISOString(),
    source: 'OpenHistoricalMap via overpass-api.openhistoricalmap.org, GB polygon clip',
    ohm_timestamp: ohm.osm3s && ohm.osm3s.timestamp_osm_base,
    stats: {
      ...stats,
      // Keep the report readable — the full unresolved list goes in its own
      // field below, sorted, for the correction-mechanism backlog.
      unresolved_big4_names: undefined,
    },
    big4_match_rate:
      stats.big4_candidates > 0
        ? +((100 * stats.co_big4) / stats.big4_candidates).toFixed(1)
        : null,
    big4_band_coverage:
      stats.big4_band_alive > 0
        ? +((100 * stats.co_big4) / stats.big4_band_alive).toFixed(1)
        : null,
    licence_census: licenceCensus,
    unresolved_big4_names: Object.entries(stats.unresolved_big4_names)
      .sort((a, b) => b[1] - a[1])
      .map(([name, ways]) => ({ name, ways })),
  };
  writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2) + '\n');

  console.log('');
  console.log(`Wrote ${path.relative(ROOT, OUT_GEOJSON)}`);
  console.log(`  elements in extract        ${stats.elements_total}`);
  console.log(`  linear track ways          ${stats.linear}`);
  console.log(`  dropped, undated (hidden)  ${stats.dropped_undated}`);
  console.log(`  dropped, modern-only       ${stats.dropped_modern_only}`);
  console.log(`  dropped, no geometry       ${stats.dropped_no_geometry}`);
  console.log(`  EMITTED                    ${stats.emitted}`);
  console.log('');
  console.log(`  co_pre1923 populated       ${stats.co_pre1923}`);
  console.log(`  co_br populated            ${stats.co_br}`);
  console.log(`  co_big4 populated          ${stats.co_big4}`);
  console.log(`    of ways alive in band    ${stats.big4_band_alive}  (${report.big4_band_coverage}% coloured)`);
  console.log(`    of those with a name     ${stats.big4_candidates}  (${report.big4_match_rate}% match rate)`);
  console.log('');
  console.log(`  licence split              ${JSON.stringify(stats.by_licence)}`);
  console.log(`Wrote ${path.relative(ROOT, OUT_REPORT)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadOhm()
    .then(main)
    .catch((err) => {
      console.error(`\n${err.message}`);
      process.exit(1);
    });
}

#!/usr/bin/env node
/**
 * scripts/scope-wikipedia-coverage.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPING / REPORT PASS ONLY. Does not read or write stations-content.json.
 *
 * Classifies every station in station-list.json (the local materialization
 * of naptan_stations — name/crs/lat/lon, 2,637 rows) into no-article / stub
 * / substantive Wikipedia coverage tiers, ahead of scoping the "Notable
 * Features" content rollout that scripts/fetch-wikipedia-facts.mjs will
 * eventually populate.
 *
 * Run:
 *   node scripts/scope-wikipedia-coverage.mjs
 *
 * Resumable: writes a checkpoint to scripts/output/wikipedia-coverage-
 * checkpoint.json every CHECKPOINT_EVERY stations; re-running skips CRS
 * codes already present in the checkpoint. Delete the checkpoint file to
 * start clean.
 *
 * ─── Phase 1: station → article matching ──────────────────────────────────
 * Candidate titles are tried in order via the REST summary endpoint
 * (/api/rest_v1/page/summary/), cheapest/most-specific first:
 *   1. "{base} railway station"                (+ "(qualifier)" variant)
 *   2. "{base} station"                        (+ "(qualifier)" variant)
 *   3. "{base}"                                (+ "(qualifier)" variant)
 * where `base`/`qualifier` come from stripping NaPTAN's "Rail Station"
 * suffix and any trailing "(Qualifier)" disambiguator off the raw name
 * (e.g. "Richmond (London) Rail Station" → base "Richmond", qualifier
 * "London"). A candidate is accepted as a confident match if EITHER:
 *   - its normalized title exactly equals the normalized base name, or
 *   - the summary carries coordinates within 20km of the station's
 *     lat/lon (station-list.json's own field, standing in for the
 *     "CRS code + rough lat/lon" sanity check — CRS itself isn't
 *     recoverable from the REST summary response, which has no infobox
 *     data; CRS is carried through into every report row instead, for a
 *     human to cross-reference by eye)
 * Disambiguation pages are never accepted, even as a fallback. Coordinates
 * present but >20km away reject that candidate outright (try the next).
 * A real page whose title diverges from the base name AND carries no
 * coordinates is not guessable either way — held as a "weak candidate" and
 * the station is flagged needs-manual-review with that page named, rather
 * than silently accepted or silently dropped.
 *
 * ─── Phase 2: tier classification ─────────────────────────────────────────
 * Reuses the summary already fetched during matching (no second request):
 *   no-article  — nothing in Phase 1 confidently resolved
 *   stub        — matched, but extract text < STUB_THRESHOLD_CHARS chars
 *   substantive — matched, extract >= STUB_THRESHOLD_CHARS chars
 *
 * ─── Phase 3: output ───────────────────────────────────────────────────────
 * scripts/output/wikipedia-coverage-report.json  — full machine-readable report
 * scripts/output/wikipedia-coverage-report.md    — human-readable summary
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');
const OUTPUT_DIR = path.join(ROOT, 'scripts', 'output');
export const CHECKPOINT_PATH = path.join(OUTPUT_DIR, 'wikipedia-coverage-checkpoint.json');
export const REPORT_JSON_PATH = path.join(OUTPUT_DIR, 'wikipedia-coverage-report.json');
export const REPORT_MD_PATH = path.join(OUTPUT_DIR, 'wikipedia-coverage-report.md');

const REST_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const USER_AGENT = 'SpotRailHQ-content-scoping-script/1.0 (+https://srhq.uk; static report build step, not a live API dependency)';
const REQUEST_DELAY_MS = 150; // be a good citizen — this is 2,637+ stations, up to ~6 requests each worst case
const MAX_RETRIES = 3;
export const GEO_REJECT_KM = 20;
export const STUB_THRESHOLD_CHARS = 400;
const CHECKPOINT_EVERY = 50;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}
export function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// ─── name normalization ────────────────────────────────────────────────────
// NaPTAN names look like "Alexandra Palace Rail Station" or
// "Richmond (London) Rail Station" — strip the "Rail Station" suffix and
// split off any trailing "(Qualifier)" disambiguator.
export function splitNaptanName(rawName) {
  let s = rawName.trim().replace(/\s*rail\s*station\s*$/i, '').trim();
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { base: m[1].trim(), qualifier: m[2].trim() };
  return { base: s, qualifier: null };
}

export function normalizeForCompare(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\brail(?:way)? station\b/g, '')
    .replace(/\bstation\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function buildCandidates(base, qualifier) {
  const list = [];
  list.push(`${base} railway station`);
  if (qualifier) list.push(`${base} railway station (${qualifier})`);
  list.push(`${base} station`);
  if (qualifier) list.push(`${base} station (${qualifier})`);
  list.push(base);
  if (qualifier) list.push(`${base} (${qualifier})`);
  // Wikipedia disambiguates some England stations against an international
  // namesake with "(England)" rather than a county name (confirmed live for
  // Layton — the Blackpool station is "Layton railway station (England)",
  // disambiguated against Layton station, Utah — and Hatton railway station
  // resolves the same way). Tried last: only relevant once the more specific
  // candidates above have failed.
  list.push(`${base} railway station (England)`);
  return [...new Set(list)];
}

// ─── geo sanity check ──────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── REST summary fetch, with 429/5xx backoff ─────────────────────────────
async function fetchSummary(title) {
  const url = REST_SUMMARY_API + encodeURIComponent(title.replace(/ /g, '_'));
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      attempt++;
      if (attempt > MAX_RETRIES) return { error: `HTTP ${res.status} after ${MAX_RETRIES} retries` };
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  }
}

// ─── Phase 1 + 2 combined per station (one fetch pass reused for both) ────
// extraCandidates: appended after the standard candidate list — used by
// scripts/rematch-abbreviation-mismatches.mjs to try a NaPTAN-abbreviation-
// expanded qualifier (e.g. "Warks" → "Warwickshire") without duplicating
// this function's matching/scoring logic.
export async function matchStation(station, extraCandidates = []) {
  const { base, qualifier } = splitNaptanName(station.name);
  const candidates = [...buildCandidates(base, qualifier), ...extraCandidates];
  const normalizedBase = normalizeForCompare(base);
  let weakCandidate = null;
  const triedNotes = [];

  for (const candidate of candidates) {
    const summary = await fetchSummary(candidate);
    await sleep(REQUEST_DELAY_MS);

    if (summary === null) {
      triedNotes.push(`"${candidate}": no page`);
      continue;
    }
    if (summary.error) {
      triedNotes.push(`"${candidate}": ${summary.error}`);
      continue;
    }
    if (summary.type === 'disambiguation') {
      triedNotes.push(`"${candidate}": disambiguation page, skipped`);
      continue;
    }

    const titleMatch = normalizeForCompare(summary.title) === normalizedBase;
    let geoOk = null;
    if (summary.coordinates && station.lat != null && station.lon != null) {
      const dist = haversineKm(station.lat, station.lon, summary.coordinates.lat, summary.coordinates.lon);
      geoOk = dist <= GEO_REJECT_KM;
      if (!geoOk) {
        triedNotes.push(`"${candidate}" → "${summary.title}": rejected, ${dist.toFixed(1)}km from station`);
        continue;
      }
    }

    if (titleMatch || geoOk === true) {
      return {
        status: 'matched',
        matchedTitle: summary.title,
        matchedCandidate: candidate,
        confidence: titleMatch && geoOk === true ? 'title+geo' : titleMatch ? 'title' : 'geo',
        extractLength: (summary.extract || '').length,
        extract: summary.extract || '',
        pageUrl: summary.content_urls?.desktop?.page || null,
        description: summary.description || null,
      };
    }

    // Real, non-disambiguation page, but neither title nor geo confirms it —
    // keep as a fallback candidate, don't accept, keep trying the rest.
    if (!weakCandidate) {
      weakCandidate = { candidate, title: summary.title, extractLength: (summary.extract || '').length, hasCoordinates: !!summary.coordinates };
    }
    triedNotes.push(`"${candidate}" → "${summary.title}": unverified (no title/geo match)`);
  }

  return {
    status: 'needs-review',
    reason: weakCandidate
      ? `Found a page ("${weakCandidate.title}") but couldn't confirm it's the right one — title doesn't match and ${weakCandidate.hasCoordinates ? 'coordinates were too far' : 'no coordinates to check'}.`
      : `No Wikipedia page found for any candidate title.`,
    weakCandidate,
    candidatesTried: candidates,
    notes: triedNotes,
  };
}

export function classifyTier(matchResult) {
  if (matchResult.status !== 'matched') return 'no-article';
  return matchResult.extractLength >= STUB_THRESHOLD_CHARS ? 'substantive' : 'stub';
}

async function main() {
  const stations = loadJson(STATION_LIST_PATH, []);
  if (!stations.length) throw new Error(`station-list.json not found or empty at ${STATION_LIST_PATH}`);

  const checkpoint = loadJson(CHECKPOINT_PATH, { results: {} });
  const alreadyDone = new Set(Object.keys(checkpoint.results));
  console.log(`Loaded ${stations.length} stations. ${alreadyDone.size} already checkpointed, resuming.`);

  let processed = alreadyDone.size;
  for (const station of stations) {
    if (alreadyDone.has(station.crs)) continue;

    let result;
    try {
      result = await matchStation(station);
    } catch (err) {
      result = { status: 'needs-review', reason: `Fetch error: ${err.message}`, weakCandidate: null, candidatesTried: [], notes: [] };
    }

    checkpoint.results[station.crs] = {
      crs: station.crs,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      tier: classifyTier(result),
      ...result,
    };

    processed++;
    if (processed % CHECKPOINT_EVERY === 0 || processed === stations.length) {
      saveJson(CHECKPOINT_PATH, checkpoint);
      console.log(`  ${processed}/${stations.length} processed (checkpoint saved)`);
    }
  }
  saveJson(CHECKPOINT_PATH, checkpoint);

  // ─── Phase 3: assemble report ───────────────────────────────────────────
  const all = Object.values(checkpoint.results);
  const matched = all.filter((r) => r.status === 'matched');
  const needsReview = all.filter((r) => r.status === 'needs-review');
  const tiers = { 'no-article': [], stub: [], substantive: [] };
  for (const r of all) tiers[r.tier].push(r.crs);

  const sampleSubstantive = matched
    .filter((r) => r.tier === 'substantive')
    .sort((a, b) => b.extractLength - a.extractLength)
    .slice(0, 8)
    .map((r) => ({
      crs: r.crs,
      name: r.name,
      matchedTitle: r.matchedTitle,
      extractLength: r.extractLength,
      extractPreview: r.extract.slice(0, 500),
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    totalStations: stations.length,
    matchRate: { autoMatched: matched.length, needsManualReview: needsReview.length },
    tierCounts: {
      'no-article': tiers['no-article'].length,
      stub: tiers.stub.length,
      substantive: tiers.substantive.length,
    },
    tierCrsLists: tiers,
    needsManualReview: needsReview.map((r) => ({
      crs: r.crs,
      name: r.name,
      reason: r.reason,
      weakCandidate: r.weakCandidate,
      candidatesTried: r.candidatesTried,
    })),
    sampleSubstantive,
    stubThresholdChars: STUB_THRESHOLD_CHARS,
    geoRejectKm: GEO_REJECT_KM,
  };
  saveJson(REPORT_JSON_PATH, report);

  const md = `# Wikipedia coverage scoping report — naptan_stations

Generated: ${report.generatedAt}

## Match rate (Phase 1)
- Auto-matched: ${report.matchRate.autoMatched} / ${report.totalStations}
- Needs manual review: ${report.matchRate.needsManualReview} / ${report.totalStations}

## Tier breakdown (Phase 2)
- no-article: ${report.tierCounts['no-article']}
- stub (extract < ${STUB_THRESHOLD_CHARS} chars): ${report.tierCounts.stub}
- substantive (extract >= ${STUB_THRESHOLD_CHARS} chars): ${report.tierCounts.substantive}

## Sample substantive entries
${sampleSubstantive.map((s) => `### ${s.name} (${s.crs}) — matched "${s.matchedTitle}", ${s.extractLength} chars\n> ${s.extractPreview}${s.extractLength > 500 ? '…' : ''}\n`).join('\n')}

## Needs manual review (first 30 of ${needsReview.length})
${needsReview.slice(0, 30).map((r) => `- **${r.crs}** (${r.name}): ${r.reason}`).join('\n')}

Full CRS lists per tier and the complete review list are in wikipedia-coverage-report.json.
`;
  writeFileSync(REPORT_MD_PATH, md);

  console.log(`\n=== Done ===`);
  console.log(`Match rate: ${report.matchRate.autoMatched}/${report.totalStations} auto-matched, ${report.matchRate.needsManualReview} flagged for review`);
  console.log(`Tiers: no-article=${report.tierCounts['no-article']}, stub=${report.tierCounts.stub}, substantive=${report.tierCounts.substantive}`);
  console.log(`Report written to ${REPORT_JSON_PATH} and ${REPORT_MD_PATH}`);
}

// Only auto-run when executed directly (`node scripts/scope-wikipedia-coverage.mjs`) —
// scripts/rematch-abbreviation-mismatches.mjs imports this module's functions
// without wanting the full 2,637-station run to fire.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

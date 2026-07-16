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
const WIKI_API_ACTION = 'https://en.wikipedia.org/w/api.php'; // used only by searchFallback() below, for action=query&list=search — the REST summary API has no full-text search endpoint of its own

// 2026-07-16: baked directly into the core candidate-building/search flow
// below (buildCandidates(), lastResortCandidates(), searchFallback()) —
// previously this table was only consulted by the separate, one-off
// scripts/rematch-abbreviation-mismatches.mjs script for the narrow
// "mixed-other" needs-review bucket. Folding it in here means a station
// whose qualified candidate 404s only because NaPTAN's abbreviation
// ("S Yorks") doesn't match Wikipedia's spelled-out form ("South
// Yorkshire") gets the expanded form tried BEFORE ever falling through to
// a less specific, more collision-prone candidate — confirmed live this
// was exactly why BYK (Bentley, S Yorks) didn't resolve even with the
// search fallback below: the search query itself needs the expanded
// county name too, Wikipedia's search doesn't reliably fuzzy-match "S
// Yorks" to "South Yorkshire" on its own.
const ABBREV_TABLE_PATH = path.join(ROOT, 'data', 'naptan-county-abbreviations.json');
function loadAbbreviationMap() {
  if (!existsSync(ABBREV_TABLE_PATH)) return {};
  const raw = JSON.parse(readFileSync(ABBREV_TABLE_PATH, 'utf8'));
  return { ...raw.observedInStationList, ...raw.preemptive };
}
const ABBREVIATION_MAP = loadAbbreviationMap();
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

// ─── candidate ordering (fixed 2026-07-16) ─────────────────────────────────
// Two lists, tried in two separate passes by matchStation() below — not one
// flat list — because a live incident showed why the split matters: a bare
// base name with no "station" text and no qualifier (e.g. plain "Bentley",
// plain "Rye") can coincidentally text-match a completely unrelated
// Wikipedia article (Bentley Motors the car maker; rye the cereal grain).
// Confirmed live: this happened for real (BTY/BYK → "Bentley", RYE → "Rye"),
// silently, because those bare candidates were previously interleaved with
// the qualified ones and got accepted the moment any later, more specific
// candidate 404'd — often BEFORE a full-text search was ever tried, since
// there wasn't one. SPECIFIC_CANDIDATES (this function) always contain
// either "station" text or an explicit qualifier, making an unrelated-topic
// collision essentially impossible; BARE_CANDIDATES (below) contain neither
// and are only tried after a full-text-search fallback has also failed, and
// even then only accepted with real geo confirmation — see matchStation().
export function buildCandidates(base, qualifier) {
  const list = [];
  const expandedQualifier = qualifier && ABBREVIATION_MAP[qualifier];
  list.push(`${base} railway station`);
  if (qualifier) list.push(`${base} railway station (${qualifier})`);
  if (expandedQualifier) list.push(`${base} railway station (${expandedQualifier})`);
  list.push(`${base} station`);
  if (qualifier) list.push(`${base} station (${qualifier})`);
  if (expandedQualifier) list.push(`${base} station (${expandedQualifier})`);
  // Wikipedia disambiguates some England stations against an international
  // namesake with "(England)" rather than a county name (confirmed live for
  // Layton — the Blackpool station is "Layton railway station (England)",
  // disambiguated against Layton station, Utah — and Hatton railway station
  // resolves the same way). Tried last: only relevant once the more specific
  // candidates above have failed.
  list.push(`${base} railway station (England)`);
  return [...new Set(list)];
}

// Candidates with NO "station"/"railway station" text — just the bare base
// name, optionally with a location qualifier attached. The single most
// collision-prone candidate form (confirmed live: bare "Bentley" → Bentley
// Motors; "Charing Cross (Glasgow)" — bare, qualifier only, no "station"
// text — → the road-junction article, not a dedicated station page).
// Deliberately excluded from buildCandidates() and only ever tried by
// matchStation() as the last resort, after the full-text search fallback,
// and even then only accepted with real geo confirmation — see
// evaluateSummary()'s requireGeo parameter.
export function buildLastResortCandidates(base, qualifier) {
  const list = [base];
  const expandedQualifier = qualifier && ABBREVIATION_MAP[qualifier];
  if (qualifier) list.push(`${base} (${qualifier})`);
  if (expandedQualifier) list.push(`${base} (${expandedQualifier})`);
  return [...new Set(list)];
}

// ─── full-text search fallback (added 2026-07-16) ──────────────────────────
// Tried when every SPECIFIC_CANDIDATES direct lookup has failed (404'd,
// hit a disambiguation page, or failed geo verification) — before ever
// falling through to a bare, unqualified candidate. Mirrors
// fetch-wikipedia-facts.mjs's resolveWikipediaTitle() search-fallback
// shape, but verifies EITHER a normalized-title match OR a geo match
// (resolveWikipediaTitle only does the title check, which is enough there
// since it's choosing among named entities like operators/routes, not
// disambiguating stations that share a name with unrelated topics).
// Confirmed live this finds the real article in every case checked by hand
// during the 2026-07-16 investigation, e.g. searching "Bentley railway
// station South Yorkshire" surfaces "Bentley railway station (South
// Yorkshire)" directly, and "Stirling railway station" (search, not direct
// lookup) surfaces "Stirling railway station (Scotland)" even though the
// direct-lookup candidate for bare "Stirling railway station" is itself a
// disambiguation page.
// expandedQualifier preferred over the raw NaPTAN qualifier when available
// — confirmed live this matters: searching "Bentley railway station S
// Yorks" did not surface "Bentley railway station (South Yorkshire)" in
// Wikipedia's top results, but "Bentley railway station South Yorkshire"
// (expanded) did.
async function searchFallback(base, qualifier, normalizedBase, station) {
  const expandedQualifier = qualifier && ABBREVIATION_MAP[qualifier];
  const queryQualifier = expandedQualifier || qualifier;
  const query = queryQualifier ? `${base} railway station ${queryQualifier}` : `${base} railway station`;
  const url = `${WIKI_API_ACTION}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=6`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return { results: [], notes: [`search "${query}": HTTP ${res.status}`] };
  const data = await res.json();
  const hits = (data.query && data.query.search) || [];
  const notes = [];
  // Evaluate every hit first, then prefer a "station"-titled passing hit
  // over a same-location-but-not-actually-a-station one, rather than
  // returning the first hit that merely passes title/geo — confirmed live
  // this matters: for Charing Cross (Glasgow), the road-junction article
  // "Charing Cross, Glasgow" sits at THE SAME coordinates as the actual
  // station (it's literally the junction the station is under), so it
  // passes geo verification just as validly as "Charing Cross railway
  // station (Scotland)" does — text/geo alone can't tell them apart when
  // Wikipedia's search happens to rank the non-station article first.
  const passing = [];
  for (const hit of hits) {
    const summary = await fetchSummary(hit.title);
    await sleep(REQUEST_DELAY_MS);
    if (!summary || summary.error || summary.type === 'disambiguation') {
      notes.push(`search hit "${hit.title}": ${!summary ? 'no page' : summary.error || 'disambiguation'}`);
      continue;
    }
    const titleMatch = normalizeForCompare(summary.title) === normalizedBase;
    let geoOk = null;
    if (summary.coordinates && station.lat != null && station.lon != null) {
      const dist = haversineKm(station.lat, station.lon, summary.coordinates.lat, summary.coordinates.lon);
      geoOk = dist <= GEO_REJECT_KM;
    }
    if (titleMatch || geoOk === true) {
      passing.push({ summary, hitTitle: hit.title, confidence: titleMatch && geoOk === true ? 'title+geo' : titleMatch ? 'title' : 'geo' });
      continue;
    }
    notes.push(`search hit "${hit.title}": unverified (no title/geo match)`);
  }
  if (!passing.length) return { results: [], notes };
  const stationTitled = passing.find((p) => /\bstation\b/i.test(p.summary.title));
  const chosen = stationTitled || passing[0];
  if (stationTitled && stationTitled !== passing[0]) {
    notes.push(`preferred "${stationTitled.summary.title}" (station-titled) over earlier-ranked "${passing[0].summary.title}" (same location, not station-titled)`);
  }
  return {
    results: [{ summary: chosen.summary, candidate: `search:"${query}"→"${chosen.hitTitle}"`, confidence: chosen.confidence }],
    notes,
  };
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

// Evaluates one already-fetched summary against a station, for either a
// direct-lookup candidate string or a search-fallback hit. requireGeo=true
// (used only for the last-resort bare-name tier below) means a title-text
// match ALONE is never enough — real geo confirmation is mandatory, since a
// bare unqualified name is the one candidate form most likely to
// text-collide with a same-named but topically unrelated Wikipedia article
// (confirmed live: bare "Bentley" → Bentley Motors; bare "Rye" → the grain).
function evaluateSummary(summary, normalizedBase, station, requireGeo) {
  if (summary.type === 'disambiguation') return { accepted: false, reason: 'disambiguation page, skipped' };
  const titleMatch = normalizeForCompare(summary.title) === normalizedBase;
  let geoOk = null;
  if (summary.coordinates && station.lat != null && station.lon != null) {
    const dist = haversineKm(station.lat, station.lon, summary.coordinates.lat, summary.coordinates.lon);
    geoOk = dist <= GEO_REJECT_KM;
    if (!geoOk) return { accepted: false, reason: `rejected, ${dist.toFixed(1)}km from station` };
  }
  const confirmed = requireGeo ? geoOk === true : titleMatch || geoOk === true;
  if (!confirmed) {
    return {
      accepted: false,
      reason: requireGeo && titleMatch && geoOk == null
        ? 'unverified — bare-name candidate requires geo confirmation, but the matched page has no coordinates to check'
        : 'unverified (no title/geo match)',
      weak: { title: summary.title, extractLength: (summary.extract || '').length, hasCoordinates: !!summary.coordinates },
    };
  }
  return {
    accepted: true,
    confidence: titleMatch && geoOk === true ? 'title+geo' : titleMatch ? 'title' : 'geo',
  };
}

function toMatchResult(summary, candidate, confidence) {
  return {
    status: 'matched',
    matchedTitle: summary.title,
    matchedCandidate: candidate,
    confidence,
    extractLength: (summary.extract || '').length,
    extract: summary.extract || '',
    pageUrl: summary.content_urls?.desktop?.page || null,
    description: summary.description || null,
  };
}

// ─── Phase 1 + 2 combined per station (one fetch pass reused for both) ────
// extraCandidates: appended after the SPECIFIC (non-bare) candidate list —
// used by scripts/rematch-abbreviation-mismatches.mjs to try a NaPTAN-
// abbreviation-expanded qualifier (e.g. "Warks" → "Warwickshire") without
// duplicating this function's matching/scoring logic.
//
// Three passes, most-specific/least-collision-prone first (fixed 2026-07-16
// — see buildCandidates()'s comment for the incident this responds to):
//   1. SPECIFIC candidates (buildCandidates() + extraCandidates) — always
//      contain "station" text or an explicit qualifier, so a same-named
//      unrelated-topic collision is essentially impossible.
//   2. Full-text search fallback (searchFallback()) — catches real, correctly-
//      qualified station articles that direct lookup can't guess the exact
//      title of (confirmed live for e.g. "Bentley railway station (South
//      Yorkshire)", "Stirling railway station (Scotland)").
//   3. Bare, unqualified base name, GEO REQUIRED — the last resort, only
//      ever accepted with real coordinate confirmation, never on text
//      equality alone.
export async function matchStation(station, extraCandidates = []) {
  const { base, qualifier } = splitNaptanName(station.name);
  const specificCandidates = [...buildCandidates(base, qualifier), ...extraCandidates];
  const normalizedBase = normalizeForCompare(base);
  let weakCandidate = null;
  const triedNotes = [];
  const allCandidatesTried = [...specificCandidates];

  for (const candidate of specificCandidates) {
    const summary = await fetchSummary(candidate);
    await sleep(REQUEST_DELAY_MS);
    if (summary === null) { triedNotes.push(`"${candidate}": no page`); continue; }
    if (summary.error) { triedNotes.push(`"${candidate}": ${summary.error}`); continue; }

    const result = evaluateSummary(summary, normalizedBase, station, false);
    if (result.accepted) return toMatchResult(summary, candidate, result.confidence);
    if (result.weak && !weakCandidate) weakCandidate = { candidate, ...result.weak };
    triedNotes.push(`"${candidate}" → "${summary.title || '?'}": ${result.reason}`);
  }

  const searchResult = await searchFallback(base, qualifier, normalizedBase, station);
  triedNotes.push(...searchResult.notes);
  if (searchResult.results.length) {
    const { summary, candidate, confidence } = searchResult.results[0];
    allCandidatesTried.push(candidate);
    return toMatchResult(summary, candidate, confidence);
  }

  for (const candidate of buildLastResortCandidates(base, qualifier)) {
    allCandidatesTried.push(candidate);
    const summary = await fetchSummary(candidate);
    await sleep(REQUEST_DELAY_MS);
    if (summary === null) { triedNotes.push(`"${candidate}" (bare): no page`); continue; }
    if (summary.error) { triedNotes.push(`"${candidate}" (bare): ${summary.error}`); continue; }

    const result = evaluateSummary(summary, normalizedBase, station, true);
    if (result.accepted) return toMatchResult(summary, candidate, result.confidence);
    if (result.weak && !weakCandidate) weakCandidate = { candidate, ...result.weak };
    triedNotes.push(`"${candidate}" (bare) → "${summary.title || '?'}": ${result.reason}`);
  }

  return {
    status: 'needs-review',
    reason: weakCandidate
      ? `Found a page ("${weakCandidate.title}") but couldn't confirm it's the right one — title doesn't match and ${weakCandidate.hasCoordinates ? 'coordinates were too far' : 'no coordinates to check'}.`
      : `No Wikipedia page found for any candidate title.`,
    weakCandidate,
    candidatesTried: allCandidatesTried,
    notes: triedNotes,
  };
}

// ─── geo-match-town-article detection (2026-07-16) ────────────────────────
// A "geo" (not "title") confidence match means the candidate title didn't
// textually resolve to the station name — the ONLY reason it was accepted
// is that its coordinates happened to be within GEO_REJECT_KM. Confirmed
// live via the Phase 2 preview sample: this can land on the TOWN/VILLAGE
// article the station sits in (e.g. "Armadale, West Lothian" — a real,
// substantial article, but about the town, not a dedicated station page)
// rather than any station-specific article. Wikipedia's own REST summary
// `description` field reliably says so in these cases ("Town in West
// Lothian, Scotland") — a real station article's description instead reads
// like "National Rail station in London, England". Only relevant to
// geo-confidence matches: a title-match already proves textual identity
// with the station name, so a settlement-shaped description there would be
// a coincidence, not evidence of a wrong page.
const SETTLEMENT_DESCRIPTION_PATTERN = /^(Town|City|Village|Suburb|Hamlet|Civil parish)\b/i;
export function isGeoMatchTownArticle(matchResult) {
  return (
    matchResult.status === 'matched' &&
    matchResult.confidence === 'geo' &&
    SETTLEMENT_DESCRIPTION_PATTERN.test(matchResult.description || '')
  );
}

export function classifyTier(matchResult) {
  if (matchResult.status !== 'matched') return 'no-article';
  if (isGeoMatchTownArticle(matchResult)) return 'geo-match-town-article';
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
  const tiers = { 'no-article': [], stub: [], substantive: [], 'geo-match-town-article': [] };
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
      'geo-match-town-article': tiers['geo-match-town-article'].length,
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
- geo-match-town-article (geo-confidence match landed on a town/place article, not a dedicated station article — see Step 2 handling notes): ${report.tierCounts['geo-match-town-article']}

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

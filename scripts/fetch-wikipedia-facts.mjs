#!/usr/bin/env node
/**
 * scripts/fetch-wikipedia-facts.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates the NARRATIVE/HISTORICAL fields in stations-content.json,
 * routes-content.json, and operators-content.json from Wikipedia — fetched
 * via Wikipedia's own REST/action API, then EXTRACTED (not generated from
 * memory) into the target schema by Claude. Run manually/periodically:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/fetch-wikipedia-facts.mjs
 *
 * There is no live production dependency on this script, Wikipedia, or the
 * Claude API — it only ever writes static JSON that the app reads at
 * request time.
 *
 * wikipedia_title: originally required to already be set by hand on every
 * entry (a missing title just meant "skip, curation gap"). As of 2026-07-13
 * this script will now ALSO resolve it itself when missing — see
 * resolveWikipediaTitle() below — but only when it can *verify* a real,
 * matching Wikipedia page exists (direct page lookup, or an exact-
 * normalized full-text search match); anything looser is left alone and
 * flagged for manual review, same discipline as fetch-osm-facts.mjs's
 * "ambiguous → flag, don't guess" handling of OSM route relations. An
 * already-set wikipedia_title (however it got there) is always respected
 * as-is and never re-resolved.
 *
 * ─── FIELD OWNERSHIP (read this before editing another script) ───────────
 * This script is the ONLY writer for:
 *   stations-content.json  →  headline, opened_year, notable_features
 *   routes-content.json    →  headline, opened_year, operating_since
 *   operators-content.json →  headline, parent_company, franchises,
 *                              regions_served, notable_features
 *   all three               →  wikipedia_title (ONLY when auto-resolved
 *                               with confidence — see above; a human-set
 *                               title is untouched, never overwritten)
 * headline replaced the old full-paragraph "synopsis" field — same
 * extraction discipline (grounded in the fetched article, never invented),
 * just an 8–12 word punchy sentence instead of a paragraph, matching the
 * style/length of the existing locomotive spotlight's `headline` field
 * (see api/spotlight.js's prompt). Shorter output = fewer tokens per
 * entity too. schema_jsonld is a separate field owned by
 * scripts/build-schema-jsonld.mjs — see that script's header — which reads
 * (not writes) the fields both this script and fetch-osm-facts.mjs produce.
 * It never writes: platforms, wheelchair, operators (stations), length_km,
 * stopping_stations, type, operator (routes), stations_operated,
 * fleet_classes (operators), name, photo, location,
 * listed_status, or any existence/status field — those belong to
 * scripts/fetch-osm-facts.mjs (structured/physical), scripts/compute-
 * operator-stats.mjs (stations_operated — a plain derived count, no API
 * calls), manual curation, or the separate NaPTAN re-import pipeline. See
 * those scripts' headers for their owned-fields lists.
 *
 * Each run does a shallow merge: only the fields this script owns are ever
 * assigned, and ONLY when Claude actually found the fact on the page — a
 * field the source page doesn't cover is left null/absent, never guessed,
 * and never overwrites an existing curated value with a blank. This is
 * what makes it safe to run both scripts in either order, repeatedly.
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILES = {
  stations: path.join(ROOT, 'stations-content.json'),
  routes: path.join(ROOT, 'routes-content.json'),
  operators: path.join(ROOT, 'operators-content.json'),
};

// ─── Jobs to run this pass — edit this, then re-run ──────────────────────
// Every key here must already exist (or be about to be created) in the
// matching -content.json file, with at least a `name`. wikipedia_title is
// no longer required up front — if missing, resolveWikipediaTitle() tries
// to confidently resolve one first; if it can't, the entry is left as-is
// (existing "content coming soon" fallback) and reported under "needs your
// manual review" at the end of the run, it is never guessed at.
// ONLY_KIND env var (optional): restricts a run to a single JOBS category
// ('stations' | 'routes' | 'operators') without needing to blank out the
// other two arrays first — added 2026-07-16 for the stations tiered
// rollout below, which needed to run only JOBS.stations without disturbing
// the already-configured JOBS.operators backlog. e.g.:
//   ONLY_KIND=stations node scripts/fetch-wikipedia-facts.mjs
const ONLY_KIND = process.env.ONLY_KIND;

// Fields safe to request on their own for a station that's ALREADY been
// through a full extraction pass (has notable_features) — declared up here
// (not down by STATION_FIELD_SPECS, which needs the rest of the schema
// machinery already in scope) purely so loadStationsRolloutJob() below can
// reference it — plain module-scope `const` isn't hoisted, so this has to
// exist before that function runs at JOBS-init time. See
// STATION_INCREMENTAL_FIELDS's full comment further down, where
// STATION_FIELD_SPECS itself is defined, for the actual field specs.
const STATION_INCREMENTAL_FIELDS = ['managed_by', 'location'];

// Which STATION_INCREMENTAL_FIELDS keys a station still genuinely needs —
// NOT simply `!(f in existing)`. Bug found live 2026-07-17: mergeWikipediaFields()
// only ever writes a key when Claude returned a non-empty value for it
// (isEmptyExtractedValue filtering), so a field the source article legitimately
// doesn't state (e.g. no "managed by" sentence at all) never gets written —
// meaning "key absent" is ambiguous between "never asked" and "asked, source
// had nothing." Without tracking which fields were actually REQUESTED,
// every re-run would re-query Claude for the same confirmed-empty field on
// every station, forever (confirmed live: 177 of the first 446 successful
// stations in the initial managed_by/location run got only one of the two
// fields written, since the other came back null — without this fix, a
// second run's job list ballooned to 310 stations instead of the ~64 that
// genuinely still needed something). _wikipedia.incrementalFieldsAttempted
// (written below, in processEntry()) is the record of "already asked, don't
// ask again" — a field only counts as still-needed if it's neither present
// on the entry NOR already recorded as attempted.
function stationMissingIncrementalFields(existing) {
  const attempted = (existing && existing._wikipedia && existing._wikipedia.incrementalFieldsAttempted) || [];
  return STATION_INCREMENTAL_FIELDS.filter((f) => !(f in existing) && !attempted.includes(f));
}

// 2026-07-16 tiered content rollout, extended 2026-07-17 for incremental
// fields: every substantive-tier + geo-match-town-article station from
// scripts/output/wikipedia-coverage-report.json's tierCrsLists, MINUS any
// CRS that's both (a) already fully populated (has notable_features) AND
// (b) not missing any STATION_INCREMENTAL_FIELDS key either — i.e. this
// still includes a station that needs its first full extraction pass, AND
// a station that's already complete except for a newly-added field like
// managed_by/location, but skips one that's genuinely done with nothing
// left to add (BHM, from an earlier pass, when this JOB list doesn't need
// to touch it at all — re-running it would waste a call on a no-op).
// Loaded programmatically from the report file, rather than hand-copied
// into a literal array, specifically so this list is guaranteed to match
// the report exactly (~478 entries — too large and error-prone to
// transcribe by hand without risking a silent mismatch). wikipedia_title
// was pre-seeded on each of these directly in stations-content.json from
// the coverage report's already-verified matchedTitle (see scripts/scope-
// wikipedia-coverage.mjs's Phase 1 matching — title/geo confirmed, or
// NO_DEEP_LINK_KEYS-flagged town-article matches, see below) rather than
// re-resolved here — this script's own resolveWikipediaTitle() only does
// title-text matching, not the coordinate-based matching that found the 6
// NO_DEEP_LINK_KEYS entries, so letting it re-resolve those from scratch
// here would likely fail them.
function loadStationsRolloutJob() {
  const reportPath = path.join(ROOT, 'scripts', 'output', 'wikipedia-coverage-report.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const stationsContent = JSON.parse(readFileSync(FILES.stations, 'utf8'));
  const tierTarget = [...report.tierCrsLists.substantive, ...report.tierCrsLists['geo-match-town-article']];
  // ALSO include any station with genuine extracted Wikipedia content
  // (notable_features or headline) even if it's not in the current tier
  // lists above — confirmed live 2026-07-17: report.json's tierCrsLists can
  // drift stale relative to stations-content.json's real state (10
  // stations — e.g. Stirling, Armadale — got reclassified from substantive
  // to stub tier by the 2026-07-16 matching-bug fix, since their real
  // dedicated article turned out shorter than the ones wrongly matched
  // before, but they still have a real wikipedia_title and real extracted
  // content sitting in stations-content.json). Without this, those 10 would
  // silently never receive incremental fields like managed_by/location,
  // despite genuinely having a dedicated infobox to extract them from.
  const alreadyExtracted = Object.keys(stationsContent).filter((crs) => {
    const e = stationsContent[crs];
    return e && ((e.notable_features && e.notable_features.length) || e.headline);
  });
  const target = [...new Set([...tierTarget, ...alreadyExtracted])];
  return target.filter((crs) => {
    const existing = stationsContent[crs];
    if (!existing || !existing.notable_features || !existing.notable_features.length) return true; // needs a first full pass
    return stationMissingIncrementalFields(existing).length > 0; // needs incremental fields only
  });
}

const JOBS = {
  stations: loadStationsRolloutJob(),
  routes: [],
  // 2026-07-14 UI/content pass (mockup-routes.png): re-running every
  // operator to backfill the new regions_served/notable_features fields
  // (see EXTRACTION_SCHEMAS.operators) — a re-run is safe/idempotent per
  // this script's shallow-merge discipline, and ES (Eurostar) still has no
  // wikipedia_title set, so this also exercises the auto-resolve path for it
  // (bare "Eurostar" verified live beforehand as a clean, non-ambiguous
  // direct match).
  operators: ['WMR', 'VT', 'GR', 'XC', 'EM', 'LN', 'GW', 'SW', 'SE', 'SN', 'TL', 'GX', 'GN', 'CC', 'CH', 'LE', 'NT', 'TP', 'ME', 'SR', 'CS', 'GC', 'HT', 'LD', 'HX', 'XR', 'AW', 'IL', 'WR', 'ES'],
};

// 2026-07-16: geo-confidence matches whose article is about the town/
// village the station sits in, not a dedicated station page (see
// scripts/output/wikipedia-coverage-report.json's geoMatchTownArticleDetail
// for the full reasoning/list). Kept as an EMPTY set as of the same day's
// follow-up investigation — every one of the original 6 (ADL, ARM, BIB,
// BMY, SNN, WCH) turned out to have a real, dedicated station article
// after all (hiding behind a disambiguation page or a qualifier the
// original candidate list never tried, e.g. "Armadale railway station
// (Scotland)"), confirmed via manual full-text-search verification and
// re-matched — so none needed this suppression in the end. Left in place
// (empty) rather than deleted, since a genuine geo-match-town-article case
// may turn up on a future full 2,637 re-run once matchStation() gains the
// full-text-search fallback described in its own comment block below —
// this is still the mechanism that would handle it when one does.
const NO_DEEP_LINK_KEYS = new Set([]);

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

async function fetchWikipediaText(title) {
  // pageprops added 2026-07-13, alongside the disambiguation check in
  // resolveWikipediaTitle() below — confirmed live that a short/generic
  // operator name (e.g. "Northern", "Great Northern", "Lumo") can redirect
  // straight to Wikipedia's disambiguation page for that word, which
  // fetchWikipediaText will happily "find" (it's a real, non-missing page)
  // without pageprops ever being asked to say so.
  const url = `${WIKI_API}?action=query&prop=extracts|info|pageprops&explaintext=1&redirects=1&inprop=url&ppprop=disambiguation&titles=${encodeURIComponent(title)}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  const data = await res.json();
  const pages = data.query && data.query.pages;
  const page = pages && Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  const isDisambiguation = !!(page.pageprops && 'disambiguation' in page.pageprops);
  return { title: page.title, url: page.fullurl, text: page.extract || '', isDisambiguation };
}

// ─── wikipedia_title resolution (2026-07-13) ──────────────────────────────
// Same normalization approach as fetch-osm-facts.mjs's normalizeStationName
// (strip parentheticals/"railway station"/punctuation, lowercase) — kept as
// its own copy here rather than a shared import since the two scripts are
// each meant to be run standalone with no cross-file dependency.
function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\brail(?:way)? station\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TITLE_CANDIDATE_PATTERNS = {
  stations: (name) => [`${name} railway station`, `${name} station`, name],
  routes: (name) => [name, `${name} (railway)`, `${name} (line)`],
  // Bare name first (correct for most: "Avanti West Coast", "LNER", ...),
  // "(train operating company)" as a fallback for short/generic names that
  // collide with a Wikipedia disambiguation page — confirmed live for
  // "Northern", "Great Northern", "Lumo" (all disambiguation pages under
  // the bare name; Lumo's disambiguation page even lists "Lumo (train
  // operating company)" as the real target).
  operators: (name) => [name, `${name} (train operating company)`],
};

// Two-pass resolution, cheapest/most-reliable first:
//  1. Direct page lookup per candidate title — Wikipedia's own redirect
//     handling (fetchWikipediaText already sets redirects=1) means this
//     also catches near-miss capitalization/phrasing for free. A hit here
//     is as trustworthy as a human having typed the title themselves,
//     UNLESS it's a disambiguation page (e.g. bare "Northern") — that's not
//     a resolution at all, so it's skipped in favor of the next candidate
//     rather than accepted.
//  2. Full-text search, but ONLY auto-accepted if the top hit's normalized
//     title exactly matches the entity's normalized name — anything looser
//     (a different-but-similar station, a disambiguation page, etc.) is a
//     genuine ambiguity, not a confident resolution, so it's flagged for
//     manual review instead of guessed at.
async function resolveWikipediaTitle(kind, name) {
  const candidates = TITLE_CANDIDATE_PATTERNS[kind](name);
  const normalizedName = normalizeTitle(name);

  for (const candidate of candidates) {
    const page = await fetchWikipediaText(candidate);
    await sleep(300);
    if (page && !page.isDisambiguation) return { title: page.title, method: `direct:"${candidate}"` };
  }

  const searchUrl = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(candidates[0])}&format=json&srlimit=5`;
  const res = await fetch(searchUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return { ambiguous: true, notes: `Wikipedia search HTTP ${res.status}` };
  const data = await res.json();
  const results = (data.query && data.query.search) || [];
  if (!results.length) {
    return { ambiguous: true, notes: `No Wikipedia page found for "${name}" — tried: ${candidates.join(', ')}` };
  }
  const strongMatch = results.find((r) => normalizeTitle(r.title) === normalizedName);
  if (strongMatch) {
    const page = await fetchWikipediaText(strongMatch.title);
    if (page && !page.isDisambiguation) return { title: page.title, method: 'search-exact' };
  }
  return {
    ambiguous: true,
    notes: `No confident Wikipedia title match for "${name}" — top search results: ${results.map((r) => r.title).join(', ')}`,
  };
}

// headline: one punchy news-style sentence, 8–12 words — same brief given
// to api/spotlight.js's locomotive headlines, for a consistent voice across
// the site. Still extraction, not invention: it must be grounded in a fact
// the article actually states, just compressed to headline length instead
// of a full paragraph.
const HEADLINE_SPEC = 'headline (a punchy ONE-SENTENCE headline, 8-12 words, news-headline style and tone — e.g. "Britain\'s busiest station outside London, rebuilt three times since 1854" — grounded in a specific fact the article states, not a generic description)';

// Per-field specs for stations (2026-07-17: split out of one flat string so
// an incremental run — see STATION_INCREMENTAL_FIELDS below — can compose a
// prompt asking for just the newly-added fields on a station that already
// has headline/opened_year/notable_features, instead of re-extracting
// everything and re-spending Claude tokens on facts already captured.
const STATION_FIELD_SPECS = {
  headline: HEADLINE_SPEC,
  opened_year: 'opened_year (the year the CURRENT/notable station building or service first opened — a string, e.g. "1854" or "1967 (rebuilt)")',
  notable_features: 'notable_features (array of short phrase strings — architectural, historical, or record-holding facts, e.g. "Britain\'s busiest station outside London")',
  // managed_by/location added 2026-07-17 — both come from the Wikipedia UK
  // station infobox's top section (confirmed live across the standard,
  // London-specific, and Scotland-qualified "Infobox station" template
  // variants: "Managed by" and "Location" are the actual rendered row
  // labels in all three, backed by a `manager=`/infobox-location wikitext
  // field respectively), and both are also typically restated in plain
  // prose (e.g. "...is managed by Network Rail"), so they're reliably
  // extractable from the plain-text article body this script already
  // fetches — no infobox-wikitext fetching needed for these two.
  managed_by: 'managed_by (string — the organisation that manages/operates the STATION ITSELF, distinct from the train operating companies whose SERVICES call there — e.g. a station\'s "managed_by" might be "Network Rail" or "ScotRail" even when several different companies\' trains stop there. The article usually states this plainly, e.g. "...is managed by Network Rail" — extract that organisation\'s name; null if not stated)',
  location: 'location (string — the station\'s location as Wikipedia\'s infobox states it at the top, under "Location" — usually a place/borough/county description, e.g. "Redcliffe, Bristol, England" or just "Victoria" or "Stirling, Stirling, Scotland" — occasionally a full street address with postcode if the article states one, e.g. "302 Elder Gate, Milton Keynes, MK9 1LA". Extract whatever level of detail the article actually gives, do not pad it out; null if not stated)',
};
// STATION_INCREMENTAL_FIELDS itself is declared earlier in the file (near
// loadStationsRolloutJob(), which needs it before this point) — this is
// just the "add a new field? update that array too" reminder living next
// to STATION_FIELD_SPECS, where it's most likely to be seen.

const EXTRACTION_SCHEMAS = {
  stations: {
    fields: Object.values(STATION_FIELD_SPECS).join(', '),
  },
  routes: {
    fields: `${HEADLINE_SPEC}, opened_year (year the line first opened, string), operating_since (year the CURRENT operator/franchise began running it, string — distinct from opened_year, which is about the line\'s original construction)`,
  },
  operators: {
    fields: `${HEADLINE_SPEC}, parent_company (string, the ultimate/immediate parent company name, or null if independent/not stated), franchises (array of {name, start, end} — end is null for the current/ongoing franchise; only include entries the article actually states dates for), regions_served (an object {main: [...], other: [...]} of short NAMED GEOGRAPHIC REGIONS/COUNTIES/METRO AREAS ONLY — e.g. "Greater London", "South East England", "South Wales", "the East Midlands", "Merseyside". Each entry must be a proper region/county/city name, 1-4 words. Do NOT put route descriptions, line names, individual station names, or full sentences in this field — e.g. "West Coast Main Line between London and the Northwest" or "Hull Paragon to London King's Cross" are NOT valid entries, skip them instead of forcing them into a region name. main is the primary region(s) this operator serves; other is any region(s) the article describes as secondary/limited/peripheral. If the article only describes coverage via routes/stations and never names actual regions this way, set regions_served to null entirely rather than stretching a route description into a fake region name), notable_features (array of short phrase strings — genuinely distinguishing facts about this operator specifically: firsts, record-holding, notable technology/rolling stock, structural facts; NOT generic filler like "provides train services in England" — same standard as station-level notable_features)`,
  },
};

function buildPrompt(kind, name, text, fieldsOverride) {
  const fields = fieldsOverride || EXTRACTION_SCHEMAS[kind].fields;
  return `You are extracting facts from a Wikipedia article for a UK rail information site. EXTRACT only — do not invent, infer, or use outside knowledge. If the article does not clearly state a fact, set that field to null (or an empty array for list fields) rather than guessing.

Subject: ${name}
Fields to extract: ${fields}

Respond with ONLY a single JSON object with exactly those field names as keys — no markdown fences, no commentary.

Article text:
"""
${text.slice(0, 60000)}
"""`;
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot run the extraction step. Set it and re-run.');
  }
  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      // 2026-07-13: was 1024 — claude-sonnet-5 uses extended thinking by
      // default, drawn from the same max_tokens budget as the actual answer.
      // Confirmed live (Thameslink/Gatwick Express/Chiltern Railways all
      // failed a 24-operator run): thinking alone sometimes used the entire
      // 1024-token budget before any text block was emitted, leaving nothing
      // for callClaude's caller to parse. 4096 leaves comfortable headroom
      // for both, for an output this small (a few extracted fields).
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data.content.map((b) => b.text || '').join('');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude response wasn't parseable JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(jsonMatch[0]);
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// Recurses into plain objects (e.g. regions_served's {main, other} shape) so
// a nested-empty result like {main: [], other: []} counts as empty too —
// confirmed live: without this, regions_served landed on 6/30 operators as
// dead {main:[],other:[]} noise instead of being omitted like every other
// empty field already correctly is.
function isEmptyExtractedValue(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v).every(isEmptyExtractedValue);
  return false;
}
// Only assigns fields Claude actually returned a non-null/non-empty value
// for — never blanks out an existing curated value, and never writes a
// field outside this script's ownership list (enforced by only ever
// spreading `extracted`, which itself only ever contains the schema's own
// keys, per buildPrompt()'s explicit field list).
function mergeWikipediaFields(entry, extracted) {
  const out = { ...(entry || {}) };
  for (const [k, v] of Object.entries(extracted)) {
    if (!isEmptyExtractedValue(v)) out[k] = v;
  }
  return out;
}

async function processEntry(kind, key, content, report) {
  const entry = content[key];
  let title = entry && entry.wikipedia_title;
  let resolvedTitle = null; // only set when THIS run auto-resolved it, for the report/log line below

  if (!title) {
    const resolution = await resolveWikipediaTitle(kind, (entry && entry.name) || key);
    if (resolution.ambiguous) {
      console.log(`  ${key}: no wikipedia_title set, and couldn't confidently resolve one — ${resolution.notes}`);
      report.push({ key, status: 'needs-review', notes: resolution.notes });
      return;
    }
    title = resolution.title;
    resolvedTitle = { title, method: resolution.method };
  }

  const page = await fetchWikipediaText(title);
  if (!page || !page.text) {
    console.log(`  ${key}: wikipedia_title "${title}" did not resolve to a page — skipped, no error thrown`);
    report.push({ key, status: 'title-not-found', notes: `"${title}" did not resolve to a page` });
    return;
  }
  const name = (entry && entry.name) || key;
  // Incremental mode (2026-07-17): a station that's already been through a
  // full extraction pass (has notable_features) only gets asked for
  // whichever STATION_INCREMENTAL_FIELDS keys it's still missing — e.g.
  // adding managed_by/location to the schema shouldn't mean re-spending
  // Claude tokens re-generating headline/opened_year/notable_features for
  // 478 already-complete stations. The article is still re-fetched (a free
  // Wikipedia API call, not cached from the original run) since the text
  // itself was never persisted to disk. Only applies to kind==='stations' —
  // routes/operators don't have this incremental-fields concept yet.
  let fieldsOverride;
  // requestedIncrementalFields: which STATION_INCREMENTAL_FIELDS keys THIS
  // call is asking about, regardless of path — defaults to "all of them"
  // for a first-time full pass (they're part of the full field list too),
  // narrowed to just `missing` for an incremental-only pass. Recorded into
  // _wikipedia.incrementalFieldsAttempted below either way, so a field
  // Claude legitimately returns null for (source doesn't state it) is
  // remembered as "asked, empty" rather than indistinguishable from "never
  // asked" — see stationMissingIncrementalFields()'s comment for the bug
  // this fixes.
  let requestedIncrementalFields = kind === 'stations' ? STATION_INCREMENTAL_FIELDS : [];
  if (kind === 'stations' && entry && entry.notable_features && entry.notable_features.length) {
    const missing = stationMissingIncrementalFields(entry);
    if (!missing.length) {
      console.log(`  ${key}: already fully populated, nothing incremental to add — skipped`);
      report.push({ key, status: 'ok', resolvedTitle: null });
      return;
    }
    fieldsOverride = missing.map((f) => STATION_FIELD_SPECS[f]).join(', ');
    requestedIncrementalFields = missing;
  }
  const prompt = buildPrompt(kind, name, page.text, fieldsOverride);
  const extracted = await callClaude(prompt);
  const gotNothing = Object.values(extracted).every((v) => v == null || (Array.isArray(v) && v.length === 0));

  // A page that yields NOTHING right after an auto-resolved title is a real
  // signal, not just a sparse article — confirmed live: "Southeastern" (bare
  // name) direct-lookup-redirected to Wikipedia's "Points of the compass"
  // (a generic geography article, not the train operator), and the tell was
  // exactly this — zero extractable facts. A human-set wikipedia_title
  // yielding nothing is just a sparse source page and is trusted as-is; an
  // auto-resolved one yielding nothing is treated as unverified and flagged
  // instead of silently persisting a possibly-wrong title/URL.
  if (resolvedTitle && gotNothing) {
    const notes = `Auto-resolved wikipedia_title "${resolvedTitle.title}" (via ${resolvedTitle.method}) produced zero extractable facts — likely resolved to the wrong page (e.g. a generic/disambiguation article). Not persisted; needs a human to set the correct wikipedia_title.`;
    console.log(`  ${key}: ${notes}`);
    report.push({ key, status: 'needs-review', notes });
    return;
  }

  content[key] = mergeWikipediaFields(entry, extracted);
  if (resolvedTitle) content[key].wikipedia_title = resolvedTitle.title; // only field this script writes outside mergeWikipediaFields's schema — see header comment
  const priorAttempted = (entry && entry._wikipedia && entry._wikipedia.incrementalFieldsAttempted) || [];
  content[key]._wikipedia = {
    fetched_at: new Date().toISOString(),
    title: page.title,
    url: page.url,
    license: 'CC BY-SA 4.0',
  };
  if (kind === 'stations' && requestedIncrementalFields.length) {
    content[key]._wikipedia.incrementalFieldsAttempted = [...new Set([...priorAttempted, ...requestedIncrementalFields])];
  }
  let noDeepLinkNote = '';
  if (kind === 'stations' && NO_DEEP_LINK_KEYS.has(key)) {
    delete content[key].wikipedia_title; // matched article is about the settlement, not a dedicated station page — see NO_DEEP_LINK_KEYS comment above
    content[key]._wikipedia.sourceType = 'settlement-article';
    noDeepLinkNote = ' [NO_DEEP_LINK_KEYS: wikipedia_title withheld, sourceType=settlement-article]';
  }
  const extractedFields = Object.keys(extracted).filter((k) => extracted[k] != null && !(Array.isArray(extracted[k]) && !extracted[k].length)).join(', ') || '(nothing — article had none of the requested facts)';
  console.log(`  ${key}: extracted ${extractedFields}${resolvedTitle ? ` (wikipedia_title auto-resolved via ${resolvedTitle.method}: "${resolvedTitle.title}")` : ''}${noDeepLinkNote}`);
  report.push({ key, status: 'ok', resolvedTitle: resolvedTitle ? resolvedTitle.title : null });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const needsReview = [];
  for (const kind of ['stations', 'routes', 'operators']) {
    if (ONLY_KIND && kind !== ONLY_KIND) continue; // bug fix 2026-07-16: ONLY_KIND was declared but never actually checked here — a stations-only run also burned through the entire JOBS.operators backlog (harmless in that case since it was legitimate pre-existing queued work, but not what was intended, and it's what ran the account's API credits down mid-run)
    const filePath = FILES[kind];
    const content = loadJson(filePath);
    console.log(`\n── ${kind} ──`);
    const report = [];
    for (const key of JOBS[kind]) {
      try {
        await processEntry(kind, key, content, report);
      } catch (err) {
        console.error(`  ${key}: FAILED — ${err.message} (left untouched, no partial write)`);
        report.push({ key, status: 'failed', notes: err.message });
      }
      saveJson(filePath, content); // incremental save — see fetch-osm-facts.mjs's main() for why this matters on a long run
      await sleep(500); // light pacing — Wikipedia + Claude both have their own rate limits
    }
    needsReview.push(...report.filter((r) => r.status !== 'ok').map((r) => ({ kind, ...r })));
  }

  if (needsReview.length) {
    console.log('\n=== Needs your manual review (title could not be confidently auto-resolved) ===');
    for (const r of needsReview) console.log(`${r.kind}/${r.key} [${r.status}]: ${r.notes}`);
  }
}

// Guard added 2026-07-16 after a live incident: a plain `import()` of this
// module (e.g. to inspect JOBS or test a syntax change) executed main() as
// a side effect, since top-level code had no such guard — it started
// resolving/writing real stations before pre-seeded wikipedia_title values
// were in place, producing several wrong-page writes (caught and reverted
// via git checkout). Mirrors the same guard already in
// scripts/scope-wikipedia-coverage.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

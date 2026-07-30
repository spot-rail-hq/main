#!/usr/bin/env node
/**
 * scripts/fetch-heritage-wikidata.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Resolves each of the 175 curated heritage railways (HERITAGE_META) to an
 * English Wikipedia article and its connected Wikidata item, then reads:
 *   - official website          (Wikidata P856)
 *   - enwiki sitelink           (Wikidata sitelinks.enwiki)
 *   - one-line description      (Wikidata descriptions.en, with P31
 *                                instance-of labels as the structured
 *                                fallback/cross-check)
 *   - coordinate location       (P625 — used only as a geo-gate fallback
 *                                when the REST summary carries no coords)
 * plus the REST summary's own first paragraph, which the intro-text drafting
 * step reads as grounding (it is NOT itself the intro text).
 *
 * REPORT PASS ONLY. Writes exclusively to scripts/output/heritage-wikidata-*.
 * It does NOT write operators-content.json, data/heritage-railways.json, or
 * any other content file, and never touches map.html.
 *
 * ─── Why the matching approach is assembled from two existing scripts ─────
 * Neither existing matcher is usable as-is on heritage railways, so this
 * reuses the parts that transfer and refuses the parts that don't:
 *
 *  - fetch-official-websites.mjs is the SOLE existing route to P856, and its
 *    QID hop (Wikipedia title -> pageprops.wikibase_item -> P856, preferring
 *    a `preferred`-rank claim) is reused verbatim below. But it only ever
 *    reads an entry that ALREADY has wikipedia_title and explicitly "never
 *    guesses one" — and no heritage railway has a wikipedia_title anywhere:
 *    HERITAGE_META carries only slug/type/secondary/band/km/prose_name. So
 *    the title
 *    still has to be resolved first, which that script deliberately won't do.
 *
 *  - scope-wikipedia-coverage.mjs's matchStation() resolves titles, but is
 *    station-shaped: buildCandidates() appends "railway station" to the name,
 *    which for a heritage railway yields "Bluebell Railway railway station".
 *    Its VERIFICATION half is exactly what's needed though, and is reused
 *    directly — the disambiguation rejection, normalizeForCompare() title
 *    equality, and the imported haversineKm()/GEO_REJECT_KM 20km coordinate
 *    gate, including the rule that coordinates present but too far REJECT a
 *    candidate outright rather than downgrading it.
 *
 *  - fetch-wikipedia-facts.mjs's resolveWikipediaTitle() is the named-entity
 *    resolver (operators/routes, not stations) and is the closest structural
 *    fit, so its shape is what's followed here: ordered direct-lookup
 *    candidates, then a full-text search fallback auto-accepted only on an
 *    exact normalized-title match. A `heritage` candidate pattern is added in
 *    the same spirit as its existing stations/routes/operators patterns.
 *
 * ─── Candidate tiers, most-specific first ────────────────────────────────
 *   1. NAME candidates — prose_name first when the row has one, then the
 *      curated key, each bare (correct for most heritage articles: "Bluebell
 *      Railway", "Corris Railway") then with "(heritage railway)" and
 *      "(railway)" qualifiers. A title hit on EITHER name is a real match.
 *   2. Full-text search fallback — accepted on exact normalized-title match
 *      or on geo confirmation.
 *   3. Curated ALIASES from HERITAGE_CANONICAL, GEO REQUIRED — never accepted
 *      on title text alone. This tier is geo-gated because the alias table is
 *      an OSM-tag canonicalisation map, not a synonym list, and it contains at
 *      least one alias that points at a DIFFERENT railway's article: the raw
 *      string "Ffestiniog Railway" canonicalises to "Welsh Highland Railway"
 *      (the FR company operates the WHR, so that is how OSM tags it), while
 *      "Ffestiniog Railway" is also its own separate HERITAGE_META row. Fed
 *      to Wikipedia untiered, that alias would attach the Ffestiniog
 *      Railway's website to the Welsh Highland Railway. Requiring
 *      coordinates on this tier is what stops it.
 *
 * ─── What gets FLAGGED rather than written ───────────────────────────────
 * A flagged railway still appears in the report with whatever was found; the
 * point is that its link is not safe to ship unreviewed.
 *   geo-rejected          a real page was found but its coordinates are
 *                         further away than geoRejectKmFor() allows — the
 *                         wrong-entity signal this gate exists for (a
 *                         same-named historic pre-grouping company, or a
 *                         similarly-named line elsewhere)
 *   geo-unconfirmed       accepted on title text alone; we hold coordinates
 *                         for the railway but neither the article nor P625
 *                         offers any to check against
 *   no-center             the 8 railways with no `center` in
 *                         heritage-railways.json — no geo gate available at
 *                         all, so a title match cannot be corroborated
 *   historic-company      the Wikidata description describes a FORMER railway
 *                         (past-tense wording or a historical date range)
 *                         rather than a heritage operation — the exact
 *                         revival-vs-original-company collision
 *   wrong-entity-class    the description's SUBJECT is not a railway at all
 *                         but the town, the National Rail station, or the
 *                         landform at the same coordinates. The geo gate is
 *                         structurally blind to this class — all three sit at
 *                         the railway's own location — so the description is
 *                         the only thing that separates them.
 *   geo-only-title-differs  accepted on coordinates alone; the article title
 *                         is not the railway's name. Often a legitimately
 *                         renamed or parent entity, sometimes a neighbour
 *                         sharing the site — review, not rejection.
 *   disambiguation        every candidate landed on a disambiguation page
 *
 * Run:
 *   node scripts/fetch-heritage-wikidata.mjs
 *
 * Resumable: checkpoints to scripts/output/heritage-wikidata-checkpoint.json
 * every CHECKPOINT_EVERY railways; a re-run skips slugs already present.
 * Delete that file to start clean.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HERITAGE_META, HERITAGE_CANONICAL } from './lib/heritage-canonical.mjs';
import {
  GEO_REJECT_KM,
  haversineKm,
  normalizeForCompare,
} from './scope-wikipedia-coverage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'scripts', 'output');
const HERITAGE_CLIENT_PATH = path.join(ROOT, 'data', 'heritage-railways.json');
const CHECKPOINT_PATH = path.join(OUTPUT_DIR, 'heritage-wikidata-checkpoint.json');
const REPORT_JSON_PATH = path.join(OUTPUT_DIR, 'heritage-wikidata-report.json');
const REPORT_MD_PATH = path.join(OUTPUT_DIR, 'heritage-wikidata-report.md');

const REST_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT =
  'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';
const REQUEST_DELAY_MS = 200;
const MAX_RETRIES = 4;
const CHECKPOINT_EVERY = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// ─── candidate construction ────────────────────────────────────────────────
// Mirrors fetch-wikipedia-facts.mjs's TITLE_CANDIDATE_PATTERNS, adding the
// `heritage` kind it has no entry for.
// prose_name goes FIRST when present. It is the recognisable public name, so it
// is far likelier to be the actual article title than the legal entity in the
// curated key — "Kidderminster Railway Museum" resolves where "The Kidderminster
// Railway Museum Trust Limited" cannot.
function buildHeritageCandidates(names) {
  const out = [];
  for (const n of names) out.push(n, `${n} (heritage railway)`, `${n} (railway)`);
  return [...new Set(out)];
}

// normalizeForCompare() STRIPS parentheticals — correct for its own job
// (a NaPTAN qualifier is not part of a station's article title), actively
// dangerous here. Three curated names carry a parenthetical that is the ONLY
// thing distinguishing them from a same-named entity: "Caledonian Railway
// (Brechin)" normalizes to "caledonian railway", which title-matches the
// 1845 Caledonian Railway company's article; "Great Central Railway
// (Nottingham)" normalizes to the same string as the separate curated row
// "Great Central Railway" (the Loughborough line) — two different heritage
// railways, ~22km apart, i.e. barely outside the 20km geo gate; and
// "Central Tramway (Scarborough)" normalizes to "central tramway".
//
// So for a parenthetical name a loose title match is not sufficient on its
// own: the qualifier must survive normalization too, or the match has to
// clear geo instead. Same principle as the existing pipeline's requireGeo
// tier — a candidate form that cannot textually prove identity does not get
// to be accepted on text.
function strictNormalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function hasQualifier(name) {
  return /\([^)]+\)/.test(name);
}

// canonical name -> curated raw-OSM variant strings that map to it, minus the
// name itself and minus any variant that is ALSO another row's canonical name
// (the Ffestiniog/Welsh Highland case documented in the header — such a string
// identifies a different article, so it is not an alias of this railway).
function buildAliasMap() {
  const canonicalNames = new Set(Object.keys(HERITAGE_META));
  const map = {};
  for (const [variant, canonical] of Object.entries(HERITAGE_CANONICAL)) {
    if (!canonicalNames.has(canonical)) continue;
    if (variant === canonical) continue;
    if (canonicalNames.has(variant)) continue;
    (map[canonical] ||= []).push(variant);
  }
  return map;
}

// ─── fetch helpers ─────────────────────────────────────────────────────────
async function fetchJson(url) {
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
      if (attempt > MAX_RETRIES) return { __error: `HTTP ${res.status} after ${MAX_RETRIES} retries` };
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) return { __error: `HTTP ${res.status}` };
    return await res.json();
  }
}

async function fetchSummary(title) {
  return fetchJson(REST_SUMMARY_API + encodeURIComponent(title.replace(/ /g, '_')));
}

// Wikipedia title -> connected Wikidata QID. Reused verbatim from
// fetch-official-websites.mjs (which is the sole existing writer of `website`).
async function fetchWikidataQid(title) {
  const url = `${WIKI_API}?action=query&prop=pageprops&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const data = await fetchJson(url);
  if (!data || data.__error) return null;
  const page = data.query && data.query.pages && Object.values(data.query.pages)[0];
  return (page && page.pageprops && page.pageprops.wikibase_item) || null;
}

// One wbgetentities call for everything this script needs off the item. The
// P856 selection rule (a `preferred`-rank claim if present, else the first
// normal-rank one) is fetch-official-websites.mjs's rule, unchanged — only the
// transport differs (wbgetentities instead of wbgetclaims), so that one request
// can also carry descriptions, sitelinks, P31 and P625.
async function fetchWikidataEntity(qid) {
  const url =
    `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(qid)}` +
    `&props=claims%7Cdescriptions%7Csitelinks%7Clabels&languages=en&sitefilter=enwiki&format=json`;
  const data = await fetchJson(url);
  if (!data || data.__error) return null;
  const entity = data.entities && data.entities[qid];
  if (!entity) return null;

  const claims = entity.claims || {};
  const pickClaim = (prop) => {
    const list = claims[prop];
    if (!list || !list.length) return null;
    return list.find((c) => c.rank === 'preferred') || list[0];
  };

  const websiteClaim = pickClaim('P856');
  const websiteValue = websiteClaim?.mainsnak?.datavalue?.value;

  const coordClaim = pickClaim('P625');
  const coordValue = coordClaim?.mainsnak?.datavalue?.value;

  const instanceOf = (claims.P31 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

  return {
    qid,
    website: typeof websiteValue === 'string' ? websiteValue : null,
    description: entity.descriptions?.en?.value || null,
    label: entity.labels?.en?.value || null,
    sitelink: entity.sitelinks?.enwiki?.title || null,
    coordinates:
      coordValue && typeof coordValue.latitude === 'number'
        ? { lat: coordValue.latitude, lon: coordValue.longitude }
        : null,
    instanceOf,
  };
}

// Batched P31 label lookup — resolves the instance-of QIDs collected across the
// whole run in one pass at the end, rather than per-railway.
async function fetchLabels(qids) {
  const out = {};
  const list = [...qids];
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const url =
      `${WIKIDATA_API}?action=wbgetentities&ids=${batch.join('%7C')}` +
      `&props=labels&languages=en&format=json`;
    const data = await fetchJson(url);
    await sleep(REQUEST_DELAY_MS);
    if (!data || data.__error) continue;
    for (const [qid, entity] of Object.entries(data.entities || {})) {
      out[qid] = entity.labels?.en?.value || qid;
    }
  }
  return out;
}

// ─── verification ──────────────────────────────────────────────────────────
// scope-wikipedia-coverage.mjs's evaluateSummary(), re-expressed for a named
// railway instead of a NaPTAN station: same disambiguation rejection, same
// normalizeForCompare title equality, same imported haversine/GEO_REJECT_KM
// gate with the same "coords present but too far REJECTS outright" rule, and
// the same requireGeo tier for the collision-prone candidate forms.
// `names` is every name this railway may legitimately be titled under — the
// curated key and, when set, its prose_name. A hit on either is a real title
// match; the row is the same railway under both.
function evaluateSummary(summary, names, center, requireGeo, rejectKm) {
  if (summary.type === 'disambiguation') {
    return { accepted: false, reason: 'disambiguation page, skipped', disambiguation: true };
  }
  const matchesName = (n) => {
    const loose = normalizeForCompare(summary.title) === normalizeForCompare(n);
    // See strictNormalize()'s comment: a parenthetical-qualified name only
    // counts as a text match when the qualifier survives normalization.
    return hasQualifier(n)
      ? loose && strictNormalize(summary.title) === strictNormalize(n)
      : loose;
  };
  const looseMatch = names.some((n) => normalizeForCompare(summary.title) === normalizeForCompare(n));
  const titleMatch = names.some(matchesName);
  let geoOk = null;
  let distanceKm = null;
  if (summary.coordinates && center) {
    distanceKm = haversineKm(center.lat, center.lon, summary.coordinates.lat, summary.coordinates.lon);
    geoOk = distanceKm <= rejectKm;
    if (!geoOk) {
      return {
        accepted: false,
        reason: `rejected, ${distanceKm.toFixed(1)}km from the railway`,
        geoRejected: { title: summary.title, distanceKm },
      };
    }
  }
  const confirmed = requireGeo ? geoOk === true : titleMatch || geoOk === true;
  if (!confirmed) {
    return {
      accepted: false,
      reason: requireGeo
        ? 'unverified — alias-tier candidate requires geo confirmation, none available'
        : looseMatch && !titleMatch
          ? `unverified — "${summary.title}" matches only once the disambiguating qualifier in "${name}" is stripped, and there are no coordinates to settle it`
          : 'unverified (no title/geo match)',
      weak: { title: summary.title, hasCoordinates: !!summary.coordinates },
    };
  }
  return {
    accepted: true,
    confidence: titleMatch && geoOk === true ? 'title+geo' : titleMatch ? 'title' : 'geo',
    distanceKm,
  };
}

function toMatch(summary, candidate, confidence, distanceKm) {
  return {
    status: 'matched',
    title: summary.title,
    candidate,
    confidence,
    distanceKm,
    pageUrl: summary.content_urls?.desktop?.page || null,
    restDescription: summary.description || null,
    extract: summary.extract || '',
    hadCoordinates: !!summary.coordinates,
  };
}

async function searchFallback(names, center, rejectKm) {
  const name = names[0];
  const query = `${name} heritage railway`;
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`;
  const data = await fetchJson(url);
  const notes = [];
  if (!data || data.__error) return { match: null, notes: [`search "${query}": failed`] };
  const hits = (data.query && data.query.search) || [];
  for (const hit of hits) {
    const summary = await fetchSummary(hit.title);
    await sleep(REQUEST_DELAY_MS);
    if (!summary || summary.__error) {
      notes.push(`search hit "${hit.title}": no page`);
      continue;
    }
    const result = evaluateSummary(summary, names, center, false, rejectKm);
    if (result.accepted) {
      return {
        match: toMatch(summary, `search:"${query}"→"${hit.title}"`, result.confidence, result.distanceKm),
        notes,
      };
    }
    notes.push(`search hit "${hit.title}": ${result.reason}`);
  }
  return { match: null, notes };
}

async function resolveRailway(names, center, aliases, rejectKm) {
  const notes = [];
  let sawDisambiguation = false;
  let geoRejected = null;

  for (const candidate of buildHeritageCandidates(names)) {
    const summary = await fetchSummary(candidate);
    await sleep(REQUEST_DELAY_MS);
    if (!summary) { notes.push(`"${candidate}": no page`); continue; }
    if (summary.__error) { notes.push(`"${candidate}": ${summary.__error}`); continue; }
    const result = evaluateSummary(summary, names, center, false, rejectKm);
    if (result.accepted) return { match: toMatch(summary, candidate, result.confidence, result.distanceKm), notes };
    if (result.disambiguation) sawDisambiguation = true;
    if (result.geoRejected && !geoRejected) geoRejected = { ...result.geoRejected, candidate };
    notes.push(`"${candidate}" → "${summary.title || '?'}": ${result.reason}`);
  }

  const searched = await searchFallback(names, center, rejectKm);
  notes.push(...searched.notes);
  if (searched.match) return { match: searched.match, notes };

  for (const alias of aliases) {
    const summary = await fetchSummary(alias);
    await sleep(REQUEST_DELAY_MS);
    if (!summary) { notes.push(`"${alias}" (alias): no page`); continue; }
    if (summary.__error) { notes.push(`"${alias}" (alias): ${summary.__error}`); continue; }
    const result = evaluateSummary(summary, names, center, true, rejectKm);
    if (result.accepted) return { match: toMatch(summary, `alias:"${alias}"`, result.confidence, result.distanceKm), notes };
    if (result.disambiguation) sawDisambiguation = true;
    if (result.geoRejected && !geoRejected) geoRejected = { ...result.geoRejected, candidate: alias };
    notes.push(`"${alias}" (alias) → "${summary.title || '?'}": ${result.reason}`);
  }

  return { match: null, notes, sawDisambiguation, geoRejected };
}

// A heritage revival and the Victorian company it revives very often share a
// name; Wikidata's own description/P31 is what tells them apart.
// "railway company" ALONE was in this pattern and had to come out: confirmed
// live it flags correct heritage operations whose Wikidata description is just
// the generic "UK railway company" (Great Bush Railway, West Lancashire Light
// Railway — both the right entity). What actually discriminates a revived line
// from the Victorian original is past-tense/defunct wording or an explicit
// historical date range, so only those remain.
const HISTORIC_COMPANY_PATTERN =
  /\b(former|defunct|historical|pre-grouping|closed)\b|\bwas a\b|\b(18|19)\d\d[–-](18|19)\d\d\b/i;

// Reads the DESCRIPTION only — P31 is deliberately excluded. Confirmed live on
// the smoke run: P31 "railway company" is carried by plenty of correct heritage
// items (Welsh Highland Railway's P31 is narrow-gauge railway / heritage railway
// / railway company, and its Wikidata description reads "heritage railway in the
// Welsh county of Gwynedd" — the right entity), so including P31 in the haystack
// flagged it as a historic company purely on a class it legitimately holds. The
// description is what actually discriminates: the real false match in the same
// smoke run, Great Central Railway → Q688684, describes itself as "British
// pre-grouping railway company (1897–1922)". P31 is still recorded on every row
// for review, just not used to flag.
// "lift"/"cliff" included because that is how Wikidata describes the seaside
// funiculars, and those descriptions are CORRECT: confirmed live that
// Fisherman's Walk Cliff Lift, Southend Cliff Lift and West Cliff Lift all
// matched the right entity, each described as "lift running from the clifftop
// to the beach in ..." — which the place-class check below would otherwise
// flag on the word "beach".
// `restor` covers the preservation societies whose Wikidata description is
// framed around the line they are bringing back — confirmed live for Stainmore
// Railway, described as an "organisation attempting to restore the former
// Stainmore line": the right entity, and a heritage body, but the word "former"
// would otherwise read as the defunct original company.
const HERITAGE_DESCRIPTION_PATTERN =
  /\b(heritage|preserv\w*|restor\w*|museum|tourist|miniature|funicular|cliff (railway|lift)|lift)\b/i;

function detectHistoricCompany(entity) {
  if (!entity || !entity.description) return false;
  if (HERITAGE_DESCRIPTION_PATTERN.test(entity.description)) return false;
  return HISTORIC_COMPANY_PATTERN.test(entity.description);
}

// ─── wrong-entity-CLASS detection ─────────────────────────────────────────
// The geo gate is blind to this whole failure class, by construction: a
// heritage railway's own town, and the National Rail station at its terminus,
// both sit at essentially the SAME coordinates as the railway, so a match
// landing on either passes the 20km check comfortably. Confirmed live in this
// run's own output — descriptions read "market town in Herefordshire, England"
// (Bromyard & Linton Light Railway → the town), "railway station in Cornwall,
// England", "railway station in Falkirk, Scotland, UK", and "mountain range in
// the eastern Highlands of Scotland, UK" (Cairngorm Funicular → the Cairngorms).
// Every one of those cleared geo.
//
// This is the same observation scope-wikipedia-coverage.mjs makes for stations
// in isGeoMatchTownArticle() — that Wikidata/Wikipedia's own one-line
// description is what distinguishes a settlement article from the transport
// article at the same place — applied to the classes a heritage railway can
// wrongly collapse onto.
const WRONG_CLASS_PATTERNS = [
  [/\brailway station\b|\btrain station\b/i, 'railway station'],
  [/\b(market town|town|city|village|hamlet|suburb|civil parish)\b/i, 'settlement'],
  [/\bmountain range\b|\bmountain\b|\bhill\b|\bvalley\b(?!.*railway)/i, 'landform'],
  [/\blisted building\b|\bmotive power depot\b/i, 'building/structure'],
  // Added after reviewing all 47 geo-only matches by hand: the geo gate happily
  // accepts whatever else stands at the railway's coordinates. Confirmed live —
  // littledale-light-railway matched "St Paul's Church, Brookhouse" ("church
  // in Caton-with-Littledale") and was shipping that church's
  // achurchnearyou.com page as the railway's official website, and
  // severn-and-wye-line matched "Severn Bridge" ("suspension bridge in
  // Gloucestershire"). Neither carried any other blocking flag.
  [/\b(church|cathedral|chapel|abbey|place of worship)\b/i, 'place of worship'],
  [/\bbridge\b/i, 'bridge'],
  [/\b(quarry|mine|colliery)\b/i, 'quarry/mine'],
  [/\b(castle|country house|manor|stately home)\b/i, 'historic house'],
  [/\b(school|university|college|hospital|pub|hotel|inn)\b/i, 'unrelated building'],
];

// ─── why the geo gate is length-aware here ────────────────────────────────
// GEO_REJECT_KM is 20km because scope-wikipedia-coverage.mjs compares two POINT
// features — a station and its article's coordinates. A heritage railway is a
// LINE up to 43km long, and the two points being compared are not the same kind
// of thing: our `center` is a terminus or the nearest National Rail station
// (build-heritage-client-data.mjs picks it for dot placement), while Wikidata's
// P625 is wherever that item happens to be pinned, often the other end. So the
// two can legitimately sit a whole railway-length apart.
//
// Confirmed live on the first full run: North Yorkshire Moors Railway (39.5km)
// and West Somerset Railway (43.3km) were both geo-REJECTED against their own
// correct articles — each described, unambiguously, as "heritage railway in
// England"/"heritage railway in Somerset, England". A flat 20km gate cannot
// accept a 43km railway matched at its far terminus.
//
// The allowance is the railway's own length on top of the base tolerance, which
// is the largest separation the geometry can produce. This LOOSENS the gate only
// in proportion to length: a micro railway keeps essentially the 20km gate, so
// the short-railway collisions the gate exists to catch are unaffected.
function geoRejectKmFor(km) {
  return GEO_REJECT_KM + (km || 0);
}

// A match that is BOTH an exact-title hit and geo-confirmed is our railway on
// two independent axes; its description being oddly-classed is then usually the
// description's problem, not the match's (confirmed live: Aberystwyth Cliff
// Railway's Wikidata description is "Grade II listed building in Ceredigion" —
// right entity, structure-shaped description). Those are left unflagged; every
// weaker match gets its description class-checked.
function detectWrongEntityClass(row) {
  const desc = row.wikidata_description || row.rest_description || '';
  if (!desc) return null;
  const exactTitleAndGeo =
    (row.confidence === 'title+geo' || row.confidence === 'title+geo(P625)') &&
    [row.name, row.display_name].filter(Boolean).some(
      (n) => strictNormalize(row.wikipedia_title || '') === strictNormalize(n)
    );
  if (exactTitleAndGeo) return null;
  if (HERITAGE_DESCRIPTION_PATTERN.test(desc)) return null;
  // A description that already names a railway/tramway as the SUBJECT is fine
  // ("narrow gauge railway in England"); the patterns below only fire on a
  // description whose subject is something else entirely.
  if (/^\s*[^,]*\b(railway|railroad|tramway|funicular|cable railway|light railway)\b/i.test(desc)
      && !/\brailway station\b|\btrain station\b/i.test(desc)) return null;

  // Test the CLASS half only. A Wikidata description is "<class> in <place>",
  // and matching the whole string makes the PLACE NAME able to trigger a class
  // flag — confirmed live: "grade II listed motive power depot in Barrow Hill,
  // Derbyshire" was flagged as a landform because the place name contains
  // "Hill". The class is what we're classifying; the place never is.
  const inIdx = desc.toLowerCase().lastIndexOf(' in ');
  const classPart = inIdx === -1 ? desc : desc.slice(0, inIdx);
  for (const [pattern, label] of WRONG_CLASS_PATTERNS) {
    if (pattern.test(classPart)) return label;
  }
  return null;
}

// ONLY_SLUGS (optional, comma-separated): restrict a run to specific slugs —
// used to smoke-test the known collision-prone cases before committing to the
// full 183-railway pass. Same convention as fetch-official-websites.mjs's
// ONLY_KIND. Writes to a SEPARATE checkpoint so a partial smoke run can never
// be mistaken for, or block, the full run.
const ONLY_SLUGS = process.env.ONLY_SLUGS
  ? new Set(process.env.ONLY_SLUGS.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

async function main() {
  const heritageClient = loadJson(HERITAGE_CLIENT_PATH, {});
  const aliasMap = buildAliasMap();
  const checkpointPath = ONLY_SLUGS
    ? path.join(OUTPUT_DIR, 'heritage-wikidata-smoke-checkpoint.json')
    : CHECKPOINT_PATH;
  const checkpoint = loadJson(checkpointPath, {});
  const names = Object.keys(HERITAGE_META).filter(
    (n) => !ONLY_SLUGS || ONLY_SLUGS.has(HERITAGE_META[n].slug)
  );

  console.log(`── heritage Wikidata resolution: ${names.length} railways ──`);
  if (Object.keys(checkpoint).length) {
    console.log(`   resuming — ${Object.keys(checkpoint).length} already in checkpoint`);
  }

  let processed = 0;
  for (const name of names) {
    const meta = HERITAGE_META[name];
    const slug = meta.slug;
    if (checkpoint[slug]) { processed++; continue; }

    // prose_name first — see buildHeritageCandidates().
    const acceptableNames = meta.prose_name && meta.prose_name !== name
      ? [meta.prose_name, name]
      : [name];
    const client = heritageClient[slug] || {};
    const center = client.center ? { lon: client.center[0], lat: client.center[1] } : null;
    const aliases = aliasMap[name] || [];

    const row = {
      slug,
      name,
      display_name: meta.prose_name || name,
      fetched_at: new Date().toISOString(),
      type: meta.type,
      secondary: meta.secondary,
      band: meta.band,
      km: meta.km,
      hasCenter: !!center,
      aliasesTried: aliases,
      flags: [],
    };

    try {
      const { match, notes, sawDisambiguation, geoRejected } = await resolveRailway(acceptableNames, center, aliases, geoRejectKmFor(meta.km));
      row.notes = notes;

      if (!match) {
        row.status = 'unresolved';
        if (geoRejected) {
          row.flags.push('geo-rejected');
          row.geoRejected = geoRejected;
        }
        if (sawDisambiguation) row.flags.push('disambiguation');
        if (!center) row.flags.push('no-center');
        console.log(`  ${slug}: UNRESOLVED${row.flags.length ? ` [${row.flags.join(', ')}]` : ''}`);
      } else {
        row.status = 'matched';
        row.wikipedia_title = match.title;
        row.wikipedia_url = match.pageUrl;
        row.confidence = match.confidence;
        row.distanceKm = match.distanceKm;
        row.rest_description = match.restDescription;
        row.extract = match.extract;
        row.matched_candidate = match.candidate;

        const qid = await fetchWikidataQid(match.title);
        await sleep(REQUEST_DELAY_MS);
        row.qid = qid;
        if (qid) {
          const entity = await fetchWikidataEntity(qid);
          await sleep(REQUEST_DELAY_MS);
          if (entity) {
            row.website = entity.website;
            row.wikidata_description = entity.description;
            row.wikidata_label = entity.label;
            row.sitelink = entity.sitelink;
            row.instance_of_qids = entity.instanceOf;
            row.wikidata_coordinates = entity.coordinates;

            // P625 as the geo-gate fallback: a title-only match whose article
            // carried no coordinates can still be corroborated (or rejected)
            // by the item's own coordinate claim.
            if (match.confidence === 'title' && !match.hadCoordinates && entity.coordinates && center) {
              const dist = haversineKm(center.lat, center.lon, entity.coordinates.lat, entity.coordinates.lon);
              row.p625_distanceKm = dist;
              if (dist > geoRejectKmFor(meta.km)) {
                row.flags.push('geo-rejected');
                row.geoRejected = { title: match.title, distanceKm: dist, source: 'P625' };
              } else {
                row.confidence = 'title+geo(P625)';
              }
            }
          }
        }

        if (row.confidence === 'title' && !center) row.flags.push('no-center');
        else if (row.confidence === 'title') row.flags.push('geo-unconfirmed');

        // A 'geo'-only match means the article title is NOT our railway's name —
        // it was accepted purely because the coordinates line up. Usually that's
        // a legitimately renamed/parent entity (confirmed live: Crich Tramway →
        // "National Tramway Museum", 0.04km, tramway.co.uk — right entity), but
        // it is also how you'd land on a neighbouring attraction that happens to
        // share a site. Same concern scope-wikipedia-coverage.mjs's
        // isGeoMatchTownArticle() handles for stations; surfaced for review
        // rather than rejected, since rejecting would lose the correct ones.
        if (row.confidence === 'geo') row.flags.push('geo-only-title-differs');

        console.log(
          `  ${slug}: ${match.title} [${row.confidence}]` +
            ` qid=${qid || 'none'} site=${row.website ? 'yes' : 'no'}` +
            (row.flags.length ? ` [${row.flags.join(', ')}]` : '')
        );
      }
    } catch (err) {
      row.status = 'error';
      row.error = err.message;
      console.error(`  ${slug}: FAILED — ${err.message}`);
    }

    checkpoint[slug] = row;
    processed++;
    if (processed % CHECKPOINT_EVERY === 0) {
      saveJson(checkpointPath, checkpoint);
      console.log(`   ${processed}/${names.length} (checkpoint saved)`);
    }
  }
  saveJson(checkpointPath, checkpoint);

  // ─── P31 labels + historic-company flagging ──────────────────────────────
  const allInstanceQids = new Set();
  for (const row of Object.values(checkpoint)) {
    for (const q of row.instance_of_qids || []) allInstanceQids.add(q);
  }
  const instanceLabels = await fetchLabels(allInstanceQids);
  for (const row of Object.values(checkpoint)) {
    // Backfill for rows written by the first full run, which predated the
    // fetched_at field. Attests "checked by this point", not to the minute.
    if (!row.fetched_at) row.fetched_at = new Date().toISOString();
    row.instance_of = (row.instance_of_qids || []).map((q) => instanceLabels[q] || q);
    // These two flags are DERIVED from the stored description, so they must be
    // cleared and recomputed, not merely added-if-absent. Without this a re-run
    // keeps flags a previous run's (now-changed) heuristics produced, and the
    // checkpoint silently reports stale conclusions — which it did: refining the
    // class check left barrow-hill-engine-shed-society and stainmore-railway
    // still carrying flags the current logic no longer raises.
    row.flags = (row.flags || []).filter((f) => f !== 'historic-company' && f !== 'wrong-entity-class');
    delete row.wrong_entity_class;
    if (
      row.status === 'matched' &&
      detectHistoricCompany({ description: row.wikidata_description }) &&
      !row.flags.includes('historic-company')
    ) {
      row.flags.push('historic-company');
    }
    if (row.status === 'matched') {
      const wrongClass = detectWrongEntityClass(row);
      if (wrongClass && !row.flags.includes('wrong-entity-class')) {
        row.flags.push('wrong-entity-class');
        row.wrong_entity_class = wrongClass;
      }
    }
  }
  saveJson(checkpointPath, checkpoint);

  // ─── summary ─────────────────────────────────────────────────────────────
  const rows = names.map((n) => checkpoint[HERITAGE_META[n].slug]).filter(Boolean);
  const withWebsite = rows.filter((r) => r.website);
  const withWikipedia = rows.filter((r) => r.status === 'matched');
  const withNeither = rows.filter((r) => r.status !== 'matched' && !r.website);
  const withWikipediaNoWebsite = rows.filter((r) => r.status === 'matched' && !r.website);
  const flagged = rows.filter((r) => r.flags && r.flags.length);

  const byConfidence = {};
  for (const r of withWikipedia) byConfidence[r.confidence] = (byConfidence[r.confidence] || 0) + 1;
  const byFlag = {};
  for (const r of flagged) for (const f of r.flags) byFlag[f] = (byFlag[f] || 0) + 1;

  const summary = {
    generated_at: new Date().toISOString(),
    total: rows.length,
    resolved_website: withWebsite.length,
    resolved_wikipedia: withWikipedia.length,
    wikipedia_but_no_website: withWikipediaNoWebsite.length,
    resolved_neither: withNeither.length,
    by_confidence: byConfidence,
    by_flag: byFlag,
    flagged_total: flagged.length,
  };

  saveJson(REPORT_JSON_PATH, { summary, rows });

  const md = [];
  md.push('# Heritage railway Wikidata resolution report', '');
  md.push(`Generated ${summary.generated_at}`, '');
  md.push('## Match rate', '');
  md.push('| Metric | Count | % of total |');
  md.push('|---|---:|---:|');
  const pct = (n) => `${((n / summary.total) * 100).toFixed(1)}%`;
  md.push(`| Total curated railways | ${summary.total} | — |`);
  md.push(`| Resolved a Wikipedia article | ${summary.resolved_wikipedia} | ${pct(summary.resolved_wikipedia)} |`);
  md.push(`| Resolved an official website (P856) | ${summary.resolved_website} | ${pct(summary.resolved_website)} |`);
  md.push(`| Wikipedia but no P856 claim | ${summary.wikipedia_but_no_website} | ${pct(summary.wikipedia_but_no_website)} |`);
  md.push(`| Resolved NEITHER | ${summary.resolved_neither} | ${pct(summary.resolved_neither)} |`);
  md.push('', '## Match confidence', '');
  md.push('| Confidence | Count |', '|---|---:|');
  for (const [k, v] of Object.entries(byConfidence).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
  md.push('', '## Flags', '');
  md.push('| Flag | Count |', '|---|---:|');
  for (const [k, v] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) md.push(`| ${k} | ${v} |`);
  md.push('', '## Flagged railways (do not ship unreviewed)', '');
  md.push('| Slug | Flags | Detected class | Matched title | Website | Wikidata description |');
  md.push('|---|---|---|---|---|---|');
  for (const r of flagged) {
    md.push(
      `| ${r.slug} | ${r.flags.join(', ')} | ${r.wrong_entity_class || '—'} | ${r.wikipedia_title || '—'} | ${r.website || '—'} | ${(r.wikidata_description || '—').replace(/\|/g, '\\|')} |`
    );
  }
  md.push('', '## Unresolved', '');
  md.push('| Slug | Name | Flags |', '|---|---|---|');
  for (const r of rows.filter((x) => x.status !== 'matched')) {
    md.push(`| ${r.slug} | ${r.name} | ${(r.flags || []).join(', ') || '—'} |`);
  }
  writeFileSync(REPORT_MD_PATH, md.join('\n') + '\n');

  console.log('\n── summary ──');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nreport: ${REPORT_MD_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * scripts/fetch-osm-facts.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates the STRUCTURED/PHYSICAL fields in stations-content.json and
 * routes-content.json from live OpenStreetMap data (via the public Overpass
 * API) — deterministic, no AI involved. Run manually/periodically:
 *
 *   node scripts/fetch-osm-facts.mjs
 *
 * Edit the JOBS array below to add/remove entries each time you run it —
 * there is no live production dependency on this script or on Overpass;
 * it only ever writes static JSON that the app reads at request time.
 *
 * ─── FIELD OWNERSHIP (read this before editing another script) ───────────
 * This script is the ONLY writer for:
 *   stations-content.json  →  platforms, wheelchair, operators
 *   routes-content.json    →  length_km, stopping_stations, type, operator
 * It never writes: name, wikipedia_title, synopsis, opened_year,
 * operating_since, notable_features, photo, location, listed_status,
 * franchises, parent_company, or any other field — those belong to
 * scripts/fetch-wikipedia-facts.mjs (narrative/historical) or to manual
 * curation. See that script's header for its own owned-fields list, and
 * stations-content.json/routes-content.json's own "_notes" for the full
 * split. Existence/open-closed status is owned by the separate, pre-
 * existing NaPTAN re-import pipeline — not touched here either.
 *
 * Each run does a shallow merge: only the fields this script owns are
 * ever assigned on an existing entry; every other field already present
 * (curated or written by the Wikipedia script) is left untouched. This is
 * what makes it safe to run both scripts in either order, repeatedly.
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');
const ROUTES_PATH = path.join(ROOT, 'routes-content.json');
const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');

// OSM PTv2 route relations almost always list "stop" members as bare
// public_transport=stop_position nodes on the track (name tag only) — the
// actual railway=station node carrying ref:crs is a separate OSM object
// nearby, not the relation member itself (confirmed against the real
// Cross-City Line relation: 0/22 stop members had ref:crs, all 22 had a
// clean name). So CRS resolution matches the stop's name against the
// app's own station-list.json (already the trusted full station list —
// see coordsForCrs() in map.html for the client-side equivalent) rather
// than assuming ref:crs is present on the relation member.
function normalizeStationName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\brail(?:way)? station\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const stationList = loadJson(STATION_LIST_PATH);
const nameToCrs = new Map(stationList.map((s) => [normalizeStationName(s.name), s.crs]));

// ─── Jobs to run this pass — edit this, then `node scripts/fetch-osm-facts.mjs` ──
// station jobs: just a CRS code — looked up via OSM's ref:crs tag (exact match).
// route jobs: either a known OSM relation id (fast, unambiguous — find it once
// on osm.org/relation/<id> or overpass-turbo.eu and paste it here), or a
// name + bbox to search for (bbox keeps the public Overpass server from
// timing out on an unscoped whole-planet regex search, and narrows false
// matches). `slug` is this route's key in routes-content.json.
// Validation batch (2026-07-13): first 100 CRS codes in station-list.json,
// alphabetical, excluding BHM/SOL (already populated) — sizing real-world
// Overpass timing/error rate against the public instance before committing
// to all ~2,637 stations. Routes intentionally left empty this pass; the two
// test routes are already populated from the earlier validation run.
const JOBS = {
  stations: ["AAP", "AAT", "ABA", "ABC", "ABD", "ABE", "ABH", "ABW", "ABX", "ABY", "ACB", "ACC", "ACG", "ACH", "ACK", "ACL", "ACN", "ACR", "ACT", "ACY", "ADC", "ADD", "ADK", "ADL", "ADM", "ADN", "ADR", "ADS", "ADV", "ADW", "AFK", "AFS", "AFV", "AGL", "AGR", "AGS", "AGT", "AGV", "AHD", "AHN", "AHS", "AHT", "AHV", "AIG", "AIN", "AIR", "ALB", "ALD", "ALF", "ALK", "ALM", "ALN", "ALO", "ALP", "ALR", "ALT", "ALV", "ALW", "ALX", "AMB", "AMF", "AML", "AMR", "AMT", "AMY", "ANC", "AND", "ANF", "ANG", "ANL", "ANN", "ANS", "ANZ", "AON", "APB", "APD", "APF", "APG", "APN", "APP", "APS", "APY", "ARB", "ARD", "ARG", "ARL", "ARM", "ARN", "ARR", "ART", "ARU", "ASB", "ASC", "ASD", "ASF", "ASG", "ASH", "ASK", "ASL", "ASN"],
  routes: [],
};

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass's usage policy asks for an identifying User-Agent — the public
// instance also returns a bare Apache 406 for requests with no/default UA,
// which looks like a query-syntax error if you don't know to check this.
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

async function overpassQuery(ql, { retries = 4 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(ql),
    });
    if (res.ok) return res.json();
    // 429 (rate limited) / 504 (server busy) are exactly the transient cases
    // worth backing off and retrying — anything else (e.g. a real query
    // syntax error) should fail loudly rather than retry pointlessly.
    if ((res.status === 429 || res.status === 504) && attempt < retries) {
      const waitMs = attempt * 5000;
      console.warn(`  Overpass ${res.status}, retrying in ${waitMs / 1000}s (attempt ${attempt}/${retries})…`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const body = await res.text();
    throw new Error(`Overpass request failed: HTTP ${res.status}\n${body.slice(0, 300)}`);
  }
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lineLengthKm(wayMembers) {
  let totalM = 0;
  for (const way of wayMembers) {
    const pts = way.geometry || [];
    for (let i = 1; i < pts.length; i++) {
      totalM += haversineMeters([pts[i - 1].lon, pts[i - 1].lat], [pts[i].lon, pts[i].lat]);
    }
  }
  return Math.round((totalM / 1000) * 10) / 10; // 1 d.p. km
}

// railway=platform ways/relations tag each physical edge with a ref like
// "12a"/"12b" (two faces of platform 12) — sometimes a multipolygon groups
// several refs into one "10a;10b;11a;11b" tag. Counting distinct numeric
// prefixes gives the real platform count instead of double-counting faces.
// Metro/tram platforms (network=West Midlands Metro etc, tagged tram=yes)
// are a different mode and deliberately excluded from a National Rail count.
function countPlatforms(elements) {
  const numbers = new Set();
  for (const el of elements) {
    const tags = el.tags || {};
    if (tags.tram === 'yes' || (tags.network || '').toLowerCase().includes('metro')) continue;
    const refs = (tags.ref || '').split(';').map((s) => s.trim()).filter(Boolean);
    for (const ref of refs) {
      const m = ref.match(/^(\d+)/);
      if (m) numbers.add(m[1]);
    }
  }
  return numbers.size || null;
}

const SERVICE_TYPE_LABELS = {
  commuter: 'Commuter/suburban',
  regional: 'Regional',
  long_distance: 'Long-distance',
  high_speed: 'High-speed',
  night: 'Sleeper',
  replacement: 'Rail replacement',
  tourism: 'Tourist/heritage',
};

async function enrichStation(crs) {
  console.log(`\n── station ${crs} ──`);
  const stationQ = `[out:json][timeout:25];node["ref:crs"="${crs}"];out tags;`;
  const stationRes = await overpassQuery(stationQ);
  const node = stationRes.elements[0];
  if (!node) {
    console.warn(`  no OSM node tagged ref:crs=${crs} — nothing to merge, left for manual curation.`);
    return { crs, incomplete: true, notes: `No OSM node found with ref:crs=${crs}.` };
  }
  const tags = node.tags || {};

  await sleep(1200); // be a polite, well-spaced client on the shared public instance
  const platformQ = `[out:json][timeout:25];node(${node.id})->.stn;(way(around.stn:300)["railway"="platform"];relation(around.stn:300)["railway"="platform"];);out tags;`;
  const platformRes = await overpassQuery(platformQ);
  const platforms = countPlatforms(platformRes.elements);

  await sleep(1200);
  // Which route relations stop here → whose "brand" (preferred) or
  // "operator" tag names the TOC actually running trains through this
  // station. This is the OSM-derived counterpart to stations.operators.
  // Proximity search (like the platforms query above), not direct
  // membership (rel(bn)) — PTv2 "stop"/"platform" relation members are
  // separate stop-position/platform nodes near the station, not the
  // railway=station node itself (see the nameToCrs comment above), so a
  // direct-membership query on the station node finds nothing.
  const relQ = `[out:json][timeout:25];node(${node.id})->.stn;rel(around.stn:250)["type"="route"]["route"~"^(train|light_rail|tram)$"];out tags;`;
  const relRes = await overpassQuery(relQ);
  const operators = [...new Set(
    relRes.elements.map((r) => r.tags && (r.tags.brand || r.tags.operator)).filter(Boolean)
  )];

  const result = {
    platforms,
    wheelchair: tags.wheelchair || null,
    operators: operators.length ? operators : null,
  };
  const incomplete = platforms == null || !tags.wheelchair || !operators.length;
  const notes = [];
  if (platforms == null) notes.push('no railway=platform ways/relations found nearby — platform count unset');
  if (!tags.wheelchair) notes.push('station node has no wheelchair=* tag');
  if (!operators.length) notes.push('no route relations found stopping here — operators list unset');
  if (tags.wikipedia) notes.push(`hint: OSM tags this station's Wikipedia page as "${tags.wikipedia.replace(/^en:/, '')}" — consider setting wikipedia_title (not auto-applied)`);

  console.log(`  platforms=${platforms}  wheelchair=${tags.wheelchair || '(none)'}  operators=${operators.join(', ') || '(none)'}`);
  if (notes.length) console.log(`  ⚑ ${notes.join(' / ')}`);

  return { crs, node_id: node.id, result, incomplete, notes: notes.join('; ') || null };
}

async function findRouteRelation(job) {
  if (job.relationId) return job.relationId;
  const [s, w, n, e] = job.bbox || [49.5, -8.5, 61.0, 2.0]; // GB-wide fallback, per Task 1's Overpass usage — slow, prefer a real bbox
  const q = `[out:json][timeout:25][bbox:${s},${w},${n},${e}];relation["type"="route"]["route"~"^(train|light_rail|tram)$"]["name"~"${job.name.replace(/"/g, '')}",i];out tags;`;
  const res = await overpassQuery(q);
  if (res.elements.length === 1) return res.elements[0].id;
  return { ambiguous: res.elements.length > 1, candidates: res.elements.map((e) => ({ id: e.id, name: e.tags.name })) };
}

async function enrichRoute(job) {
  console.log(`\n── route ${job.slug} ──`);
  const relationIdOrAmbiguity = await findRouteRelation(job);
  if (typeof relationIdOrAmbiguity !== 'number') {
    const { ambiguous, candidates } = relationIdOrAmbiguity;
    const notes = ambiguous
      ? `${candidates.length} candidate OSM route relations matched "${job.name}" — ambiguous, needs a human to pick the right one and set relationId: ${candidates.map((c) => `${c.id} (${c.name})`).join(', ')}`
      : `No OSM public_transport route relation found matching "${job.name}" in the given bbox. This is a genuine content gap, not a bug — stopping_stations/length_km need manual curation for this route (or a wider/corrected bbox + retry).`;
    console.warn(`  ⚑ ${notes}`);
    return { slug: job.slug, incomplete: true, notes, result: {} };
  }
  const relationId = relationIdOrAmbiguity;

  await sleep(1200);
  const relQ = `[out:json][timeout:25];relation(${relationId});out body geom;out tags;`;
  const relRes = await overpassQuery(relQ);
  const rel = relRes.elements.find((e) => e.type === 'relation');
  const ways = rel.members.filter((m) => m.type === 'way' && m.role === '');
  const stopMembers = rel.members.filter((m) => ['stop', 'stop_entry_only', 'stop_exit_only'].includes(m.role) && m.type === 'node');

  const length_km = ways.length ? lineLengthKm(ways) : null;

  let stopping_stations = null;
  const notes = [];
  if (!stopMembers.length) {
    notes.push('relation has no stop-role members — stopping order needs manual curation');
  } else {
    await sleep(1200);
    const ids = stopMembers.map((m) => m.ref).join(',');
    const tagRes = await overpassQuery(`[out:json][timeout:25];node(id:${ids});out tags;`);
    const tagsById = Object.fromEntries(tagRes.elements.map((e) => [e.id, e.tags || {}]));
    const ordered = [];
    const unresolvedNames = [];
    for (const m of stopMembers) {
      const t = tagsById[m.ref] || {};
      // ref:crs is checked first as a fast path (some stop nodes do carry
      // it), name-match against station-list.json is the real fallback —
      // see the comment above nameToCrs for why that's necessary here.
      const crs = t['ref:crs'] || nameToCrs.get(normalizeStationName(t.name)) || null;
      if (crs) {
        if (ordered[ordered.length - 1] !== crs) ordered.push(crs); // dedupe consecutive entry/exit-only pairs at the same station
      } else {
        unresolvedNames.push(t.name || `node ${m.ref}`);
      }
    }
    stopping_stations = ordered.length ? ordered : null;
    if (unresolvedNames.length) notes.push(`${unresolvedNames.length} stop member(s) didn't match any station-list.json entry by name and were skipped: ${unresolvedNames.join(', ')} — review against the full stop list before trusting this order`);
  }

  const serviceTag = (rel.tags || {}).service;
  const type = serviceTag ? (SERVICE_TYPE_LABELS[serviceTag] || serviceTag) : null;
  if (serviceTag && !SERVICE_TYPE_LABELS[serviceTag]) notes.push(`unrecognized OSM service=${serviceTag} tag, used raw value for "type" — review`);

  const operator = (rel.tags || {}).brand || (rel.tags || {}).operator || null;
  if ((rel.tags || {}).wikipedia) notes.push(`hint: OSM tags this route's Wikipedia page as "${(rel.tags.wikipedia).replace(/^en:/, '')}" — consider setting wikipedia_title (not auto-applied)`);

  console.log(`  relation=${relationId}  length_km=${length_km}  stops=${stopping_stations ? stopping_stations.length : 0}  type=${type}  operator=${operator}`);
  if (notes.length) console.log(`  ⚑ ${notes.join(' / ')}`);

  return {
    slug: job.slug,
    relation_id: relationId,
    incomplete: length_km == null || !stopping_stations || notes.length > 0,
    notes: notes.join('; ') || null,
    result: { length_km, stopping_stations, type, operator },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mergeOsmFields(entry, fields) {
  const out = { ...(entry || {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined) out[k] = v; // only overwrite when OSM actually has a value — never blank out a manually curated field with a null
  }
  return out;
}

async function main() {
  const stationsContent = loadJson(STATIONS_PATH);
  const routesContent = loadJson(ROUTES_PATH);
  const report = { stations: [], routes: [] };

  // Save after EVERY station/route, not once at the very end — validated
  // against a real bulk run (2026-07-13, 100-station batch): the public
  // Overpass instance rate-limits hard enough that some entry eventually
  // exhausts overpassQuery()'s retry budget and throws, and with a single
  // save-at-the-end this silently discarded every station already fetched
  // (7 successful stations lost to one 8th-station failure in that run).
  // Each per-station catch below turns that into a soft failure — logged
  // and flagged in the report, not a reason to abort remaining stations.
  for (const crs of JOBS.stations) {
    try {
      const { result, incomplete, notes, node_id } = await enrichStation(crs);
      if (result) {
        stationsContent[crs] = mergeOsmFields(stationsContent[crs], result);
        stationsContent[crs]._osm = { fetched_at: new Date().toISOString(), node_id: node_id || null, incomplete: !!incomplete, notes: notes || null };
      }
      report.stations.push({ crs, incomplete, notes });
    } catch (err) {
      console.error(`  ${crs}: FAILED — ${err.message} (left untouched, continuing to next station)`);
      report.stations.push({ crs, incomplete: true, notes: `FAILED: ${err.message}` });
    }
    saveJson(STATIONS_PATH, stationsContent);
    await sleep(1200);
  }

  for (const job of JOBS.routes) {
    try {
      const { slug, result, incomplete, notes, relation_id } = await enrichRoute(job);
      routesContent[slug] = mergeOsmFields(routesContent[slug], result);
      routesContent[slug]._osm = { fetched_at: new Date().toISOString(), relation_id: relation_id || null, incomplete: !!incomplete, notes: notes || null };
      report.routes.push({ slug, incomplete, notes });
    } catch (err) {
      console.error(`  ${job.slug}: FAILED — ${err.message} (left untouched, continuing to next route)`);
      report.routes.push({ slug: job.slug, incomplete: true, notes: `FAILED: ${err.message}` });
    }
    saveJson(ROUTES_PATH, routesContent);
    await sleep(1200);
  }

  console.log('\n=== Summary (needs-your-judgment flagged with ⚑) ===');
  for (const s of report.stations) console.log(`station ${s.crs}: ${s.incomplete ? '⚑ ' + s.notes : 'OK'}`);
  for (const r of report.routes) console.log(`route ${r.slug}: ${r.incomplete ? '⚑ ' + r.notes : 'OK'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

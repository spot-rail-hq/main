#!/usr/bin/env node
/**
 * scripts/build-station-regions.mjs — station-list.json (+ the 8,884-entry
 * historical-stations.geojson) -> data/station-regions.json
 *
 *   node scripts/build-station-regions.mjs            # dry run, writes nothing
 *   node scripts/build-station-regions.mjs --write
 *
 * Assigns every station a canonical NPTG region, for use as a grouping facet
 * on the database page. Investigated and checkpointed before this script was
 * written — see CLAUDE.md's "Station regions — the admin-area-110 trap" note
 * for the full reasoning this script implements. Short version below.
 *
 * ─── THE TRAP THIS SCRIPT DELIBERATELY AVOIDS ─────────────────────────────
 * Every NaPTAN stop's OWN `AdministrativeAreaCode` is a red herring for rail:
 * heavy-rail stops are filed under AdministrativeAreaCode 110, NPTG's
 * "National - National Rail" pseudo-area, itself filed under RegionCode
 * "GB" ("Great Britain") — not a real geography. Joining region on a stop's
 * own admin-area code would flatten EVERY rail station into one meaningless
 * bucket. The correct path is TWO STEPS: stop -> NptgLocalityCode (100%
 * populated on every active NaPTAN stop) -> that LOCALITY's own
 * AdministrativeAreaCode (looked up in the separate NPTG localities table,
 * NOT the stop's own) -> Region. GB/110 is excluded from the usable region
 * map entirely, so any station that resolves to it falls through to the
 * coordinate fallback below instead of silently reporting "Great Britain".
 *
 * ─── THREE DATA SOURCES, ALL FROM naptan.api.dft.gov.uk ───────────────────
 *   1. /v1/access-nodes?dataFormat=csv  — same 97 MB bulk NaPTAN CSV
 *      scripts/fetch-naptan-stops.mjs already uses. Read here ourselves
 *      (not via that script's narrower scripts/output/naptan-stops.json,
 *      which only keeps atco/name/crs/mode/network/lat/lon) because this
 *      needs NptgLocalityCode, which that extract never captured.
 *   2. /v1/nptg/localities — CSV, ~44k localities, each with its own
 *      AdministrativeAreaCode (the real one, not 110).
 *   3. /v1/nptg — full gazetteer XML, Region -> AdministrativeAreas, giving
 *      the AdministrativeAreaCode -> Region (code + name) map.
 * All three cache to os.tmpdir(), never the repo (same reasoning as
 * fetch-naptan-stops.mjs: the NaPTAN CSV alone is >GitHub's 100MB limit).
 * NAPTAN_CSV / NPTG_LOCALITIES_CSV / NPTG_XML env vars skip the download,
 * matching that script's convention.
 *
 * ─── RESOLUTION ORDER, PER STATION ─────────────────────────────────────────
 *   1. "nptg"             — own atco resolves via the two-step join above.
 *   2. "nptg-interchange" — own atco doesn't resolve (or is null), but an
 *      `interchange[].atco` does. Only interchange entries are used — NOT
 *      proximity to some other nearby stop — because station-list.json's own
 *      migration already tested and rejected that: Canary Wharf's nearest MET
 *      stop is West India Quay DLR (149m) and Woolwich's is Woolwich Arsenal
 *      DLR (242m), both genuinely different stations. `interchange` entries
 *      are curated same-station identities (migrate-station-list.mjs's 150m
 *      suppression step); a bare coordinate near-miss is not.
 *   3. "fallback"         — nearest REFERENCE station (one already resolved
 *      via step 1 or 2 above) by coordinate. Used for: the small residual of
 *      current stations neither step above reaches (investigated below), and
 *      for all 8,884 historical stations, which mostly predate NaPTAN's
 *      ~2005 rollout and have no ATCO at all. Every fallback entry carries
 *      `distance_km` to the reference it borrowed from, and `flagged: true`
 *      past FLAG_DISTANCE_KM — inspectable confidence, not a silent guess.
 *
 * ─── THE 7 CURRENT-STATION ATCO GAPS (investigated 2026-08-16) ────────────
 * station-list.json has 7 rows with atco: null: Bond Street, Barking
 * Riverside, Custom House, Canary Wharf, Tottenham Court Road, Woolwich,
 * Southampton Town Quay. Two different, unrelated root causes — both already
 * correct/expected, neither is a bug to fix upstream:
 *   - 6 are real London stations (all but Southampton Town Quay) that NaPTAN
 *     genuinely files under their Underground/DLR/Elizabeth-line identity
 *     rather than a separate RLY record — documented in
 *     migrate-station-list.mjs's own header ("A clean regenerate ... would be
 *     WRONG"). 2 of the 6 (Bond Street, Custom House) carry a curated
 *     `interchange` atco and resolve via step 2 above. The other 4 (Barking
 *     Riverside, Canary Wharf, Tottenham Court Road, Woolwich) have no
 *     interchange entry either and fall through to step 3 — which resolves
 *     them correctly anyway, since they sit in central London a few hundred
 *     metres from dozens of already-resolved reference stations.
 *   - Southampton Town Quay (STQ) is structurally different: it is a National
 *     Rail-ticketed replacement BUS stop (the QuayConnect shuttle to the Red
 *     Funnel ferry terminal), not rail infrastructure at all — confirmed live
 *     (nationalrail.co.uk lists it as "Southampton Town Quay (Bus)"). It was
 *     never going to have an RLY-type NaPTAN record, atco: null is permanent
 *     and correct, and it resolves via step 3 like any other coordinate-only
 *     point.
 * All 7 are therefore covered by steps 2/3 above without special-casing —
 * flagged here as a deliberate extension beyond the historical-only fallback
 * originally scoped, not a silent scope-creep: leaving 6 central-London
 * stations and a Southampton interchange with no region for a marginal
 * complexity saving wasn't judged worth it.
 *
 * ─── READ-MERGE-PRESERVE ────────────────────────────────────────────────
 * data/station-regions.json is a fresh file today (nothing to preserve on
 * the first run), but follows the established pattern from the start so a
 * future hand override on a specific station survives a regen. See
 * GENERATOR_OWNED_KEYS below — same inverted-allowlist shape as
 * build-heritage-content.mjs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');
const HISTORICAL_PATH = path.join(ROOT, 'scripts', 'output', 'historical-stations.geojson');
const OUT_PATH = path.join(ROOT, 'data', 'station-regions.json');

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv';
const NPTG_LOCALITIES_URL = 'https://naptan.api.dft.gov.uk/v1/nptg/localities';
const NPTG_XML_URL = 'https://naptan.api.dft.gov.uk/v1/nptg';
const USER_AGENT =
  'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

const CACHE_NAPTAN_CSV = path.join(os.tmpdir(), 'srhq-naptan-raw.csv');
const CACHE_NPTG_LOCALITIES = path.join(os.tmpdir(), 'srhq-nptg-localities.csv');
const CACHE_NPTG_XML = path.join(os.tmpdir(), 'srhq-nptg.xml');

const FLAG_DISTANCE_KM = 30;

// ─── CSV — minimal RFC4180 reader, same as fetch-naptan-stops.mjs ─────────
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function ensureFile(envVar, url, cachePath, label) {
  const override = process.env[envVar];
  if (override) {
    if (!existsSync(override)) throw new Error(`${envVar} set but not found: ${override}`);
    console.log(`  ${label}: using local file ${override}`);
    return override;
  }
  const dir = path.dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  console.log(`  ${label}: downloading ${url}`);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${label} download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(cachePath));
  console.log(`  ${label}: downloaded in ${((Date.now() - t0) / 1000).toFixed(2)}s -> ${cachePath}`);
  return cachePath;
}

// ATCO -> NptgLocalityCode, every ACTIVE stop of any StopType (station-list.json
// spans rail/tram/underground/dlr/subway/metro/heritage, all NaPTAN-sourced).
async function loadAtcoToLocality() {
  const csvPath = await ensureFile('NAPTAN_CSV', NAPTAN_URL, CACHE_NAPTAN_CSV, 'NaPTAN CSV');
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let header = null;
  const col = {};
  const map = new Map();
  let rowCount = 0;
  for await (const line of rl) {
    if (!header) {
      header = splitCsvLine(line);
      header.forEach((h, i) => { col[h.trim()] = i; });
      for (const required of ['ATCOCode', 'NptgLocalityCode', 'Status']) {
        if (col[required] === undefined) throw new Error(`NaPTAN CSV is missing the ${required} column — schema changed upstream`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    rowCount++;
    if (f[col.Status] !== 'active') continue;
    const loc = f[col.NptgLocalityCode];
    if (loc) map.set(f[col.ATCOCode], loc);
  }
  console.log(`  NaPTAN CSV: parsed ${rowCount.toLocaleString()} rows, ${map.size.toLocaleString()} active atco->locality entries`);
  return map;
}

// NptgLocalityCode -> AdministrativeAreaCode (the locality's OWN admin area,
// never the stop's — see the module header's "trap" note).
async function loadLocalityToAdminArea() {
  const csvPath = await ensureFile('NPTG_LOCALITIES_CSV', NPTG_LOCALITIES_URL, CACHE_NPTG_LOCALITIES, 'NPTG localities CSV');
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let header = null;
  const col = {};
  const map = new Map();
  for await (const line of rl) {
    if (!header) {
      header = splitCsvLine(line);
      header.forEach((h, i) => { col[h.trim()] = i; });
      for (const required of ['NptgLocalityCode', 'AdministrativeAreaCode']) {
        if (col[required] === undefined) throw new Error(`NPTG localities CSV is missing the ${required} column — schema changed upstream`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    map.set(f[col.NptgLocalityCode], f[col.AdministrativeAreaCode]);
  }
  console.log(`  NPTG localities CSV: ${map.size.toLocaleString()} localities`);
  return map;
}

// AdministrativeAreaCode -> {code, name} region. Excludes RegionCode "GB" —
// the pseudo-region holding National Rail/Coach/Air/Ferry's flat admin areas,
// not a real geography (see module header).
async function loadAdminAreaToRegion() {
  const xmlPath = await ensureFile('NPTG_XML', NPTG_XML_URL, CACHE_NPTG_XML, 'NPTG gazetteer XML');
  const xml = readFileSync(xmlPath, 'utf8');
  const regionBlocks = xml.match(/<Region [^>]*>[\s\S]*?<\/Region>/g) || [];
  const adminAreaToRegion = new Map();
  const regions = {};
  for (const block of regionBlocks) {
    const codeM = block.match(/<RegionCode>([^<]+)<\/RegionCode>/);
    const nameM = block.match(/<Name[^>]*>([^<]+)<\/Name>/);
    if (!codeM || !nameM) continue;
    const code = codeM[1], name = nameM[1];
    if (code === 'GB') continue; // pseudo-region — see module header
    regions[code] = { code, name };
    const areaMatches = block.matchAll(/<AdministrativeAreaCode>([^<]+)<\/AdministrativeAreaCode>/g);
    for (const m of areaMatches) adminAreaToRegion.set(m[1], { code, name });
  }
  console.log(`  NPTG gazetteer: ${Object.keys(regions).length} real regions, ${adminAreaToRegion.size} admin areas mapped`);
  return { adminAreaToRegion, regions };
}

function resolveAtco(atco, atcoToLocality, localityToAdminArea, adminAreaToRegion) {
  if (!atco) return null;
  const loc = atcoToLocality.get(atco);
  if (!loc) return null;
  const admin = localityToAdminArea.get(loc);
  if (!admin) return null;
  return adminAreaToRegion.get(admin) || null; // null if it resolves to GB (excluded above)
}

// Equirectangular approx — fine at GB's extent, matches the approach already
// validated at the checkpoint (nearest of ~3.4k reference points, per query).
function nearestReference(lat, lon, refs) {
  let bestD = null, bestRef = null;
  for (const r of refs) {
    const dx = (lon - r.lon) * Math.cos((lat + r.lat) * Math.PI / 360);
    const dy = lat - r.lat;
    const d = dx * dx + dy * dy;
    if (bestD === null || d < bestD) { bestD = d; bestRef = r; }
  }
  return { region: bestRef.region, distanceKm: Math.sqrt(bestD) * 111.0 };
}

// ─── READ-MERGE-PRESERVE ────────────────────────────────────────────────
const GENERATOR_OWNED_KEYS = new Set(['region', 'method', 'distance_km', 'flagged']);

function loadExisting() {
  if (!existsSync(OUT_PATH)) return null;
  return JSON.parse(readFileSync(OUT_PATH, 'utf8'));
}

function preservedFields(oldEntry) {
  if (!oldEntry) return {};
  const preserved = {};
  for (const [k, v] of Object.entries(oldEntry)) {
    if (!GENERATOR_OWNED_KEYS.has(k)) preserved[k] = v;
  }
  return preserved;
}

function assertNoDataLoss(oldSection, newSection, label) {
  if (!oldSection) return;
  const problems = [];
  for (const [key, oldEntry] of Object.entries(oldSection)) {
    const newEntry = newSection[key];
    if (!newEntry) continue; // station legitimately dropped — not this guard's concern
    for (const [k, v] of Object.entries(oldEntry)) {
      if (GENERATOR_OWNED_KEYS.has(k)) continue;
      if (v === null || v === undefined || v === '') continue;
      if (JSON.stringify(newEntry[k]) !== JSON.stringify(v)) {
        problems.push(`${label}.${key}.${k}: had ${JSON.stringify(v)}, would become ${JSON.stringify(newEntry[k])}`);
      }
    }
  }
  if (problems.length) {
    console.error(`\nABORTING — ${problems.length} hand-curated field(s) in "${label}" would be lost or changed:`);
    for (const p of problems.slice(0, 20)) console.error('  ' + p);
    if (problems.length > 20) console.error(`  ...and ${problems.length - 20} more`);
    process.exit(1);
  }
}

async function main() {
  console.log('── station region assignment ──');
  const atcoToLocality = await loadAtcoToLocality();
  const localityToAdminArea = await loadLocalityToAdminArea();
  const { adminAreaToRegion, regions } = await loadAdminAreaToRegion();

  const stationList = JSON.parse(readFileSync(STATION_LIST_PATH, 'utf8'));
  console.log(`  station-list.json: ${stationList.length} entries`);

  // Pass 1 — direct resolution (steps 1/2). Builds the reference pool for
  // the coordinate fallback (step 3) at the same time.
  //
  // KEY: atco when the station has one (3,436 of 3,443) — "atco-keyed" as
  // scoped. The 7 exceptions (investigated 2026-08-16, see module header)
  // carry atco: null on their OWN row but DO have a real, stable, unique CRS
  // — migrate-station-list.mjs's own words: "keep crs as their identity".
  // Dropping them from this file entirely (the first version of this script
  // did, via a `continue` guard that fired before interchange resolution
  // even ran) would silently lose region data for 6 real central-London
  // stations and Southampton Town Quay for no reason — there is a stable key
  // available, it just isn't atco. Keyed as `crs:<CODE>` (namespaced so it
  // can never collide with an atco string, which always starts with a
  // 4-digit numeric prefix) rather than silently promoting crs to a bare key
  // that would look atco-shaped. FLAGGED as a deviation from "atco-keyed" —
  // 7 of 3,443 entries, all individually explained above.
  const current = {};
  const refs = [];
  const needsFallback = [];
  for (const s of stationList) {
    const key = s.atco || (s.crs ? `crs:${s.crs}` : null);
    if (!key) continue; // no identity at all to key this entry on — none observed in station-list.json today
    let region = resolveAtco(s.atco, atcoToLocality, localityToAdminArea, adminAreaToRegion);
    let method = 'nptg';
    if (!region && Array.isArray(s.interchange)) {
      for (const ic of s.interchange) {
        region = resolveAtco(ic.atco, atcoToLocality, localityToAdminArea, adminAreaToRegion);
        if (region) { method = 'nptg-interchange'; break; }
      }
    }
    if (region) {
      current[key] = { region: region.code, method, distance_km: null, flagged: false };
      refs.push({ lat: s.lat, lon: s.lon, region: region.code });
    } else {
      needsFallback.push({ ...s, _key: key });
    }
  }
  console.log(`  direct resolution: ${Object.keys(current).length}/${stationList.length} (reference pool: ${refs.length})`);
  console.log(`  needs coordinate fallback: ${needsFallback.length}`);

  // Pass 2 — coordinate fallback (step 3) for whatever pass 1 didn't reach.
  for (const s of needsFallback) {
    const { region, distanceKm } = nearestReference(s.lat, s.lon, refs);
    current[s._key] = {
      region, method: 'fallback',
      distance_km: Math.round(distanceKm * 10) / 10,
      flagged: distanceKm > FLAG_DISTANCE_KM,
    };
  }

  // Pass 3 — historical stations, wikidata_qid-keyed, ALL via fallback
  // (predate NaPTAN; no atco to resolve directly). Same reference pool as
  // pass 2 — current stations resolved via steps 1/2 only, not
  // fallback-of-fallback.
  const historicalGeojson = JSON.parse(readFileSync(HISTORICAL_PATH, 'utf8'));
  const historical = {};
  let flaggedHistorical = 0;
  for (const feat of historicalGeojson.features) {
    const qid = feat.properties.wikidata_qid;
    if (!qid) continue;
    const [lon, lat] = feat.geometry.coordinates;
    const { region, distanceKm } = nearestReference(lat, lon, refs);
    const flagged = distanceKm > FLAG_DISTANCE_KM;
    if (flagged) flaggedHistorical++;
    historical[qid] = {
      region, method: 'fallback',
      distance_km: Math.round(distanceKm * 10) / 10,
      flagged,
    };
  }
  console.log(`  historical stations: ${Object.keys(historical).length}/${historicalGeojson.features.length}, ${flaggedHistorical} flagged (>${FLAG_DISTANCE_KM}km from nearest reference)`);

  // ─── read-merge-preserve ─────────────────────────────────────────────
  const existing = loadExisting();
  const mergedCurrent = {};
  for (const [atco, entry] of Object.entries(current)) {
    mergedCurrent[atco] = { ...entry, ...preservedFields(existing?.current?.[atco]) };
  }
  const mergedHistorical = {};
  for (const [qid, entry] of Object.entries(historical)) {
    mergedHistorical[qid] = { ...entry, ...preservedFields(existing?.historical?.[qid]) };
  }
  assertNoDataLoss(existing?.current, mergedCurrent, 'current');
  assertNoDataLoss(existing?.historical, mergedHistorical, 'historical');

  const payload = {
    _notes: 'GENERATED by scripts/build-station-regions.mjs from station-list.json + ' +
      'scripts/output/historical-stations.geojson + live NPTG/NaPTAN data (naptan.api.dft.gov.uk). ' +
      'DO NOT HAND-EDIT the region/method/distance_km/flagged fields — re-run the script instead; ' +
      'any OTHER field added to an entry by hand is preserved across re-runs (read-merge-preserve). ' +
      '`current` is keyed on station-list.json\'s `atco` for 3,436 of 3,443 entries — the field with near-' +
      'universal coverage across all modes (CRS does not cover tram/metro/DLR/heritage). The remaining 7 ' +
      '(Bond Street, Barking Riverside, Custom House, Canary Wharf, Tottenham Court Road, Woolwich, ' +
      'Southampton Town Quay — investigated 2026-08-16) carry atco: null on their own station-list.json ' +
      'row and are keyed `crs:<CODE>` instead (namespaced so it can never collide with an atco string, ' +
      'which always starts with a 4-digit numeric prefix) rather than being dropped from this file. ' +
      '`historical` is keyed on wikidata_qid, ' +
      'matching historical-stations.geojson\'s own key. `regions` gives the NPTG region code -> display ' +
      'name for both sections; region values elsewhere in this file are always the CODE, never the name ' +
      '(see CLAUDE.md\'s station-regions note for why: NPTG names, not remapped to ONS Government Office ' +
      'Region names). method is one of "nptg" (own atco resolved directly), "nptg-interchange" (resolved ' +
      'via a curated same-station interchange atco), or "fallback" (nearest already-resolved reference ' +
      'station by coordinate — distance_km is the distance to that reference; flagged is true past ' +
      FLAG_DISTANCE_KM + 'km, for manual spot-checking, not because the assignment is known wrong).',
    generated_at: new Date().toISOString(),
    regions,
    current: mergedCurrent,
    historical: mergedHistorical,
  };

  const json = JSON.stringify(payload, null, 2) + '\n';
  if (!process.argv.includes('--write')) {
    console.log('\nDry run — no file written. Pass --write to write ' + path.relative(ROOT, OUT_PATH));
    return { payload };
  }
  const outDir = path.dirname(OUT_PATH);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(OUT_PATH, json);
  console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
  return { payload };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

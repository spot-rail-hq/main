#!/usr/bin/env node
/**
 * scripts/fetch-station-addresses-google.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Fallback address source for stations scripts/fetch-station-addresses.mjs
 * (OSM node addr:* tags) and scripts/fetch-wikipedia-facts.mjs (Wikipedia
 * infobox location) couldn't cover — deterministic API lookup, no AI:
 * Google's Geocoding API (reverse geocode, lat/lon -> address).
 *
 * SAFETY FILTER (the whole reason this needs its own script rather than a
 * naive reverse-geocode call): confirmed live 2026-07-18 that Google's
 * FIRST-ranked reverse-geocode result is not reliably the station itself —
 * spot-check of 15 stations found Newtown (Powys) matched to an unrelated
 * CAFE, and three more (Dunton Green, Maesteg, Builth Road) matched to a
 * nearby house address instead of the station. Google's own `types` field
 * cleanly distinguishes these: every genuinely-correct match carries
 * `train_station` or `transit_station` in its types array; every bad match
 * didn't. This script requires that type tag on some result in the
 * response (not necessarily the top-ranked one — re-testing after adding
 * this filter found the CORRECT station-typed result for Newtown and
 * Dunton Green sitting further down the same response, not absent) — a
 * response with no station-typed result anywhere is treated as "no
 * confident match" and left alone, same "skip rather than guess"
 * discipline as every other script in this project. Confirmed via a 15-
 * station spot-check with this filter: 12/14 accepted cleanly (excluding 1
 * station with no coordinates at all — a separate, pre-existing NaPTAN gap,
 * 11 stations total, mostly Elizabeth line entries), 2/14 correctly
 * rejected (no station-typed result available), 0 wrong.
 *
 * Run:
 *   node scripts/fetch-station-addresses-google.mjs
 *
 * Requires GOOGLE_MAPS_API_KEY (Geocoding API enabled on that key/project)
 * — loaded from a local .env file, gitignored, never committed.
 *
 * FIELD OWNERSHIP: shares `location` with scripts/fetch-wikipedia-facts.mjs
 * and scripts/fetch-station-addresses.mjs (OSM). Precedence: only ever
 * writes `location` when the entry doesn't already have one — this is the
 * last-resort fallback in the chain (OSM full address > Wikipedia infobox
 * location > this), never overwrites either of the earlier two.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');
const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');
const ENV_PATH = path.join(ROOT, '.env');

function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GEOCODE_API = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_DELAY_MS = 150;
const STATION_TYPES = new Set(['train_station', 'transit_station']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function reverseGeocode(lat, lon) {
  const url = `${GEOCODE_API}?latlng=${lat},${lon}&key=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') return { error: data.status + (data.error_message ? `: ${data.error_message}` : '') };
  return { results: data.results || [] };
}

// First result (in Google's own ranking order) that carries a station-type
// tag — NOT necessarily results[0]. See header comment for why this
// matters (the correct result is sometimes ranked below a nearby address).
function pickStationResult(results) {
  return results.find((r) => r.types && r.types.some((t) => STATION_TYPES.has(t))) || null;
}

async function processStation(crs, name, lat, lon, content, report) {
  const entry = content[crs];
  if (!entry) {
    report.push({ crs, status: 'not-found' });
    return;
  }
  if (entry.location) {
    console.log(`  ${crs}: already has a location — skipped`);
    report.push({ crs, status: 'skipped-already-set' });
    return;
  }
  if (lat == null || lon == null) {
    console.log(`  ${crs}: no coordinates in station-list.json — skipped`);
    report.push({ crs, status: 'no-coordinates' });
    return;
  }

  const { results, error } = await reverseGeocode(lat, lon);
  await sleep(REQUEST_DELAY_MS);
  if (error) {
    console.log(`  ${crs}: geocode error — ${error}`);
    report.push({ crs, status: 'error', message: error });
    return;
  }
  const match = pickStationResult(results || []);
  if (!match) {
    console.log(`  ${crs}: no train_station/transit_station-typed result — left "Not available" rather than guess`);
    report.push({ crs, status: 'no-confident-match' });
    return;
  }

  content[crs].location = match.formatted_address;
  content[crs]._osm = content[crs]._osm || {};
  content[crs]._osm.locationSource = 'google-geocoding-api';
  console.log(`  ${crs}: location set — ${match.formatted_address}`);
  report.push({ crs, status: 'ok', address: match.formatted_address });
}

async function main() {
  if (!API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY not set — check .env');
  }
  const content = loadJson(STATIONS_PATH);
  const stations = loadJson(STATION_LIST_PATH);
  const byCrs = new Map(stations.map((s) => [s.crs, s]));
  const keys = Object.keys(content).filter((k) => k !== '_notes' && !content[k].location);
  const report = [];
  console.log(`Checking Google Geocoding fallback for ${keys.length} stations with no location...`);
  let processed = 0;
  for (const crs of keys) {
    const s = byCrs.get(crs);
    try {
      await processStation(crs, s ? s.name : crs, s ? s.lat : null, s ? s.lon : null, content, report);
    } catch (err) {
      console.error(`  ${crs}: FAILED — ${err.message}`);
      report.push({ crs, status: 'error', message: err.message });
    }
    processed++;
    if (processed % 50 === 0) {
      saveJson(STATIONS_PATH, content);
      console.log(`  ${processed}/${keys.length} processed (checkpoint saved)`);
    }
  }
  saveJson(STATIONS_PATH, content);

  console.log('\n=== Done ===');
  const byStatus = {};
  for (const r of report) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(JSON.stringify(byStatus, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

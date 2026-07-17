#!/usr/bin/env node
/**
 * scripts/fetch-station-place-ids.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Upgrades the station panel's "Google Map" link from a raw lat/lon query
 * (https://www.google.com/maps/search/?api=1&query=lat,lon) to a place_id
 * deep link (https://www.google.com/maps/place/?q=place_id:{id}) — Google
 * Places API (New) Text Search, "IDs Only" field mask (places.id only —
 * confirmed free/Essentials tier, see header of
 * scripts/fetch-station-addresses-google.mjs for the sibling Geocoding
 * script's cost-tier research; Places (New)'s own Essentials/Pro field
 * split was re-confirmed 2026-07-17: places.id/places.name/
 * places.attributions/nextPageToken are Essentials-free, EVERYTHING else —
 * including places.location and places.types — is Pro ($32/1,000), so
 * there is no cheap way to fetch a verification field alongside the id).
 *
 * MATCH STRATEGY (why results[0] is trusted without a type/location check):
 * station-list.json's `name` field already carries a "Rail Station" suffix
 * (e.g. "Manchester Piccadilly Rail Station"), so the query text itself
 * names the station precisely — this is a materially different situation
 * from fetch-station-addresses-google.mjs's reverse-geocode case, which
 * only had lat/lon and no name to search by. A 15-station spot-check run
 * 2026-07-17 with a temporary richer field mask (places.id + displayName +
 * location + types, Pro tier, ONLY for this one-off verification — the
 * production run below never requests these) confirmed: with the station
 * name in the query text AND a tight locationBias circle around its known
 * coordinates, results[0] was the geographically- and name-correct station
 * in 15/15 cases, including deliberately-ambiguous names (Bentley (Hants)
 * vs Bentley (S Yorks), Richmond (London) vs the many other Richmonds,
 * Victoria, Stirling). The one edge case found (BYK / Bentley South
 * Yorkshire) had a duplicate DB listing without a train_station type tag
 * ranked first, but it was still the geographically-correct place (a
 * Google-side duplicate-listing quirk, not a wrong match) — so no type
 * filter is needed or possible here anyway, given the Pro-tier cost of
 * fetching `types` at all. A response with zero results is left alone
 * ("no-match", skip rather than guess) rather than falling back to a
 * looser query.
 *
 * Run:
 *   node scripts/fetch-station-place-ids.mjs
 *
 * Requires GOOGLE_MAPS_API_KEY (Places API enabled on that key/project) —
 * loaded from a local .env file, gitignored, never committed.
 *
 * FIELD OWNERSHIP: writes stations-content.json's `_google.placeId` (new
 * field — does not touch `location`, which is fetch-station-addresses.mjs
 * (OSM) / fetch-wikipedia-facts.mjs / fetch-station-addresses-google.mjs's
 * territory). Idempotent: skips any station that already has
 * `_google.placeId` set, so reruns only fill in new/previously-failed
 * stations. map.html's dbBottomLinksHtml() reads this field to build the
 * Google Map link, falling back to the coords-based query link when absent
 * — see that function for the render-time logic.
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
const TEXT_SEARCH_API = 'https://places.googleapis.com/v1/places:searchText';
const REQUEST_DELAY_MS = 150;
const BIAS_RADIUS_M = 500.0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function textSearchId(name, lat, lon) {
  const body = {
    textQuery: `${name} UK`,
    locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: BIAS_RADIUS_M } },
  };
  const res = await fetch(TEXT_SEARCH_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'places.id',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = await res.json();
  return { places: data.places || [] };
}

async function processStation(crs, name, lat, lon, content, report) {
  const entry = content[crs];
  if (!entry) {
    report.push({ crs, status: 'not-found' });
    return;
  }
  if (entry._google && entry._google.placeId) {
    console.log(`  ${crs}: already has a placeId — skipped`);
    report.push({ crs, status: 'skipped-already-set' });
    return;
  }
  if (lat == null || lon == null) {
    console.log(`  ${crs}: no coordinates in station-list.json — skipped`);
    report.push({ crs, status: 'no-coordinates' });
    return;
  }

  const { places, error } = await textSearchId(name, lat, lon);
  await sleep(REQUEST_DELAY_MS);
  if (error) {
    console.log(`  ${crs}: places error — ${error}`);
    report.push({ crs, status: 'error', message: error });
    return;
  }
  if (!places.length) {
    console.log(`  ${crs}: no Text Search result — left without a placeId rather than guess`);
    report.push({ crs, status: 'no-match' });
    return;
  }

  const placeId = places[0].id;
  content[crs]._google = { placeId, fetched_at: new Date().toISOString() };
  console.log(`  ${crs}: placeId set — ${placeId}`);
  report.push({ crs, status: 'ok', placeId });
}

async function main() {
  if (!API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY not set — check .env');
  }
  const content = loadJson(STATIONS_PATH);
  const stations = loadJson(STATION_LIST_PATH);
  const byCrs = new Map(stations.map((s) => [s.crs, s]));
  const keys = Object.keys(content).filter((k) => k !== '_notes');
  const report = [];
  console.log(`Fetching Google Place IDs for ${keys.length} stations...`);
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

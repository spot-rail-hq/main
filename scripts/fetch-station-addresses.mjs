#!/usr/bin/env node
/**
 * scripts/fetch-station-addresses.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates stations-content.json's `location` field with a REAL postal
 * address when one is available — deterministic, no AI (matches scripts/
 * fetch-osm-facts.mjs's discipline): reads addr:housenumber/addr:street/
 * addr:city/addr:postcode directly off the station's OWN OSM node (the
 * node_id every station already has captured in `_osm.node_id` from
 * fetch-osm-facts.mjs's earlier run — no new OSM query type needed, just
 * reading tags that were already being fetched anyway).
 *
 * Why this instead of reverse-geocoding from lat/lon: confirmed live
 * (2026-07-18 investigation) that blind reverse-geocoding has a real
 * accuracy risk — Nominatim returned "Philip Larkin" (an unrelated nearby
 * landmark) for Coventry's coordinates, not the station. Reading the
 * address directly off the station's OWN tagged node has no such
 * ambiguity — if OSM has it, it's tagged ON the station, not inferred from
 * proximity. Coverage tradeoff: only ~20% of stations have a full
 * (street+postcode) address tagged this way (confirmed via a 25-station
 * random sample) — Manchester Piccadilly, one of the country's busiest
 * stations, has none. A Google Maps Geocoding fallback for the remainder
 * is a separate, not-yet-built follow-up (needs a new API key + billing
 * setup — see the cost/feasibility research in this session).
 *
 * Precedence: an OSM full address (street + postcode, at minimum) is
 * PREFERRED over whatever fetch-wikipedia-facts.mjs already put in
 * `location` (Wikipedia's infobox location is often just "Town, County,
 * England" — much less useful than a real address) — see buildAddress()'s
 * "full" check. A PARTIAL OSM address (only one of street/postcode) is NOT
 * used — better to keep the existing Wikipedia-derived value (or leave
 * absent) than show a half-formed address.
 *
 * Run:
 *   node scripts/fetch-station-addresses.mjs
 *
 * FIELD OWNERSHIP: shares `location` with scripts/fetch-wikipedia-facts.mjs
 * (see that script's STATION_FIELD_SPECS.location) — this script only ever
 * overwrites `location` when it has a full OSM address to offer, and only
 * ever overwrites a PRIOR value this same script wrote (tracked via
 * `_osm.locationSource === 'osm-addr-tags'`), never a human-curated one set
 * some other way. See stations-content.json's `_notes` for the full
 * precedence rule as written up for future maintainers.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');

const OSM_API = 'https://api.openstreetmap.org/api/0.6/node';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';
const REQUEST_DELAY_MS = 250; // osm.org's main API, not Overpass — light pacing, this is a read-only GET per node

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function fetchNodeTags(nodeId) {
  const url = `${OSM_API}/${nodeId}.json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const el = data.elements && data.elements[0];
  return el ? el.tags || {} : null;
}

// Only returns an address when street+postcode are BOTH present — a
// partial address (just a postcode, or just a city) is worse than useless
// (looks complete but isn't), so it's treated the same as "no address"
// rather than shown half-formed.
function buildAddress(tags) {
  if (!tags) return null;
  const street = tags['addr:street'];
  const postcode = tags['addr:postcode'];
  if (!street || !postcode) return null;
  const houseNumber = tags['addr:housenumber'];
  const city = tags['addr:city'];
  const streetPart = houseNumber ? `${houseNumber} ${street}` : street;
  const parts = [streetPart, city, postcode].filter(Boolean);
  return parts.join(', ');
}

async function processStation(crs, content, report) {
  const entry = content[crs];
  if (!entry) {
    report.push({ crs, status: 'not-found' });
    return;
  }
  const nodeId = entry._osm && entry._osm.node_id;
  if (!nodeId) {
    console.log(`  ${crs}: no OSM node_id captured — skipped`);
    report.push({ crs, status: 'no-node-id' });
    return;
  }
  // Never overwrite a location this script didn't itself write — a
  // Wikipedia-derived or human-curated value stays untouched unless THIS
  // script already set it on a prior run (tracked via locationSource, so a
  // re-run can safely refresh it without silently clobbering curation).
  const alreadyOsmSourced = entry._osm && entry._osm.locationSource === 'osm-addr-tags';
  if (entry.location && !alreadyOsmSourced) {
    console.log(`  ${crs}: already has a location from another source — left untouched`);
    report.push({ crs, status: 'skipped-other-source' });
    return;
  }

  const tags = await fetchNodeTags(nodeId);
  await sleep(REQUEST_DELAY_MS);
  const address = buildAddress(tags);
  if (!address) {
    console.log(`  ${crs}: OSM node has no full (street+postcode) address`);
    report.push({ crs, status: 'no-full-address' });
    return;
  }

  content[crs].location = address;
  content[crs]._osm.locationSource = 'osm-addr-tags';
  console.log(`  ${crs}: location set — ${address}`);
  report.push({ crs, status: 'ok', address });
}

async function main() {
  const content = loadJson(STATIONS_PATH);
  const keys = Object.keys(content).filter((k) => k !== '_notes');
  const report = [];
  console.log(`Checking OSM address tags for ${keys.length} stations...`);
  let processed = 0;
  for (const crs of keys) {
    try {
      await processStation(crs, content, report);
    } catch (err) {
      console.error(`  ${crs}: FAILED — ${err.message}`);
      report.push({ crs, status: 'error', message: err.message });
    }
    processed++;
    if (processed % 100 === 0) {
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

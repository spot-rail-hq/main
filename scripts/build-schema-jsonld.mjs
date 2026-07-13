#!/usr/bin/env node
/**
 * scripts/build-schema-jsonld.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Builds a schema.org JSON-LD object per entity and stores it as the
 * `schema_jsonld` field in stations-content.json / routes-content.json /
 * operators-content.json. Pure template assembly from facts the OTHER two
 * scripts already collected — no network calls, no AI, nothing new is
 * "found" here, so this is safe and cheap to re-run every time, after
 * fetch-osm-facts.mjs and/or fetch-wikipedia-facts.mjs:
 *
 *   node scripts/build-schema-jsonld.mjs
 *
 * ─── FIELD OWNERSHIP ───────────────────────────────────────────────────
 * This script is the ONLY writer of `schema_jsonld` on all three files. It
 * only ever reads every other field — never writes platforms/wheelchair/
 * operators/length_km/stopping_stations/type/operator (fetch-osm-facts.mjs),
 * headline/opened_year/notable_features/operating_since/parent_company/
 * franchises (fetch-wikipedia-facts.mjs), or any manual/curated field. See
 * those two scripts' headers for their own owned-fields lists.
 *
 * ─── WHY schema_jsonld IS PRECOMPUTED, NOT BUILT AT RENDER TIME ──────────
 * map.html injects this object verbatim into a <script type="application/
 * ld+json"> tag when a station/route/operator is selected (Task 3) — see
 * injectSchemaJsonLd() there. Precomputing it here keeps that render-time
 * code to a single JSON.stringify() call with no schema.org vocabulary
 * knowledge baked into the client, and means every entity gets the same
 * template logic regardless of which UI eventually reads it.
 *
 * ─── TYPE CHOICES (documented since schema.org's transit vocabulary is
 * genuinely inconsistent) ──────────────────────────────────────────────
 * - Stations → TrainStation: stable, fully-ratified core schema.org type
 *   (subtype of CivicStructure). Safe bet.
 * - Routes → Route: this type lives in schema.org's "pending" extension
 *   namespace, not the ratified core vocabulary — coverage among real
 *   consumers varies. It's the closest applicable type schema.org has for
 *   "a railway line as a whole" (as opposed to TrainTrip, which models one
 *   scheduled journey, not an ongoing line), and JSON-LD consumers are
 *   built to ignore unrecognised @type values rather than error, so there's
 *   no downside to using it — just no guarantee every crawler treats it
 *   specially yet. Flagged here rather than presented as a clean fit.
 * - Operators → Organization: stable, fully-ratified core schema.org type.
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');
const ROUTES_PATH = path.join(ROOT, 'routes-content.json');
const OPERATORS_PATH = path.join(ROOT, 'operators-content.json');
const STATION_LIST_PATH = path.join(ROOT, 'station-list.json');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function buildStationJsonLd(crs, entry, stationList) {
  const listing = stationList.find((s) => s.crs === crs);
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'TrainStation',
    name: entry.name || (listing && listing.name) || crs,
    identifier: crs,
  };
  if (listing && listing.lat != null && listing.lon != null) {
    jsonld.geo = { '@type': 'GeoCoordinates', latitude: listing.lat, longitude: listing.lon };
  }
  if (entry.location) {
    jsonld.address = { '@type': 'PostalAddress', addressLocality: entry.location, addressCountry: 'GB' };
  }
  return jsonld;
}

function buildRouteJsonLd(slug, entry) {
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Route', // see header comment — pending-namespace type, closest applicable, not fully ratified
    name: entry.name || slug,
  };
  if (entry.length_km != null) {
    jsonld.distance = { '@type': 'QuantitativeValue', value: entry.length_km, unitCode: 'KMT' }; // KMT = UN/CEFACT code for kilometre
  }
  if (entry.operator) {
    jsonld.provider = { '@type': 'Organization', name: entry.operator };
  }
  return jsonld;
}

function buildOperatorJsonLd(code, entry) {
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: entry.name || code,
  };
  if (entry.parent_company) {
    jsonld.parentOrganization = { '@type': 'Organization', name: entry.parent_company };
  }
  if (entry.regions_served) {
    const regions = (entry.regions_served.main || []).concat(entry.regions_served.other || []);
    if (regions.length) jsonld.areaServed = regions;
  }
  return jsonld;
}

function main() {
  const stationList = loadJson(STATION_LIST_PATH);

  const stations = loadJson(STATIONS_PATH);
  for (const [crs, entry] of Object.entries(stations)) {
    if (crs === '_notes') continue;
    stations[crs].schema_jsonld = buildStationJsonLd(crs, entry, stationList);
  }
  saveJson(STATIONS_PATH, stations);

  const routes = loadJson(ROUTES_PATH);
  for (const [slug, entry] of Object.entries(routes)) {
    if (slug === '_notes') continue;
    routes[slug].schema_jsonld = buildRouteJsonLd(slug, entry);
  }
  saveJson(ROUTES_PATH, routes);

  const operators = loadJson(OPERATORS_PATH);
  for (const [code, entry] of Object.entries(operators)) {
    if (code === '_notes') continue;
    operators[code].schema_jsonld = buildOperatorJsonLd(code, entry);
  }
  saveJson(OPERATORS_PATH, operators);

  console.log(`Built schema_jsonld for ${Object.keys(stations).length - 1} station(s), ${Object.keys(routes).length - 1} route(s), ${Object.keys(operators).length - 1} operator(s).`);
}

main();

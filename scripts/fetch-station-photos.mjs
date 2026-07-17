#!/usr/bin/env node
/**
 * scripts/fetch-station-photos.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates stations-content.json's `photo` field — deterministic, no AI
 * (matches scripts/fetch-osm-facts.mjs's discipline, not scripts/fetch-
 * wikipedia-facts.mjs's Claude-extraction one — this is pure lookup, no
 * judgment call for an LLM to make): Wikipedia's REST summary endpoint for
 * the article's lead image, then Wikimedia Commons' imageinfo API
 * (iiprop=extmetadata) for the real photographer/license/source
 * attribution behind it.
 *
 * Run:
 *   node scripts/fetch-station-photos.mjs
 *
 * Only ever touches an entry that already has wikipedia_title set — same
 * precondition discipline as fetch-wikipedia-facts.mjs, never guesses a
 * title itself. Never overwrites an existing `photo` (human-set or from a
 * prior run of this script).
 *
 * ─── FIELD OWNERSHIP ────────────────────────────────────────────────────
 * This script is the ONLY writer for stations-content.json's `photo`
 * field. Previously documented as "manual/curated only" — updated
 * 2026-07-17, this script supersedes that: it can now auto-populate photo
 * for any station with a wikipedia_title and a usable lead image, but a
 * human-set photo (however it got there) is always left untouched, same
 * "never overwrite curated data" discipline as every other script here.
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'stations-content.json');

const REST_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';
const REQUEST_DELAY_MS = 200;

// ─── Jobs to run this pass — edit this, then re-run ──────────────────────
// 2026-07-17: COV + VIC, specifically requested as the panel-template demo
// samples (COV to test whether a "stub-tier" station — reclassified purely
// by extract-LENGTH, see scripts/scope-wikipedia-coverage.mjs's
// STUB_THRESHOLD_CHARS — can still yield a usable photo even though it
// never went through the Claude headline/notable_features extraction;
// confirmed live: yes, a real lead image with full Commons attribution
// exists for Coventry railway station regardless of its stub tier).
const JOBS = ['COV', 'VIC'];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}
function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').trim();
}

// Extracts the Commons filename from a thumb/original image URL, e.g.
// ".../commons/thumb/9/91/Coventry_railway_station_(new)_2022-10-12.jpg/330px-...jpg"
// -> "Coventry_railway_station_(new)_2022-10-12.jpg"
function extractCommonsFilename(url) {
  const m = url.match(/\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+?)(?:\/\d+px-[^/]+)?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Known external platforms whose Commons "Credit" field is a bare URL to
// that platform rather than a plain name or "Own work" — mapped to a
// human-readable source name for the credit line. NOT exhaustive — any
// URL not matched here falls back to "Wikimedia Commons" with the Commons
// file description page as sourceUrl, which is always safe/correct, just
// less specific than naming the actual originating platform.
const KNOWN_PLATFORMS = [
  { pattern: /flickr\.com/i, name: 'Flickr' },
  { pattern: /geograph\.org\.uk|geograph\.co\.uk/i, name: 'Geograph Britain and Ireland' },
  { pattern: /geograph\.ie/i, name: 'Geograph Ireland' },
  { pattern: /panoramio\.com/i, name: 'Panoramio' },
  { pattern: /instagram\.com/i, name: 'Instagram' },
];

async function fetchSummary(title) {
  const url = REST_SUMMARY_API + encodeURIComponent(title.replace(/ /g, '_'));
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return null;
  return res.json();
}

async function fetchImageInfo(filename) {
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent('File:' + filename)}&prop=imageinfo&iiprop=extmetadata|url&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const page = Object.values(data.query.pages)[0];
  return page.imageinfo ? page.imageinfo[0] : null;
}

// Builds {photographer, source, license, sourceUrl} from Commons
// extmetadata — returns null if photographer or license can't be
// confidently determined (never partial/guessed attribution; matches
// map.html's dbPhotoCreditHtml(), which requires photographer+source+
// license all present or renders nothing).
function buildAttribution(info) {
  const em = info.extmetadata;
  if (!em) return null;
  const photographer = stripTags(em.Artist && em.Artist.value);
  const license = em.LicenseShortName && em.LicenseShortName.value;
  if (!photographer || !license) return null;

  const creditRaw = stripTags(em.Credit && em.Credit.value);
  let source;
  let sourceUrl = info.descriptionurl;
  if (/^https?:\/\//i.test(creditRaw)) {
    const platform = KNOWN_PLATFORMS.find((p) => p.pattern.test(creditRaw));
    source = platform ? platform.name : 'Wikimedia Commons';
    sourceUrl = platform ? creditRaw : info.descriptionurl;
  } else if (creditRaw && !/^own work$/i.test(creditRaw)) {
    source = creditRaw; // a named platform Commons states directly, e.g. "Geograph Britain and Ireland"
  } else {
    source = 'Wikimedia Commons'; // "Own work" or empty Credit — uploader is the photographer, no separate platform
  }
  return { photographer, source, license, sourceUrl };
}

async function processStation(crs, content, report) {
  const entry = content[crs];
  if (!entry) {
    console.log(`  ${crs}: not found in stations-content.json — skipped`);
    report.push({ crs, status: 'not-found' });
    return;
  }
  if (entry.photo && entry.photo.url) {
    console.log(`  ${crs}: already has a photo — skipped (never overwrites)`);
    report.push({ crs, status: 'skipped-already-set' });
    return;
  }
  const title = entry.wikipedia_title;
  if (!title) {
    console.log(`  ${crs}: no wikipedia_title set — skipped, nothing to fetch an image for (never guesses one)`);
    report.push({ crs, status: 'no-title' });
    return;
  }

  const summary = await fetchSummary(title);
  await sleep(REQUEST_DELAY_MS);
  const imageUrl = summary && (summary.originalimage || summary.thumbnail);
  if (!imageUrl) {
    console.log(`  ${crs}: "${title}" has no lead image on Wikipedia`);
    report.push({ crs, status: 'no-image' });
    return;
  }

  const filename = extractCommonsFilename(imageUrl.source);
  if (!filename) {
    console.log(`  ${crs}: found an image but couldn't parse its Commons filename from the URL (${imageUrl.source}) — skipped rather than guess`);
    report.push({ crs, status: 'filename-parse-failed', url: imageUrl.source });
    return;
  }

  const info = await fetchImageInfo(filename);
  await sleep(REQUEST_DELAY_MS);
  if (!info) {
    console.log(`  ${crs}: "${filename}" — Commons imageinfo lookup failed`);
    report.push({ crs, status: 'imageinfo-failed', filename });
    return;
  }

  const attribution = buildAttribution(info);
  if (!attribution) {
    console.log(`  ${crs}: "${filename}" — couldn't confidently determine photographer/license from Commons metadata — skipped rather than show incomplete attribution`);
    report.push({ crs, status: 'attribution-incomplete', filename });
    return;
  }

  content[crs].photo = {
    url: imageUrl.source,
    photographer: attribution.photographer,
    source: attribution.source,
    license: attribution.license,
    sourceUrl: attribution.sourceUrl,
  };
  console.log(`  ${crs}: photo set — ${attribution.photographer} – ${attribution.source} – ${attribution.license}`);
  report.push({ crs, status: 'ok' });
}

async function main() {
  const content = loadJson(STATIONS_PATH);
  const report = [];
  console.log(`Fetching photos for ${JOBS.length} station(s)...`);
  for (const crs of JOBS) {
    try {
      await processStation(crs, content, report);
    } catch (err) {
      console.error(`  ${crs}: FAILED — ${err.message}`);
      report.push({ crs, status: 'error', message: err.message });
    }
    saveJson(STATIONS_PATH, content); // incremental save, same discipline as fetch-wikipedia-facts.mjs
  }
  console.log('\n=== Done ===');
  const byStatus = {};
  for (const r of report) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(JSON.stringify(byStatus, null, 2));
}

// Guard against accidental execution on import — same live incident this
// protected against in fetch-wikipedia-facts.mjs applies here too.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

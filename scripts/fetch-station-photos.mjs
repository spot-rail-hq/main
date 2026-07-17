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
// 2026-07-17: COV + VIC were the initial panel-template demo samples (COV
// to test whether a "stub-tier" station — reclassified purely by extract-
// LENGTH, see scripts/scope-wikipedia-coverage.mjs's STUB_THRESHOLD_CHARS —
// can still yield a usable photo even though it never went through the
// Claude headline/notable_features extraction; confirmed live: yes, a real
// lead image with full Commons attribution exists for Coventry railway
// station regardless of its stub tier). Same day: promoted to a full-batch
// run across every station with a wikipedia_title, once the demo confirmed
// the pipeline was sound — JOBS is now computed at run time in main()
// rather than hardcoded to those two.
const JOBS = null; // null = full batch (every station with a wikipedia_title); set an array to restrict a run.

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

// Commons' Artist field is free text an uploader can put anything in — two
// confirmed-live quirks worth cleaning rather than displaying verbatim: (1)
// a profile URL appended as plain link text after the name (e.g. "Ed Webster
// https://www.flickr.com/photos/ed_webster" on Stratford_International_
// 7859960534.jpg); (2) leftover copyright boilerplate copied from the
// original source page that CONTRADICTS the license Commons actually applies
// (e.g. "2009 Roger Marks - All rights reserved." on an image whose
// LicenseShortName is CC BY-SA 4.0 — Commons' own license field is what
// governs reuse, not this free-text field, so showing "All rights reserved"
// next to a CC BY-SA credit would actively mislead a reader).
function cleanPhotographerName(raw) {
  let name = stripTags(raw);
  name = name.replace(/https?:\/\/\S+/gi, '').trim();
  name = name.replace(/[-–—,]?\s*all rights reserved\.?\s*$/i, '').trim();
  name = name.replace(/^\d{4}\s+/, '').trim();
  return name;
}

// Commons' extmetadata Credit field is HTML, typically an <a class="external
// ..." href="...">visible label</a> — the visible label varies a lot by
// uploader/bot (e.g. Geograph credits render as "geograph.org.uk", "Geograph
// Britain and Ireland", or "From geograph.org.uk"; a bare URL in the source
// wikitext gets MediaWiki's auto-link class "external free" instead of the
// "external text" used for [url label]-style markup — confirmed live via a
// Sittingbourne/Flickr photo whose Credit was literally a linked bare URL),
// so matching KNOWN_PLATFORMS against the post-stripTags *text* is
// unreliable, and even matching only "external text" isn't broad enough.
// Pull the href from ANY `class="external ..."` anchor instead — stable
// regardless of label wording or link subclass — and match platforms
// against that. Deliberately requires the "external" class (not just any
// href) so it skips the unrelated "Edit this at Structured Data on Commons"
// icon link that's often appended to the same field.
function extractExternalHref(html) {
  if (!html) return null;
  const m = html.match(/class="external \S+"[^>]*href="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*class="external \S+"/);
  return m ? m[1] : null;
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
  // chiark.greenend.org.uk/~owend is a personal UK-railway-station photo
  // gallery Commons cites often enough (~30 stations in the first full
  // batch, 2026-07-17) to name directly rather than fall back to the
  // generic "Wikimedia Commons" label for all of them; no cleaner
  // human/site title is reliably available, so the bare domain is used as
  // the name, same convention Commons' own uploader tools use for it.
  { pattern: /chiark\.greenend\.org\.uk/i, name: 'chiark.greenend.org.uk' },
  { pattern: /wyrdlight\.com/i, name: 'wyrdlight.com' },
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
  const photographer = cleanPhotographerName(em.Artist && em.Artist.value);
  const license = em.LicenseShortName && em.LicenseShortName.value;
  if (!photographer || !license) return null;

  const creditHtml = em.Credit && em.Credit.value;
  let creditHref = extractExternalHref(creditHtml);
  // A few Commons uploads carry an unsubstituted wikitext template left in
  // the URL itself (confirmed live: Causelandplat.jpg's Credit href ends in
  // "%7B%7B%7BSource%7D%7D%7D", i.e. a literal, never-filled-in "{{{Source}}}"
  // — the link 404s). Treat that as no href at all rather than link to a
  // known-broken URL.
  if (creditHref && /%7B%7B%7B|\{\{\{/i.test(creditHref)) creditHref = null;
  const creditText = stripTags(creditHtml);
  let source;
  let sourceUrl = info.descriptionurl;
  if (creditHref) {
    const platform = KNOWN_PLATFORMS.find((p) => p.pattern.test(creditHref));
    if (platform) {
      source = platform.name;
      sourceUrl = creditHref; // the actual Flickr/Geograph/etc photo page, not just the Commons file page
    } else if (creditText && !/^own work$/i.test(creditText) && !/https?:\/\//i.test(creditText)) {
      source = creditText; // an external link Commons has, but not one of our known platforms — use its visible label
    } else {
      source = 'Wikimedia Commons';
      sourceUrl = creditHref; // still a real, more-specific link even without a friendly platform name
    }
  } else if (creditText && !/^own work$/i.test(creditText) && !/https?:\/\//i.test(creditText)) {
    source = creditText; // a named platform Commons states directly as plain text, e.g. "Geograph Britain and Ireland"
  } else {
    source = 'Wikimedia Commons'; // "Own work" or empty/broken Credit — uploader is the photographer, no separate platform
  }
  // Final safety net: a bare URL must never render as the human-readable
  // source label (map.html prints `source` as plain text, not a link) — if
  // every branch above still produced one (an edge case none of the others
  // caught), fall back to the always-safe generic label rather than show it.
  if (/https?:\/\//i.test(source)) {
    source = 'Wikimedia Commons';
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
  const jobs = JOBS || Object.keys(content).filter((k) => k !== '_notes');
  const report = [];
  console.log(`Fetching photos for ${jobs.length} station(s)...`);
  let processed = 0;
  for (const crs of jobs) {
    try {
      await processStation(crs, content, report);
    } catch (err) {
      console.error(`  ${crs}: FAILED — ${err.message}`);
      report.push({ crs, status: 'error', message: err.message });
    }
    processed++;
    if (processed % 50 === 0) {
      saveJson(STATIONS_PATH, content);
      console.log(`  ${processed}/${jobs.length} processed (checkpoint saved)`);
    }
  }
  saveJson(STATIONS_PATH, content);
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

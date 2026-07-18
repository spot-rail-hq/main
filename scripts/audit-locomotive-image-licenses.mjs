#!/usr/bin/env node
/**
 * scripts/audit-locomotive-image-licenses.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Read-only audit — does not modify data/rolling-stock.json or database.html.
 *
 * database.html's TrainImage() component fetches a locomotive class's image
 * LIVE, client-side, via Wikipedia's REST summary API
 * (en.wikipedia.org/api/rest_v1/page/summary/{title}), using whatever the
 * article's current lead image happens to be — unlike the station photo
 * pipeline (scripts/fetch-station-photos.mjs), this path never checks
 * whether that image is actually free-reuse licensed. Wikipedia articles are
 * allowed to embed "non-free"/fair-use images (current press photos, logos,
 * etc.) directly in English Wikipedia's own local file namespace — Commons
 * never accepts non-free content at all, so a lead image NOT hosted on
 * Commons is, by that split alone, essentially always non-free/fair-use,
 * and fair-use does not extend to reuse on a third-party commercial site
 * like srhq.uk.
 *
 * This script re-derives each class's Wikipedia title exactly the way
 * database.html's deriveWikiTitle() does (same regex, same "Category:" URL
 * in data/rolling-stock.json's Wikimedia Image column), fetches the same
 * REST summary the live page would show, and classifies the result:
 *   - image URL contains "/wikipedia/commons/" -> Commons-hosted -> queries
 *     Commons' own imageinfo API for the real license (same technique as
 *     fetch-station-photos.mjs) to confirm it's actually free-reuse (CC BY/
 *     BY-SA/CC0/PD), not just assume "on Commons = fine"
 *   - image URL contains "/wikipedia/en/" (or any other non-commons wiki
 *     project host) -> non-free/fair-use, flagged for removal
 *   - no image at all -> nothing to flag
 *
 * Run:
 *   node scripts/audit-locomotive-image-licenses.mjs
 *
 * Writes scripts/output/locomotive-image-license-audit.json — the full
 * per-class report. Does NOT touch data/rolling-stock.json or any rendering
 * code; removal (if any) is a deliberate separate step after review.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROLLING_STOCK_PATH = path.join(ROOT, 'data', 'rolling-stock.json');
const OUTPUT_PATH = path.join(__dirname, 'output', 'locomotive-image-license-audit.json');

const REST_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; audit script, not a live API dependency)';
const REQUEST_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Exactly database.html's deriveWikiTitle() — same regex, same assumption
// that the Wikipedia article title matches the Commons category name.
function deriveWikiTitle(commonsUrl) {
  if (!commonsUrl) return null;
  const m = String(commonsUrl).match(/Category:([^?#]+)$/);
  return m ? m[1] : null;
}

function extractRows() {
  const data = JSON.parse(readFileSync(ROLLING_STOCK_PATH, 'utf8'));
  const categories = Object.keys(data).filter((k) => k !== 'Legend');
  const rows = [];
  for (const cat of categories) {
    for (const row of data[cat]) {
      if (row[9] && /commons\.wikimedia\.org/i.test(row[9])) {
        rows.push({ category: cat, cls: row[0], name: row[1], commonsUrl: row[9] });
      }
    }
  }
  return rows;
}

async function fetchSummary(title) {
  const url = REST_SUMMARY_API + encodeURIComponent(title.replace(/ /g, '_'));
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return { data: await res.json() };
}

// Grabs the original filename segment right after the two hex-hash dirs —
// deliberately not anchored to a specific thumbnail-suffix shape at the end,
// since that varies (plain "330px-Name.jpg" for most files, but e.g.
// "lossy-page1-330px-Name.tif.jpg" for .tif-sourced scans — confirmed live
// on 70013/92212's images, which the previous stricter regex failed to
// match at all, leaving their license unresolved).
function extractCommonsFilename(url) {
  const m = url.match(/\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function fetchCommonsLicense(filename) {
  const url = `${COMMONS_API}?action=query&titles=${encodeURIComponent('File:' + filename)}&prop=imageinfo&iiprop=extmetadata&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const page = Object.values(data.query.pages)[0];
  const info = page.imageinfo && page.imageinfo[0];
  if (!info || !info.extmetadata) return null;
  return info.extmetadata.LicenseShortName ? info.extmetadata.LicenseShortName.value : null;
}

async function auditRow(row) {
  const title = deriveWikiTitle(row.commonsUrl);
  if (!title) {
    return { ...row, wikiTitle: null, imageUrl: null, license: null, action: 'keep', reason: 'no derivable Wikipedia title — TrainImage() would show "no image available" (nothing to flag)' };
  }
  const { data: summary, error } = await fetchSummary(title);
  await sleep(REQUEST_DELAY_MS);
  if (error) {
    return { ...row, wikiTitle: title, imageUrl: null, license: null, action: 'keep', reason: `summary fetch failed (${error}) — TrainImage() would show "no image available"` };
  }
  const imageUrl = (summary.thumbnail && summary.thumbnail.source) || (summary.originalimage && summary.originalimage.source) || null;
  if (!imageUrl) {
    return { ...row, wikiTitle: title, imageUrl: null, license: null, action: 'keep', reason: 'article has no lead image — TrainImage() would show "no image available"' };
  }

  if (/\/wikipedia\/commons\//i.test(imageUrl)) {
    const filename = extractCommonsFilename(imageUrl);
    let license = null;
    if (filename) {
      license = await fetchCommonsLicense(filename);
      await sleep(REQUEST_DELAY_MS);
    }
    const isFree = license && /^(cc0|cc by|cc by-sa|public domain|pdm)/i.test(license);
    return {
      ...row,
      wikiTitle: title,
      imageUrl,
      license: license || '(Commons-hosted, license lookup failed)',
      action: isFree ? 'keep' : 'REVIEW',
      reason: isFree ? 'Commons-hosted, confirmed free-reuse license' : 'Commons-hosted but license could not be confirmed as free-reuse — needs manual check',
    };
  }

  // Not on Commons at all -> local to some Wikipedia project (almost always
  // en.wikipedia.org's own /wikipedia/en/ non-free namespace) -> fair-use.
  return {
    ...row,
    wikiTitle: title,
    imageUrl,
    license: 'non-free (Wikipedia fair-use, not on Commons)',
    action: 'REMOVE',
    reason: 'image is hosted outside Wikimedia Commons — Commons never accepts non-free content, so this is fair-use content valid only for Wikipedia’s own encyclopedic use, not reusable on a third-party commercial site',
  };
}

async function main() {
  const rows = extractRows();
  console.log(`Auditing ${rows.length} locomotive class image(s)...`);
  const results = [];
  let processed = 0;
  for (const row of rows) {
    const result = await auditRow(row);
    results.push(result);
    console.log(`  ${result.cls} (${result.name}): ${result.action} — ${result.license}`);
    processed++;
    if (processed % 25 === 0) console.log(`  ${processed}/${rows.length} processed`);
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log('\n=== Done ===');
  const byAction = {};
  for (const r of results) byAction[r.action] = (byAction[r.action] || 0) + 1;
  console.log(JSON.stringify(byAction, null, 2));
  console.log(`Full report written to ${OUTPUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

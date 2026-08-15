#!/usr/bin/env node
/**
 * scripts/audit-locomotive-image-licenses.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Read-only audit — does not modify data/site-data.json or database.html.
 *
 * REPOINTED 2026-08-15 from data/rolling-stock.json (raw export) to
 * data/site-data.json (generated: export + rolling-stock-overrides.json
 * layered on top by build-locomotive-data.mjs). The raw export never sees
 * the 22 hand-curated Wikimedia File: links, nor any image value set by a
 * `corrections`/`additions` entry — auditing it was auditing a fleet of
 * images the site was never actually showing for those 22+ rows. Reads
 * canonical instances only (isCanonicalHere) so a cross-listed class isn't
 * audited twice.
 *
 * database.html's TrainImage() component fetches a locomotive class's image
 * LIVE, client-side, via parseImageRef() — which branches on TWO different
 * Commons URL shapes, not one:
 *   - Category:X — treats X as a guessed EN Wikipedia article title and
 *     fetches THAT article's current lead/thumbnail image via Wikipedia's
 *     REST summary API. Works by coincidence whenever the category name
 *     matches the article title — often true, not always.
 *   - File:X — a SPECIFIC curated photo, fetched directly from that
 *     Commons file's own imageinfo/extmetadata. This is the 22-row curated
 *     set (data/rolling-stock-overrides.json's `overrides`).
 * This audit REPOINTED-AND-FIXED to mirror both branches (previously it only
 * ever matched Category:, via deriveWikiTitle()'s regex, so a File: row fell
 * through to "no derivable Wikipedia title" — silently un-audited, not
 * flagged, not confirmed safe, just skipped). The File: branch does not need
 * a Wikipedia-article guess or a Commons-hosted check at all: a Commons
 * File: URL is BY CONSTRUCTION Commons-hosted (Commons never accepts
 * non-free content), so it goes straight to the same Commons imageinfo
 * license lookup used for the Category: branch's Commons-hosted case.
 *
 * For the Category: branch, classification is unchanged:
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
 * per-class report. Does NOT touch data/site-data.json, data/rolling-stock-
 * overrides.json, or any rendering code; removal (if any) is a deliberate
 * separate step after review.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DATA_PATH = path.join(ROOT, 'data', 'site-data.json');
const OUTPUT_PATH = path.join(__dirname, 'output', 'locomotive-image-license-audit.json');

const REST_SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; audit script, not a live API dependency)';
const REQUEST_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Must stay in step with database.html's parseImageRef() — same two URL
// shapes, same precedence (File: checked before Category:).
function parseImageRef(commonsUrl) {
  if (!commonsUrl) return null;
  const url = String(commonsUrl);
  const fileMatch = url.match(/File:([^?#]+)$/);
  if (fileMatch) return { type: 'file', filename: decodeURIComponent(fileMatch[1]) };
  const catMatch = url.match(/Category:([^?#]+)$/);
  if (catMatch) return { type: 'category', title: catMatch[1] };
  return null;
}

function extractRows() {
  const site = JSON.parse(readFileSync(SITE_DATA_PATH, 'utf8'));
  const rows = [];
  for (const cat of site.categories) {
    for (const k of cat.classes) {
      if (!k.isCanonicalHere) continue; // avoid auditing a cross-listed class twice
      if (k.image && /commons\.wikimedia\.org/i.test(k.image)) {
        // Heritage instances carry `role`, not `name` (unified schema, see
        // build-locomotive-data.mjs's SECTIONS) — same fallback database.html
        // uses for displayName.
        rows.push({ category: cat.name, cls: k.class, name: k.name || k.role, commonsUrl: k.image });
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
  const ref = parseImageRef(row.commonsUrl);
  if (!ref) {
    return { ...row, wikiTitle: null, imageUrl: null, license: null, action: 'keep', reason: 'commonsUrl matches neither File: nor Category: — TrainImage() would show "no image available" (nothing to flag)' };
  }

  if (ref.type === 'file') {
    // Commons File: URL is Commons-hosted by construction (Commons never
    // accepts non-free content) — no Wikipedia-article guess, no
    // Commons-hosted check needed, straight to the license lookup.
    const license = await fetchCommonsLicense(ref.filename);
    await sleep(REQUEST_DELAY_MS);
    const isFree = license && /^(cc0|cc by|cc by-sa|public domain|pdm)/i.test(license);
    return {
      ...row,
      wikiTitle: null,
      imageUrl: `File:${ref.filename}`,
      license: license || '(Commons File: link, license lookup failed)',
      action: isFree ? 'keep' : 'REVIEW',
      reason: isFree
        ? 'curated Commons File: link, confirmed free-reuse license'
        : 'curated Commons File: link but license could not be confirmed as free-reuse — needs manual check (Commons-hosted, so still not fair-use risk, but verify the license string)',
    };
  }

  const title = ref.title;
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

#!/usr/bin/env node
/**
 * scripts/fetch-official-websites.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates `website` on stations-content.json and operators-content.json
 * entries — deterministic, no AI (same discipline as fetch-osm-facts.mjs /
 * fetch-station-photos.mjs, NOT fetch-wikipedia-facts.mjs's Claude
 * extraction, and this field can never move to that pathway — see why
 * below).
 *
 * WHY NOT fetch-wikipedia-facts.mjs: confirmed live 2026-07-19 that its
 * plain-text article extraction (`explaintext=1`) cannot see this field at
 * all — infobox parameters are stripped from plain text entirely, and a
 * live spot-check requesting `website` through that pathway for all 30
 * operators came back 0/30 extracted, every one "article had none of the
 * requested facts." The infobox's own `website` parameter is also very
 * often literally `{{Official URL}}` in the wikitext — a Wikipedia TEMPLATE
 * that itself pulls from the connected Wikidata item's "official website"
 * property (P856), not a literal URL string anywhere in the article — so
 * even a raw-wikitext-parsing approach wouldn't reliably find a URL to
 * extract. (A naive `/website\s*=\s*(.+)/` regex was tried live against
 * Great Western Railway's full wikitext as a sanity check and matched an
 * unrelated citation's `website=` parameter deep in the article body,
 * nowhere near the real infobox — confirming wikitext regex-parsing here is
 * actively unsafe, not just unreliable.) Wikidata's P856 claim is clean,
 * structured, and authoritative for this — it's the exact same source
 * {{Official URL}} itself resolves from — so this script queries Wikidata
 * directly instead: Wikipedia article title -> connected Wikidata QID (via
 * pageprops.wikibase_item) -> that item's P856 (official website) claim.
 *
 * Run:
 *   node scripts/fetch-official-websites.mjs
 *
 * Only ever touches an entry that already has wikipedia_title set (never
 * guesses one — same discipline as every other script here). Never
 * overwrites an existing `website` (human-set or from a prior run).
 *
 * FIELD OWNERSHIP: sole writer of `website` on both stations-content.json
 * and operators-content.json. Writes provenance under `_wikidata` (fetched_at,
 * qid) — a separate namespace from `_wikipedia`, since that one is owned by
 * fetch-wikipedia-facts.mjs and records a different source (the article's
 * prose, extracted by Claude) — keeping them separate avoids the two
 * scripts' provenance writes ever colliding or being misread as the same
 * kind of fetch. An entry with `_wikidata` set has been checked at least
 * once, regardless of whether a website claim existed — re-runs skip it
 * (same "don't re-bill/re-query already-processed entries" discipline as
 * fetch-wikipedia-facts.mjs's incrementalFieldsAttempted, just simpler here
 * since there's no per-field granularity to track, only one field).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILES = {
  stations: path.join(ROOT, 'stations-content.json'),
  operators: path.join(ROOT, 'operators-content.json'),
};

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';
const REQUEST_DELAY_MS = 200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function fetchWikidataQid(title) {
  const url = `${WIKI_API}?action=query&prop=pageprops&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const page = data.query && data.query.pages && Object.values(data.query.pages)[0];
  return (page && page.pageprops && page.pageprops.wikibase_item) || null;
}

async function fetchOfficialWebsite(qid) {
  const url = `${WIKIDATA_API}?action=wbgetclaims&entity=${qid}&property=P856&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const claims = data.claims && data.claims.P856;
  if (!claims || !claims.length) return null;
  // Prefer a "preferred" rank claim if one exists (rare but possible when a
  // company has had multiple official sites over time); otherwise the first
  // normal-rank claim.
  const preferred = claims.find((c) => c.rank === 'preferred') || claims[0];
  const value = preferred.mainsnak && preferred.mainsnak.datavalue && preferred.mainsnak.datavalue.value;
  return typeof value === 'string' ? value : null;
}

async function processEntry(key, content, report) {
  const entry = content[key];
  if (!entry) {
    report.push({ key, status: 'not-found' });
    return;
  }
  if (entry.website) {
    console.log(`  ${key}: already has a website — skipped`);
    report.push({ key, status: 'skipped-already-set' });
    return;
  }
  if (entry._wikidata) {
    console.log(`  ${key}: already checked Wikidata (no re-query) — skipped`);
    report.push({ key, status: 'skipped-already-attempted' });
    return;
  }
  const title = entry.wikipedia_title;
  if (!title) {
    console.log(`  ${key}: no wikipedia_title set — skipped, nothing to look up (never guesses one)`);
    report.push({ key, status: 'no-title' });
    return;
  }

  const qid = await fetchWikidataQid(title);
  await sleep(REQUEST_DELAY_MS);
  if (!qid) {
    console.log(`  ${key}: "${title}" has no connected Wikidata item — left "Not available" rather than guess`);
    content[key]._wikidata = { fetched_at: new Date().toISOString(), qid: null };
    report.push({ key, status: 'no-qid' });
    return;
  }

  const website = await fetchOfficialWebsite(qid);
  await sleep(REQUEST_DELAY_MS);
  content[key]._wikidata = { fetched_at: new Date().toISOString(), qid };
  if (!website) {
    console.log(`  ${key}: Wikidata item ${qid} has no official-website (P856) claim — left "Not available" rather than guess`);
    report.push({ key, status: 'no-website-claim' });
    return;
  }

  content[key].website = website;
  console.log(`  ${key}: website set — ${website}`);
  report.push({ key, status: 'ok', website });
}

async function processFile(kind, filePath) {
  const content = loadJson(filePath);
  const keys = Object.keys(content).filter((k) => k !== '_notes');
  const report = [];
  console.log(`\n── ${kind} (${keys.length} entries) ──`);
  let processed = 0;
  for (const key of keys) {
    try {
      await processEntry(key, content, report);
    } catch (err) {
      console.error(`  ${key}: FAILED — ${err.message}`);
      report.push({ key, status: 'error', message: err.message });
    }
    processed++;
    if (processed % 50 === 0) {
      saveJson(filePath, content);
      console.log(`  ${processed}/${keys.length} processed (checkpoint saved)`);
    }
  }
  saveJson(filePath, content);
  const byStatus = {};
  for (const r of report) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`  ${kind} done:`, JSON.stringify(byStatus));
  return byStatus;
}

// ONLY_KIND env var (optional): restricts a run to 'stations' or 'operators'
// — same convention as fetch-wikipedia-facts.mjs's ONLY_KIND, useful here to
// run the much-smaller operators file first as a checkpoint before the ~2.6k
// stations run. e.g.: ONLY_KIND=operators node scripts/fetch-official-websites.mjs
const ONLY_KIND = process.env.ONLY_KIND;

async function main() {
  for (const [kind, filePath] of Object.entries(FILES)) {
    if (ONLY_KIND && kind !== ONLY_KIND) continue;
    await processFile(kind, filePath);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

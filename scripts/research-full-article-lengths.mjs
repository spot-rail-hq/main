#!/usr/bin/env node
/**
 * scripts/research-full-article-lengths.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * RESEARCH ONLY. Does not write stations-content.json or the coverage
 * checkpoint/report — a one-off investigation script, not part of the
 * regular pipeline.
 *
 * Question: how many of the 2,107 stub-tier stations (real Wikipedia
 * article confirmed matched, but classified "stub" purely because the
 * Wikipedia REST summary's LEAD-PARAGRAPH extract was under 400 chars —
 * see scripts/scope-wikipedia-coverage.mjs's STUB_THRESHOLD_CHARS) are
 * actually thin on real content, versus how many — like the user's
 * Stalybridge example (280-char lead, but an 11,427-char FULL article with
 * a real History section) — just look thin because the tiering metric only
 * ever measured the lead paragraph, not the article body fetch-wikipedia-
 * facts.mjs actually extracts from.
 *
 * Fetches each stub-tier station's FULL plain-text article (same
 * prop=extracts&explaintext=1 call fetch-wikipedia-facts.mjs's
 * fetchWikipediaText() makes — no Claude call, pure Wikipedia API, no
 * AI cost) and records its length, for a real (not lead-only) read on
 * how much source material actually exists.
 *
 * Run:
 *   node scripts/research-full-article-lengths.mjs
 *
 * Checkpoints to scripts/output/full-article-length-research.json every
 * 50 stations (resumable).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHECKPOINT_PATH = path.join(ROOT, 'scripts', 'output', 'wikipedia-coverage-checkpoint.json');
const OUTPUT_PATH = path.join(ROOT, 'scripts', 'output', 'full-article-length-research.json');

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'SpotRailHQ-content-scoping-script/1.0 (+https://srhq.uk; one-off research pass, not a live API dependency)';
const REQUEST_DELAY_MS = 150;
const CHECKPOINT_EVERY = 50;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function fetchFullTextLength(title) {
  const url = `${WIKI_API}?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  const page = Object.values(data.query.pages)[0];
  if (!page || page.missing !== undefined) return { error: 'missing' };
  return { length: (page.extract || '').length };
}

async function main() {
  const checkpoint = loadJson(CHECKPOINT_PATH, { results: {} });
  const stubStations = Object.values(checkpoint.results).filter((r) => r.status === 'matched' && r.tier === 'stub');
  console.log(`Researching full-article length for ${stubStations.length} stub-tier stations...`);

  const research = loadJson(OUTPUT_PATH, { results: {} });
  const alreadyDone = new Set(Object.keys(research.results));
  console.log(`${alreadyDone.size} already checked, resuming.`);

  let processed = alreadyDone.size;
  for (const station of stubStations) {
    if (alreadyDone.has(station.crs)) continue;
    let result;
    try {
      result = await fetchFullTextLength(station.matchedTitle);
    } catch (err) {
      result = { error: err.message };
    }
    await sleep(REQUEST_DELAY_MS);
    research.results[station.crs] = {
      crs: station.crs,
      name: station.name,
      matchedTitle: station.matchedTitle,
      leadExtractLength: station.extractLength,
      fullArticleLength: result.length != null ? result.length : null,
      error: result.error || null,
    };
    processed++;
    if (processed % CHECKPOINT_EVERY === 0 || processed === stubStations.length) {
      saveJson(OUTPUT_PATH, research);
      console.log(`  ${processed}/${stubStations.length} checked (checkpoint saved)`);
    }
  }
  saveJson(OUTPUT_PATH, research);

  const all = Object.values(research.results).filter((r) => r.fullArticleLength != null);
  const thresholds = [400, 500, 800, 1000, 1500, 2000];
  console.log('\n=== Full-article-length distribution among stub-tier stations ===');
  console.log(`Total checked: ${all.length}`);
  for (const t of thresholds) {
    const below = all.filter((r) => r.fullArticleLength < t).length;
    console.log(`  Below ${t} chars (full article): ${below} (${((below / all.length) * 100).toFixed(1)}%)`);
  }
  const errored = Object.values(research.results).filter((r) => r.fullArticleLength == null);
  console.log(`Errored/no full text: ${errored.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

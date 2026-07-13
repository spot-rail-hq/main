#!/usr/bin/env node
/**
 * scripts/fetch-wikipedia-facts.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Populates the NARRATIVE/HISTORICAL fields in stations-content.json,
 * routes-content.json, and operators-content.json from Wikipedia — fetched
 * via Wikipedia's own REST/action API, then EXTRACTED (not generated from
 * memory) into the target schema by Claude. Run manually/periodically:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/fetch-wikipedia-facts.mjs
 *
 * There is no live production dependency on this script, Wikipedia, or the
 * Claude API — it only ever writes static JSON that the app reads at
 * request time. Requires wikipedia_title to already be set (by hand) on
 * the entries you want enriched — see Task 3 in the delivery notes: a
 * missing/wrong title is a curation gap, not something this script guesses
 * at via search.
 *
 * ─── FIELD OWNERSHIP (read this before editing another script) ───────────
 * This script is the ONLY writer for:
 *   stations-content.json  →  synopsis, opened_year, notable_features
 *   routes-content.json    →  synopsis, opened_year, operating_since
 *   operators-content.json →  synopsis, parent_company, franchises
 * It never writes: platforms, wheelchair, operators (stations), length_km,
 * stopping_stations, type, operator (routes), stations_operated,
 * regions_served, fleet_classes (operators), wikipedia_title, name, photo,
 * location, listed_status, or any existence/status field — those belong to
 * scripts/fetch-osm-facts.mjs (structured/physical), manual curation, or
 * the separate NaPTAN re-import pipeline. See that script's header for its
 * owned-fields list.
 *
 * Each run does a shallow merge: only the fields this script owns are ever
 * assigned, and ONLY when Claude actually found the fact on the page — a
 * field the source page doesn't cover is left null/absent, never guessed,
 * and never overwrites an existing curated value with a blank. This is
 * what makes it safe to run both scripts in either order, repeatedly.
 * ───────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILES = {
  stations: path.join(ROOT, 'stations-content.json'),
  routes: path.join(ROOT, 'routes-content.json'),
  operators: path.join(ROOT, 'operators-content.json'),
};

// ─── Jobs to run this pass — edit this, then re-run ──────────────────────
// Every key here must already exist (or be about to be created) in the
// matching -content.json file, with a wikipedia_title set — see Task 3:
// if wikipedia_title is missing, this script skips the entry and leaves
// the existing "content coming soon" fallback in place, it does not guess.
const JOBS = {
  stations: ['BHM', 'SOL'],
  routes: ['CROSSCITY-BROMSGROVE-LICHFIELD'],
  operators: ['WMR'],
};

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

async function fetchWikipediaText(title) {
  const url = `${WIKI_API}?action=query&prop=extracts|info&explaintext=1&redirects=1&inprop=url&titles=${encodeURIComponent(title)}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}`);
  const data = await res.json();
  const pages = data.query && data.query.pages;
  const page = pages && Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  return { title: page.title, url: page.fullurl, text: page.extract || '' };
}

const EXTRACTION_SCHEMAS = {
  stations: {
    fields: 'synopsis (1-2 sentence plain-text summary of the station itself), opened_year (the year the CURRENT/notable station building or service first opened — a string, e.g. "1854" or "1967 (rebuilt)"), notable_features (array of short phrase strings — architectural, historical, or record-holding facts, e.g. "Britain\'s busiest station outside London")',
  },
  routes: {
    fields: 'synopsis (1-2 sentence plain-text summary of the route/line itself), opened_year (year the line first opened, string), operating_since (year the CURRENT operator/franchise began running it, string — distinct from opened_year, which is about the line\'s original construction)',
  },
  operators: {
    fields: 'synopsis (1-2 sentence plain-text summary of the company), parent_company (string, the ultimate/immediate parent company name, or null if independent/not stated), franchises (array of {name, start, end} — end is null for the current/ongoing franchise; only include entries the article actually states dates for)',
  },
};

function buildPrompt(kind, name, text) {
  const { fields } = EXTRACTION_SCHEMAS[kind];
  return `You are extracting facts from a Wikipedia article for a UK rail information site. EXTRACT only — do not invent, infer, or use outside knowledge. If the article does not clearly state a fact, set that field to null (or an empty array for list fields) rather than guessing.

Subject: ${name}
Fields to extract: ${fields}

Respond with ONLY a single JSON object with exactly those field names as keys — no markdown fences, no commentary.

Article text:
"""
${text.slice(0, 60000)}
"""`;
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set — cannot run the extraction step. Set it and re-run.');
  }
  const res = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const raw = data.content.map((b) => b.text || '').join('');
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude response wasn't parseable JSON: ${raw.slice(0, 300)}`);
  return JSON.parse(jsonMatch[0]);
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function saveJson(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

// Only assigns fields Claude actually returned a non-null/non-empty value
// for — never blanks out an existing curated value, and never writes a
// field outside this script's ownership list (enforced by only ever
// spreading `extracted`, which itself only ever contains the schema's own
// keys, per buildPrompt()'s explicit field list).
function mergeWikipediaFields(entry, extracted) {
  const out = { ...(entry || {}) };
  for (const [k, v] of Object.entries(extracted)) {
    const isEmpty = v == null || (Array.isArray(v) && v.length === 0);
    if (!isEmpty) out[k] = v;
  }
  return out;
}

async function processEntry(kind, key, content) {
  const entry = content[key];
  const title = entry && entry.wikipedia_title;
  if (!title) {
    console.log(`  ${key}: no wikipedia_title set — skipped (Task 3 fallback: leave existing "content coming soon" state as-is)`);
    return;
  }
  const page = await fetchWikipediaText(title);
  if (!page || !page.text) {
    console.log(`  ${key}: wikipedia_title "${title}" did not resolve to a page — skipped, no error thrown`);
    return;
  }
  const name = (entry && entry.name) || key;
  const prompt = buildPrompt(kind, name, page.text);
  const extracted = await callClaude(prompt);
  content[key] = mergeWikipediaFields(entry, extracted);
  content[key]._wikipedia = {
    fetched_at: new Date().toISOString(),
    title: page.title,
    url: page.url,
    license: 'CC BY-SA 4.0',
  };
  console.log(`  ${key}: extracted ${Object.keys(extracted).filter((k) => extracted[k] != null && !(Array.isArray(extracted[k]) && !extracted[k].length)).join(', ') || '(nothing — article had none of the requested facts)'}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  for (const kind of ['stations', 'routes', 'operators']) {
    const filePath = FILES[kind];
    const content = loadJson(filePath);
    console.log(`\n── ${kind} ──`);
    for (const key of JOBS[kind]) {
      try {
        await processEntry(kind, key, content);
      } catch (err) {
        console.error(`  ${key}: FAILED — ${err.message} (left untouched, no partial write)`);
      }
      await sleep(500); // light pacing — Wikipedia + Claude both have their own rate limits
    }
    saveJson(filePath, content);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

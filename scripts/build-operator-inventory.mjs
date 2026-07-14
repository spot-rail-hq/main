#!/usr/bin/env node
/**
 * scripts/build-operator-inventory.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 0 of the operator-colored rail line project (see the approved plan,
 * "Operator-colored rail line rendering", for the full 8-phase context).
 *
 * Queries every GB train/light_rail/tram/subway route relation from a local
 * Overpass instance (see OVERPASS_URL below — same self-hosted setup used
 * by fetch-osm-facts.mjs), collects the distinct raw operator/brand tag
 * strings actually in use, and maps each one to a canonical bucket:
 *
 *   toc      — a real train operating company, canonical name matches an
 *              operators-content.json key (CANONICAL_TOC below)
 *   metro    — light rail / tram / subway / metro systems, kept visually
 *              distinct from national-rail TOCs per the existing Database-
 *              mode legend ("Metro/LRT (purple)")
 *   heritage — preserved/heritage lines, sharing one treatment since they
 *              never physically overlap each other
 *   excluded — defunct/stale tags, museum exhibits, ambiguous historic
 *              company names, or anything that isn't a live passenger
 *              service — rendered as the plain base line, not colored
 *
 * This mapping is deliberately its own thing, NOT a strict reuse of
 * operators-content.json's `aliases` array — that field exists for station-
 * data provenance precision (e.g. "West Midlands Trains" is WMR's
 * `legal_entity`, not folded into `aliases`, and "Trafnidiaeth Cymru" is
 * AW's `welsh_name`, deliberately left unfolded in station data too) — but
 * a line-color map needs ONE consistent color per real service regardless
 * of which legal/bilingual name a given relation happens to carry, so both
 * are folded to their TOC's color here even though station-content.json
 * correctly keeps them unfolded.
 *
 * Run:
 *   node scripts/build-operator-inventory.mjs
 *
 * Output: scripts/output/operator-inventory.json — the full raw-string →
 * bucket/canonical mapping, plus relation counts per bucket, for review
 * before Phase 1 (palette) or Phase 2 (segment graph) touch it.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classify } from './lib/operator-classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output');
const OUT_PATH = path.join(OUT_DIR, 'operator-inventory.json');

const OVERPASS_URL = process.env.OVERPASS_URL || 'http://localhost:12345/api/interpreter';

// The raw-string → bucket/canonical classification (CANONICAL_TOC, the GTR
// 31-May-2026 renationalization fold, CANONICAL_METRO, CANONICAL_HERITAGE,
// EXCLUDED, and the reasoning behind each) now lives in
// scripts/lib/operator-classify.mjs, shared with build-line-segments.mjs
// (Phase 2) so both scripts classify relations identically. See that file
// for the full mapping and its comments.

async function overpassQuery(q) {
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Overpass returned non-JSON (likely an error page): ${text.slice(0, 300)}`);
  }
}

async function main() {
  console.log(`Querying ${OVERPASS_URL} for all GB train/light_rail/tram/subway route relations...`);
  const q = '[out:json][timeout:120];rel["type"="route"]["route"~"^(train|light_rail|tram|subway)$"];out tags;';
  const data = await overpassQuery(q);
  const rels = data.elements;
  console.log(`  ${rels.length} relations found.`);

  const raw = {}; // rawString -> count
  for (const r of rels) {
    const op = r.tags.operator || r.tags.brand || '(none)';
    raw[op] = (raw[op] || 0) + 1;
  }

  const mapping = {};
  const bucketCounts = { toc: 0, metro: 0, heritage: 0, excluded: 0, unrecognized: 0 };
  const unrecognized = [];
  for (const [rawStr, count] of Object.entries(raw)) {
    const cls = classify(rawStr);
    mapping[rawStr] = { count, ...cls };
    bucketCounts[cls.bucket] += count;
    if (cls.bucket === 'unrecognized') unrecognized.push({ raw: rawStr, count });
  }

  const report = {
    generated_at: new Date().toISOString(),
    total_relations: rels.length,
    total_raw_strings: Object.keys(raw).length,
    bucket_relation_counts: bucketCounts,
    unrecognized: unrecognized.sort((a, b) => b.count - a.count),
    mapping,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');

  console.log('\n=== Bucket relation counts ===');
  console.log(bucketCounts);
  if (unrecognized.length) {
    console.log('\n=== UNRECOGNIZED raw strings — not classified, need a mapping decision ===');
    unrecognized.forEach((u) => console.log(`  "${u.raw}" (${u.count})`));
  } else {
    console.log('\nAll raw operator/brand strings classified — no unrecognized entries.');
  }
  console.log(`\nFull report written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

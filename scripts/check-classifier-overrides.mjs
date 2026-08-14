#!/usr/bin/env node
/**
 * scripts/check-classifier-overrides.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Standalone retirement-detection for scripts/lib/operator-classify.mjs's
 * two hand-verified override tables — extracted from build-line-segments.mjs
 * (2026-08-15, per scratchpad/corrections-layer-scoping.md Section 1's audit
 * finding), not a new mechanism. `heritageOverrideStatus()` already existed
 * and already did this correctly for HERITAGE_PAIR_OVERRIDES; it was just
 * buried inside the Overpass-dependent NATIONAL segment-graph rebuild
 * (build-line-segments.mjs:493-494, a `console.log` loop with no dedicated
 * entry point), so seeing it meant running the full expensive rebuild and
 * reading its output. It never covered RELATION_ID_OVERRIDES at all — the
 * larger (~25-entry) table right next to it in the same file.
 *
 * This script does neither: it makes SMALL, TARGETED Overpass queries (by
 * name for the heritage pairs, by relation ID for the relation overrides)
 * instead of the full national way/relation extract, so it can run on its
 * own, cheaply, matching check-operator-ownership-staleness.mjs's shape —
 * read-only, no write, exit 0 always (a review queue, not a guard; the
 * underlying heritageOverrideStatus() logic this reuses has never thrown
 * either, only warned).
 *
 * Two independent checks:
 *
 *   1. HERITAGE_PAIR_OVERRIDES — reuses heritageOverrideStatus() UNCHANGED
 *      (imported, not reimplemented), fed from a targeted `way["name"=...]`
 *      query instead of the national extract. Four states: dead / corrected
 *      / partially-corrected / still-active — see that function's own
 *      comment in operator-classify.mjs for the exact semantics.
 *
 *   2. RELATION_ID_OVERRIDES — a new check of the same shape, since no
 *      precedent existed for this table. For each relation ID, fetches its
 *      CURRENT tags and runs the identical classify()/classifyTags() path
 *      build-line-segments.mjs itself uses (classify(rawOp), falling back to
 *      classifyTags(tags) for heritage) — i.e. what the relation would
 *      resolve to on its own, without the override. Four parallel states:
 *      DEAD (relation no longer exists — Overpass returned nothing for this
 *      ID), CORRECTED (fresh classification now matches what the override
 *      asserts on its own — override is redundant, remove it), CHANGED
 *      (fresh classification is neither 'excluded' nor what the override
 *      asserts — the tags moved to a THIRD state; needs a human look, not
 *      just removal), STILL ACTIVE (fresh classification is still
 *      'excluded' — override still doing real work).
 *
 * Usage:
 *   node scripts/check-classifier-overrides.mjs
 *   OVERPASS_URL=http://localhost:12345/api/interpreter node scripts/check-classifier-overrides.mjs
 *
 * Needs a reachable Overpass instance (same OVERPASS_URL convention as
 * build-line-segments.mjs / build-operator-inventory.mjs) — there is no
 * cached/offline path, because the entire point is checking against LIVE
 * current tags. If none is reachable, this fails fast with a clear message
 * rather than a confusing fetch error.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  HERITAGE_PAIR_OVERRIDES,
  RELATION_ID_OVERRIDES,
  heritageOverrideStatus,
  classify,
  classifyTags,
} from './lib/operator-classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERPASS_URL = process.env.OVERPASS_URL || 'http://localhost:12345/api/interpreter';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

async function overpassQuery(ql, { retries = 3, timeoutMs = 60000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status === 504) && attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      throw new Error(`Overpass request failed: HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(t);
      if (attempt < retries) { await new Promise((r) => setTimeout(r, attempt * 1000)); continue; }
      throw err;
    }
  }
}

// ─── Check 1: HERITAGE_PAIR_OVERRIDES ──────────────────────────────────────
// Reuses heritageOverrideStatus() exactly as build-line-segments.mjs did —
// this function's job is unchanged, only how `waysWithTags` gets populated
// is new (targeted query here, national extract there).
export async function checkHeritagePairOverrides() {
  if (!HERITAGE_PAIR_OVERRIDES.length) return [];
  const names = [...new Set(HERITAGE_PAIR_OVERRIDES.map((o) => o.name))];
  const q = `[out:json][timeout:60];(${names.map((n) => `way["name"="${n.replace(/"/g, '\\"')}"];`).join('')});out tags;`;
  const data = await overpassQuery(q);
  const waysWithTags = (data.elements || []).map((w) => ({ name: (w.tags || {}).name, operator: (w.tags || {}).operator }));
  return heritageOverrideStatus(waysWithTags);
}

// ─── Check 2: RELATION_ID_OVERRIDES ────────────────────────────────────────
// Same four-state shape as heritageOverrideStatus(), new for this table —
// no precedent existed. Replicates build-line-segments.mjs's own
// classify(rawOp) -> classifyTags(tags) fallback path exactly (see that
// file's relation-processing loop) so "would this resolve correctly on its
// own now" is judged the identical way the real pipeline judges it.
export async function checkRelationIdOverrides() {
  const ids = Object.keys(RELATION_ID_OVERRIDES).map(Number);
  if (!ids.length) return [];
  const q = `[out:json][timeout:60];(${ids.map((id) => `rel(${id});`).join('')});out tags;`;
  const data = await overpassQuery(q);
  const byId = new Map((data.elements || []).map((r) => [r.id, r.tags || {}]));

  const out = [];
  for (const id of ids) {
    const override = RELATION_ID_OVERRIDES[id];
    const tags = byId.get(id);
    if (!tags) {
      out.push(`WARNING: relation ${id} (override target ${override.canonical}) no longer exists in the current extract — the override is dead code. Remove it or re-derive the join.`);
      continue;
    }
    const rawOp = tags.operator || tags.brand || '(none)';
    let fresh = classify(rawOp);
    if (fresh.bucket !== 'toc' && fresh.bucket !== 'metro') {
      const h = classifyTags(tags);
      if (h.bucket === 'heritage') fresh = h;
    }
    const matchesOverride = fresh.bucket === override.bucket && fresh.canonical === override.canonical;
    if (matchesOverride) {
      out.push(`WARNING: relation ${id} ("${tags.name || '(unnamed)'}") now classifies as ${fresh.bucket}/${fresh.canonical} WITHOUT the override (operator="${rawOp}"). The override no longer fires meaningfully; REMOVE the RELATION_ID_OVERRIDES[${id}] entry.`);
    } else if (fresh.bucket !== 'excluded') {
      out.push(`WARNING: relation ${id} ("${tags.name || '(unnamed)'}") now classifies as ${fresh.bucket}/${fresh.canonical || '—'} — DIFFERENT from both 'excluded' and the override's own ${override.bucket}/${override.canonical}. Tags changed to a third state; re-check by hand, don't just remove.`);
    } else {
      out.push(`  override OK: relation ${id} ("${tags.name || '(unnamed)'}") still classifies as excluded on its own (operator="${rawOp}") — override active for ${override.bucket}/${override.canonical}.`);
    }
  }
  return out;
}

async function main() {
  console.log(`Checking classifier overrides against live Overpass (${OVERPASS_URL})…\n`);

  console.log(`1. HERITAGE_PAIR_OVERRIDES (${HERITAGE_PAIR_OVERRIDES.length} entr${HERITAGE_PAIR_OVERRIDES.length === 1 ? 'y' : 'ies'}):`);
  const heritageLines = await checkHeritagePairOverrides();
  if (!heritageLines.length) console.log('  none configured');
  heritageLines.forEach((l) => console.log(`  ${l}`));

  console.log(`\n2. RELATION_ID_OVERRIDES (${Object.keys(RELATION_ID_OVERRIDES).length} entries):`);
  const relationLines = await checkRelationIdOverrides();
  relationLines.forEach((l) => console.log(l));

  console.log(`\nDone. This is a report, not a guard — exiting 0 regardless of findings.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    console.error(`This check needs a reachable Overpass instance (OVERPASS_URL, currently ${OVERPASS_URL}) — it has no offline/cached path, because it exists specifically to compare against LIVE current tags.`);
    process.exit(1);
  });
}

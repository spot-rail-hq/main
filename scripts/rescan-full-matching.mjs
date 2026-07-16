#!/usr/bin/env node
/**
 * scripts/rescan-full-matching.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPING PASS ONLY. Does not read or write stations-content.json.
 *
 * Re-runs matchStation() (the fixed 2026-07-16 version — search fallback,
 * station-title preference, abbreviation expansion, geo-required bare-name
 * tier) against every already-"matched" station in the checkpoint, and
 * reports every case where the result differs from what's currently there.
 *
 * Why a full re-match rather than a pattern-based rescan of cached data:
 * a live investigation (2026-07-16) proved a regex/description-pattern
 * check over the OLD cached match data cannot reliably find this class of
 * issue — 9 of the 15 stations that turned out to have a real, dedicated,
 * correctly-matched station article (once matchStation() was fixed) would
 * NOT have been caught by any broadened description-pattern regex, because
 * the WRONG match's description didn't always look wrong (e.g. Kew Gardens
 * → "Kew Gardens station" was itself a disambiguation page the old code
 * correctly rejected, falling through to the wrong bare "Kew Gardens"
 * article — no amount of regex-tuning on the rejected candidate's
 * description would have surfaced the real "Kew Gardens station (London)"
 * article hiding behind that disambiguation page). Only actually re-running
 * the improved matching logic can find the truth.
 *
 * Run:
 *   node scripts/rescan-full-matching.mjs
 *
 * Checkpoints its own progress separately (wikipedia-rescan-checkpoint.json)
 * so it's resumable; writes a diff report at the end
 * (wikipedia-rescan-diff-report.json) listing every CRS whose matched title
 * changed, unchanged, or now needs review.
 */

import { matchStation, loadJson, saveJson, STATION_LIST_PATH, CHECKPOINT_PATH } from './scope-wikipedia-coverage.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RESCAN_CHECKPOINT_PATH = path.join(ROOT, 'scripts', 'output', 'wikipedia-rescan-checkpoint.json');
const DIFF_REPORT_PATH = path.join(ROOT, 'scripts', 'output', 'wikipedia-rescan-diff-report.json');
const CHECKPOINT_EVERY = 50;

async function main() {
  const stations = loadJson(STATION_LIST_PATH, []);
  const oldCheckpoint = loadJson(CHECKPOINT_PATH, { results: {} });
  const targets = Object.values(oldCheckpoint.results).filter((r) => r.status === 'matched');
  console.log(`Re-matching ${targets.length} already-matched stations with the fixed algorithm...`);

  const rescan = loadJson(RESCAN_CHECKPOINT_PATH, { results: {} });
  const alreadyDone = new Set(Object.keys(rescan.results));
  console.log(`${alreadyDone.size} already re-checked, resuming.`);

  let processed = alreadyDone.size;
  for (const oldResult of targets) {
    if (alreadyDone.has(oldResult.crs)) continue;
    const station = stations.find((s) => s.crs === oldResult.crs);
    let newResult;
    try {
      newResult = await matchStation(station);
    } catch (err) {
      newResult = { status: 'error', reason: err.message };
    }
    rescan.results[oldResult.crs] = {
      crs: oldResult.crs,
      name: oldResult.name,
      oldMatchedTitle: oldResult.matchedTitle,
      oldConfidence: oldResult.confidence,
      newStatus: newResult.status,
      newMatchedTitle: newResult.matchedTitle || null,
      newConfidence: newResult.confidence || null,
      newDescription: newResult.description || null,
      changed: newResult.matchedTitle !== oldResult.matchedTitle,
    };
    processed++;
    if (processed % CHECKPOINT_EVERY === 0 || processed === targets.length) {
      saveJson(RESCAN_CHECKPOINT_PATH, rescan);
      console.log(`  ${processed}/${targets.length} re-checked (checkpoint saved)`);
    }
  }
  saveJson(RESCAN_CHECKPOINT_PATH, rescan);

  const all = Object.values(rescan.results);
  const changed = all.filter((r) => r.changed);
  const unchanged = all.filter((r) => !r.changed);
  const nowNeedsReview = all.filter((r) => r.newStatus !== 'matched');

  const report = {
    generatedAt: new Date().toISOString(),
    totalRechecked: all.length,
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    nowNeedsReviewCount: nowNeedsReview.length,
    changed: changed.map((r) => ({ crs: r.crs, name: r.name, old: r.oldMatchedTitle, new: r.newMatchedTitle, newConfidence: r.newConfidence, newDescription: r.newDescription })),
    nowNeedsReview: nowNeedsReview.map((r) => ({ crs: r.crs, name: r.name, oldMatchedTitle: r.oldMatchedTitle, newStatus: r.newStatus })),
  };
  saveJson(DIFF_REPORT_PATH, report);

  console.log(`\n=== Done ===`);
  console.log(`Re-checked: ${report.totalRechecked} | Changed: ${report.changedCount} | Unchanged: ${report.unchangedCount} | Now needs-review: ${report.nowNeedsReviewCount}`);
  console.log(`Diff report written to ${DIFF_REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

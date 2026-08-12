#!/usr/bin/env node
/**
 * fix-knottingley-doncaster-attribution.mjs — one-off correction for the
 * three Knottingley junction-throat ways (Down Doncaster / Up Doncaster,
 * way ids 3698003, 203748595, 548427963).
 *
 * WHY THIS EXISTS AS A SEPARATE SCRIPT, NOT A FIX INSIDE ingest-branch-ways.mjs.
 * That script is documented additive-only (see its own header): it never
 * edits or removes anything from an already-present way_id, only appends
 * segments for ways not yet in the graph. All three of these ways are
 * already in the graph (added under the old `pontefract`/`askern` name
 * filters before their `askern_doncaster_throat` wayIds entry existed), so
 * re-running ingest-branch-ways.mjs — even after adding that entry — cannot
 * touch them; it will just report them as already-present and no-op. See
 * `askern_doncaster_throat` in ingest-branch-ways.mjs for the full factual
 * finding (live Overpass, 2026-08-12: ref:elr=KWS + railway:traffic_mode=
 * freight + usage=main on all three, matching all 22 other 'Knottingley West
 * Junction and Shaftholme Junction Line' ways; route relation 11040448
 * 'Knottingley - Shaftholme Line', route=railway, is the only relation any
 * of them belong to; no passenger route relation found).
 *
 * WHAT IT DOES. For each of the three way ids: drops any operator NOT in
 * the confirmed Askern passenger set (GC, GR) from the owning segment,
 * removes the corresponding operator_precision key, and — only if the
 * segment's ingest_branch was 'pontefract' (i.e. it actually needed
 * correcting) — relabels it 'askern_doncaster_throat' for provenance. A
 * segment already under 'askern' (this script found two of the three
 * already were, at ingest time — see the comment above) is left with its
 * existing ingest_branch untouched; only its operator list is normalized if
 * it happens to carry anything outside {GC, GR}, which in practice it does
 * not.
 *
 * DOES NOT TOUCH GEOMETRY, way_ids, nodes, coords, or any other segment.
 * DOES NOT touch any segment whose way_ids do not include one of these
 * three ids.
 *
 * Usage:
 *   node scripts/fix-knottingley-doncaster-attribution.mjs --dry-run
 *   node scripts/fix-knottingley-doncaster-attribution.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const DRY = process.argv.includes('--dry-run');

// Must match the `askern_doncaster_throat` entry in ingest-branch-ways.mjs.
const TARGET_WAY_IDS = new Set([3698003, 203748595, 548427963]);
const CONFIRMED_OPS = new Set(['GC', 'GR']);

const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));

let touched = 0;
for (const s of graph.segments) {
  if (!(s.way_ids || []).some((id) => TARGET_WAY_IDS.has(id))) continue;

  const before = { operators: [...s.operators], ingest_branch: s.ingest_branch };
  const dropped = s.operators.filter((op) => !CONFIRMED_OPS.has(op));
  if (!dropped.length && s.ingest_branch !== 'pontefract') continue; // already correct

  s.operators = s.operators.filter((op) => CONFIRMED_OPS.has(op));
  if (s.operator_precision) {
    for (const op of dropped) delete s.operator_precision[op];
  }
  if (before.ingest_branch === 'pontefract') s.ingest_branch = 'askern_doncaster_throat';

  touched++;
  console.log(`segment ${s.id} (way_ids ${JSON.stringify(s.way_ids)}):`);
  console.log(`  operators   ${JSON.stringify(before.operators)} -> ${JSON.stringify(s.operators)}`);
  console.log(`  ingest_branch  ${before.ingest_branch} -> ${s.ingest_branch}`);
}

console.log(`\n${touched} segment(s) corrected.`);

if (DRY) { console.log('DRY RUN — line-segments.json untouched.'); process.exit(0); }
if (touched) {
  writeFileSync(SEG_PATH, JSON.stringify(graph));
  console.log('Written:', SEG_PATH);
} else {
  console.log('Nothing to write.');
}

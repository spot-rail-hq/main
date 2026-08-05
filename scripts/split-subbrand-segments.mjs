#!/usr/bin/env node
/**
 * split-subbrand-segments.mjs — replaces a PARENT operator key on segments with
 * the real passenger-facing SUB-BRAND that runs each stretch.
 *
 * THE PROBLEM. `GTR` (Greater Thameslink Railway) is one legal entity carrying
 * four brands a passenger would name separately — Southern, Thameslink, Great
 * Northern, Gatwick Express. The segment graph only ever saw the parent, so all
 * four render in one colour. `SN` is the exception and only by accident: the bare
 * operator string "Southern" is not in GTR_FOLD, so it already escaped the fold.
 *
 * THE CLASSIFIER. Same shape as splitTflLine(), and deliberately so — but with a
 * second pass that TfL did not need:
 *
 *   1. NAME PREFIX. Route relations carry "Southern: Brighton → London Victoria".
 *      114 of 122 GTR relations match (93.4%). TfL matched 137/137, so this alone
 *      is weaker and cannot be the only rule.
 *   2. OPERATOR TAG. The other 8 turned out NOT to be unsplittable at all — they
 *      carry the brand in `operator` instead ("Southern Railway", "Thameslink
 *      Railway"). Between the two passes the split is 122/122 with nothing guessed.
 *
 * That second pass is why GTR_FOLD had to change: it caught "Southern Railway"
 * and "Thameslink Railway" BEFORE CANONICAL_TOC could map them to SN/TL. The fold
 * still catches the two genuine PARENT strings.
 *
 * PROVENANCE. Attribution here is SOURCED, not inferred — an OSM route relation
 * is an explicit upstream assertion of who runs the route, which is exactly what
 * `operator_precision` exists to distinguish. So these segments get NO
 * operator_precision entry, matching every other relation-derived segment.
 * Contrast ingest-branch-ways.mjs, where the operator is our own inference from
 * way tags that only name Network Rail.
 *
 * ADDITIVE ON THE PARENT. A parent key is only dropped from a segment once at
 * least one sub-brand has replaced it there. A GTR segment no relation resolves
 * keeps GTR, so nothing silently loses its colour.
 *
 * Usage: node scripts/split-subbrand-segments.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const DRY = process.argv.includes('--dry-run');

const GROUPS = [
  {
    key: 'gtr', parent: 'GTR', label: 'Greater Thameslink Railway -> 4 sub-brands',
    operatorRe: 'Thameslink|Govia|Southern|Great Northern|Gatwick',
    bbox: [50.6, -1.9, 53.0, 1.8],
    // name-prefix -> code
    byName: { 'Southern': 'SN', 'Thameslink': 'TL', 'Great Northern': 'GN', 'Gatwick Express': 'GX' },
    // operator tag -> code, for relations whose name carries no brand
    byOperator: { 'Southern': 'SN', 'Southern Railway': 'SN', 'Thameslink Railway': 'TL' },
    // GTR is a legal entity, not a service anyone rides. Once a sub-brand covers
    // a stretch, the parent has nothing left to mean there, so it is replaced.
    dropParent: true,
  },
  {
    key: 'stansted', parent: 'LE', label: 'Greater Anglia -> Stansted Express',
    operatorRe: 'Greater Anglia|Stansted',
    bbox: [51.4, -0.3, 52.1, 0.6],
    byName: { 'Stansted Express': 'SX' },
    byOperator: {},
    // ADDITIVE, unlike GTR. Greater Anglia is a real passenger brand in its own
    // right, and Stansted Express runs OVER ITS TRACK rather than instead of it —
    // the West Anglia Main Line carries GA's own Cambridge and Hertford services
    // on the same rails. Dropping LE here (the first dry run did) took it from
    // 140 segments to 105 and erased a service that genuinely runs. Both keys
    // stay, and the renderer draws them as two lanes, which is the truth.
    dropParent: false,
  },
];

async function overpass(q) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'srhq.uk-line-ingest/1.0 (+https://srhq.uk)',
      },
      body: 'data=' + encodeURIComponent(q),
    });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
    const wait = attempt * 15000;
    console.log(`    Overpass busy (HTTP ${res.status}) — retry ${attempt}/6 in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('Overpass failed after 6 attempts');
}

function brandFor(rel, g) {
  const name = (rel.tags && rel.tags.name) || '';
  for (const [prefix, code] of Object.entries(g.byName)) {
    if (name.startsWith(prefix + ':')) return { code, how: 'name' };
  }
  const op = (rel.tags && rel.tags.operator) || '';
  if (g.byOperator[op]) return { code: g.byOperator[op], how: 'operator' };
  return null;
}

async function main() {
  const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
  console.log(`Graph: ${graph.segments.length} segments\n`);
  const report = [];

  for (const g of GROUPS) {
    const [s, w, n, e] = g.bbox;
    // `out body` returns each relation's MEMBER LIST (way refs) without geometry
    // — the mapping this needs, at a fraction of `out geom`'s payload.
    const q = `[out:json][timeout:180];rel["type"="route"]["route"="train"]["operator"~"${g.operatorRe}",i](${s},${w},${n},${e});out body;`;
    console.log(`[${g.key}] ${g.label}`);
    const data = await overpass(q);
    const rels = (data.elements || []).filter((x) => x.type === 'relation');

    const wayBrand = new Map();   // wayId -> Set(codes)
    let byName = 0, byOp = 0, unresolved = [];
    for (const r of rels) {
      const b = brandFor(r, g);
      if (!b) { unresolved.push((r.tags && r.tags.name) || 'rel/' + r.id); continue; }
      b.how === 'name' ? byName++ : byOp++;
      for (const m of r.members || []) {
        if (m.type !== 'way') continue;
        if (!wayBrand.has(m.ref)) wayBrand.set(m.ref, new Set());
        wayBrand.get(m.ref).add(b.code);
      }
    }
    console.log(`    ${rels.length} relations: ${byName} by name prefix, ${byOp} by operator tag, ${unresolved.length} unresolved`);
    if (unresolved.length) unresolved.slice(0, 6).forEach((u) => console.log(`      UNRESOLVED (parent kept): ${u}`));
    console.log(`    ${wayBrand.size} distinct member ways carry a sub-brand`);

    let touched = 0, parentDropped = 0;
    const perCode = {};
    for (const seg of graph.segments) {
      const codes = new Set();
      for (const wid of seg.way_ids || []) {
        const b = wayBrand.get(wid);
        if (b) b.forEach((c) => codes.add(c));
      }
      if (!codes.size) continue;
      const before = seg.operators.slice();
      const next = new Set(seg.operators);
      codes.forEach((c) => next.add(c));
      // Only drop the parent once a sub-brand has actually replaced it here —
      // and only for groups whose parent is a shell rather than a real brand.
      if (g.dropParent && next.has(g.parent)) { next.delete(g.parent); parentDropped++; }
      seg.operators = [...next];
      if (before.join() !== seg.operators.join()) touched++;
      codes.forEach((c) => { perCode[c] = (perCode[c] || 0) + 1; });
    }
    console.log(`    segments touched: ${touched} (parent '${g.parent}' dropped from ${parentDropped})`);
    console.log(`    per sub-brand: ${JSON.stringify(perCode)}\n`);
    report.push({ key: g.key, parent: g.parent, relations: rels.length, byName, byOp, unresolved: unresolved.length, perCode });
  }

  const tally = {};
  for (const seg of graph.segments) for (const o of seg.operators) tally[o] = (tally[o] || 0) + 1;
  console.log('resulting segment counts for the affected keys:');
  for (const k of ['GTR', 'SN', 'TL', 'GN', 'GX', 'LE', 'SX']) console.log(`  ${k.padEnd(5)} ${tally[k] || 0}`);

  if (DRY) { console.log('\nDRY RUN — line-segments.json untouched.'); return; }
  graph.subbrand_split = { generated_at: new Date().toISOString(), groups: report };
  writeFileSync(SEG_PATH, JSON.stringify(graph));
  console.log('\nWritten:', SEG_PATH);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * split-subbrand-segments.mjs — replaces or extends a PARENT operator key on
 * segments with the real passenger-facing SUB-BRAND(S) that run each stretch.
 *
 * THE PROBLEM. `GTR` (Govia Thameslink Railway) is one legal entity carrying
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
 * A THIRD GROUP, A DIFFERENT SHAPE (2026-08-15): WMT (West Midlands Trains) is
 * NOT a GTR-style shell — WMR (West Midlands Railway) is a real brand with real
 * trains of its own, and London Northwestern (LN) is a second real brand sharing
 * the same operating company. Unlike GTR, WMR must not be unconditionally dropped
 * wherever LN appears: 324 of ~2,630 WMR-brand ways are PHYSICALLY SHARED with
 * LN-brand relations (confirmed live via Overpass member-list overlap,
 * 2026-08-15 investigation), so a naive `dropParent: true` would silently erase
 * WMR's own real service wherever it happens to run alongside LN. See
 * `dropParentIfUncovered` below — WMR is only removed from a segment when NONE
 * of that segment's ways are covered by a WMR-brand relation; where both brands'
 * relations cover the same way, both codes stay (additive, like Stansted/LE).
 * The classifier signal is different too: WMT relations carry a dedicated
 * `brand` tag (`West Midlands Railway` / `London Northwestern Railway`) rather
 * than a brand-prefixed `name` — 46/48 relations resolve directly off `brand`,
 * the remaining 2 (the unbranded Bedford <-> Bletchley shuttle pair) off an
 * `LNWR:` name prefix. 48/48, nothing guessed. See `byBrand` below.
 *
 * PROVENANCE. Attribution here is SOURCED, not inferred — an OSM route relation
 * is an explicit upstream assertion of who runs the route, which is exactly what
 * `operator_precision` exists to distinguish. So these segments get NO
 * operator_precision entry, matching every other relation-derived segment.
 * Contrast ingest-branch-ways.mjs, where the operator is our own inference from
 * way tags that only name Network Rail.
 *
 * ADDITIVE ON THE PARENT (GTR). A parent key is only dropped from a segment once
 * at least one sub-brand has replaced it there. A GTR segment no relation
 * resolves keeps GTR, so nothing silently loses its colour. WMT's parent (WMR)
 * uses the related-but-distinct `dropParentIfUncovered` rule described above —
 * see that flag's own comment in GROUPS for exactly how it differs.
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
// --only=<key> restricts a run to one group. Added 2026-08-15 alongside the
// WMT group specifically so a WMT run doesn't ALSO silently re-touch GTR/
// Stansted's already-committed segment counts against fresh (drifted) live
// OSM data — this is a full live-Overpass reprocessing script by design, so
// every group gets re-queried and re-applied on every plain run, which is
// correct when that's what's wanted but not as an incidental side effect of
// adding a new, unrelated group in the same file.
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const GROUPS = [
  {
    key: 'gtr', parent: 'GTR', label: 'Govia Thameslink Railway -> 4 sub-brands',
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
  {
    key: 'wmt', parent: 'WMR', label: 'West Midlands Trains -> WMR + London Northwestern',
    operatorRe: 'West Midlands Trains',
    // Covers the whole WMT network: Liverpool/Crewe in the north down through
    // Birmingham to London Euston, plus the Bedford <-> Bletchley shuttle.
    bbox: [51.4, -3.1, 53.5, -0.1],
    // WMT's route relation NAMES do not carry the brand as a prefix the way
    // GTR's do — they carry the LINE name instead ("Cross-City Line: Bromsgrove
    // => Lichfield Trent Valley", "LNWR: Birmingham New Street -> London
    // Euston"). `byName` here is deliberately narrow: it exists only to catch
    // the 2 unbranded Bedford<->Bletchley relations via their "LNWR:" prefix,
    // not as this group's primary signal.
    byName: { 'LNWR': 'LN' },
    byOperator: {}, // operator tag is uniformly "West Midlands Trains" for both brands — no use as a discriminator here
    // PRIMARY SIGNAL for this group — see byBrand support in brandFor() below.
    // Confirmed live 2026-08-15: every WMT relation carries brand="West
    // Midlands Railway" or brand="London Northwestern Railway" except the 2
    // caught by byName above. 46/48 direct + 2/48 name-prefix = 48/48.
    byBrand: { 'West Midlands Railway': 'WMR', 'London Northwestern Railway': 'LN' },
    // NEITHER dropParent NOR purely additive — WMR is a REAL brand (unlike
    // GTR's shell), so it must not be unconditionally dropped wherever LN
    // appears (324 ways are genuinely shared — see file header). But unlike
    // Stansted/LE, EVERY WMT segment currently carries WMR only as the
    // uncorrected national-build default (CANONICAL_TOC has no way to tell
    // WMR/LN apart from the bare "West Midlands Trains" operator tag), so a
    // segment covered ONLY by LN-brand relations should lose that stale
    // default WMR, not keep it. dropParentIfUncovered: WMR is removed from a
    // segment only when this group's classifier found NO WMR-brand relation
    // covering ANY of that segment's own ways — i.e. only when WMR's presence
    // there was never a real classification, just the leftover default.
    dropParent: false,
    dropParentIfUncovered: true,
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
  // byBrand FIRST when a group defines it (WMT) — a dedicated `brand` tag is
  // a more reliable signal than a name prefix or operator-tag guess, checked
  // ahead of both. GTR/Stansted don't define byBrand, so this is a no-op for
  // them — order among the other two is unchanged.
  if (g.byBrand) {
    const brand = (rel.tags && rel.tags.brand) || '';
    if (g.byBrand[brand]) return { code: g.byBrand[brand], how: 'brand' };
  }
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
    if (ONLY && g.key !== ONLY) continue;
    const [s, w, n, e] = g.bbox;
    // `out body` returns each relation's MEMBER LIST (way refs) without geometry
    // — the mapping this needs, at a fraction of `out geom`'s payload.
    const q = `[out:json][timeout:180];rel["type"="route"]["route"="train"]["operator"~"${g.operatorRe}",i](${s},${w},${n},${e});out body;`;
    console.log(`[${g.key}] ${g.label}`);
    const data = await overpass(q);
    const rels = (data.elements || []).filter((x) => x.type === 'relation');

    const wayBrand = new Map();   // wayId -> Set(codes)
    let byName = 0, byOp = 0, byBrandCount = 0, unresolved = [];
    for (const r of rels) {
      const b = brandFor(r, g);
      if (!b) { unresolved.push((r.tags && r.tags.name) || 'rel/' + r.id); continue; }
      if (b.how === 'name') byName++; else if (b.how === 'brand') byBrandCount++; else byOp++;
      for (const m of r.members || []) {
        if (m.type !== 'way') continue;
        if (!wayBrand.has(m.ref)) wayBrand.set(m.ref, new Set());
        wayBrand.get(m.ref).add(b.code);
      }
    }
    console.log(`    ${rels.length} relations: ${byBrandCount} by brand tag, ${byName} by name prefix, ${byOp} by operator tag, ${unresolved.length} unresolved`);
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
      // dropParentIfUncovered (WMT): the parent is a REAL brand, not a shell —
      // only remove it here if THIS group's own classifier found no relation
      // of the parent's own brand covering any of this segment's ways. If a
      // WMR-brand relation genuinely covers this segment too (the 324 shared
      // ways), codes.has('WMR') is true and the parent stays — both codes
      // render as two lanes, same as Stansted/LE.
      if (g.dropParentIfUncovered && next.has(g.parent) && !codes.has(g.parent)) { next.delete(g.parent); parentDropped++; }
      seg.operators = [...next];
      if (before.join() !== seg.operators.join()) touched++;
      codes.forEach((c) => { perCode[c] = (perCode[c] || 0) + 1; });
    }
    console.log(`    segments touched: ${touched} (parent '${g.parent}' dropped from ${parentDropped})`);
    console.log(`    per sub-brand: ${JSON.stringify(perCode)}\n`);
    report.push({ key: g.key, parent: g.parent, relations: rels.length, byName, byOp, byBrand: byBrandCount, unresolved: unresolved.length, perCode });
  }

  const tally = {};
  for (const seg of graph.segments) for (const o of seg.operators) tally[o] = (tally[o] || 0) + 1;
  console.log('resulting segment counts for the affected keys:');
  for (const k of ['GTR', 'SN', 'TL', 'GN', 'GX', 'LE', 'SX', 'WMR', 'LN']) console.log(`  ${k.padEnd(5)} ${tally[k] || 0}`);
  const sxShared = graph.segments.filter((s) => s.operators.includes('LE') && s.operators.includes('SX')).length;
  const wmtShared = graph.segments.filter((s) => s.operators.includes('WMR') && s.operators.includes('LN')).length;
  console.log(`  (of which LE+SX both:  ${sxShared})`);
  console.log(`  (of which WMR+LN both: ${wmtShared})`);

  if (DRY) { console.log('\nDRY RUN — line-segments.json untouched.'); return; }
  // MERGE, don't replace — a --only run must not destroy the OTHER groups'
  // provenance from an earlier run (bit this exact way once already while
  // developing the --only flag: a --only=wmt run wiped gtr/stansted's
  // subbrand_split.groups entries entirely). Keep every previous entry whose
  // key wasn't touched this run; overwrite/insert entries for keys that were.
  var prevGroups = (graph.subbrand_split && graph.subbrand_split.groups) || [];
  var touchedKeys = new Set(report.map(function (r) { return r.key; }));
  var mergedGroups = prevGroups.filter(function (r) { return !touchedKeys.has(r.key); }).concat(report);
  graph.subbrand_split = { generated_at: new Date().toISOString(), groups: mergedGroups };
  writeFileSync(SEG_PATH, JSON.stringify(graph));
  console.log('\nWritten:', SEG_PATH);
}

main().catch((e) => { console.error(e); process.exit(1); });

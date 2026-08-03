#!/usr/bin/env node
/**
 * build-locomotive-data.mjs — data/rolling-stock.json -> data/site-data.json
 *
 *   node scripts/build-locomotive-data.mjs
 *   node scripts/build-locomotive-data.mjs --check   (verify only, no write)
 *
 * WHY THIS EXISTS. site-data.json used to be maintained BY HAND alongside
 * rolling-stock.json, and the two had already drifted: 22 rows carried curated
 * Wikimedia "File:" links that the export did not have. Hand-syncing two copies
 * of 168 rows through a schema change is where rows get silently dropped, so
 * site-data.json is now generated and must not be edited directly.
 *
 * THE THREE INPUTS
 *   1. data/rolling-stock.json          raw spreadsheet export. Overwritten
 *                                       wholesale on re-export — never hand-edit.
 *                                       Also read as-is by
 *                                       audit-locomotive-image-licenses.mjs,
 *                                       which this script does not affect.
 *   2. data/rolling-stock-overrides.json  hand-curated per-class corrections
 *                                       applied on top of the export, so they
 *                                       survive a re-export. Unknown keys pass
 *                                       straight through onto the class object
 *                                       (this is where Prompt B's photographer/
 *                                       license/sourceUrl fields will land).
 *   3. CROSS_LISTINGS below             which classes appear in more than one
 *                                       section.
 *
 * THE UNIFIED SCHEMA. The export has THREE different header shapes across its
 * seven sections, and column index 6 means "Operator(s)" in five of them,
 * "Fleet Size" in one and "Main Heritage Lines" in another. Every row is mapped
 * here into one named-field object, so column POSITION carries no meaning
 * downstream — database.html renders from field names via each section's
 * `columns` list. A field that does not apply to a section is simply absent.
 *
 * IDEMPOTENT: output depends only on the three inputs. Running twice produces
 * byte-identical output (`--check` asserts exactly that against what is on disk).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data', 'rolling-stock.json');
const OVERRIDES = path.join(ROOT, 'data', 'rolling-stock-overrides.json');
const OUT = path.join(ROOT, 'data', 'site-data.json');

// ── Section definitions ──────────────────────────────────────────────────
// `slug` is the category id used in categories[] and in secondary DOM ids.
// `fields` maps the section's column INDEX -> unified field name. This is the
// only place positional knowledge lives.
//
// Non-obvious mappings, all deliberate:
//   - Light Rail's "Fleet Name" is a marketing/fleet name, the same KIND of
//     value as the standard sections' "Name / Nickname" -> both `name`.
//   - Heritage's "Type / Role" is NOT a name ("BR passenger tank engine"), so it
//     gets its own `role` field rather than being flattened into `name`.
//   - "Traction Type" / "Power Supply" / "Traction" all answer "how is it
//     powered" -> one `traction` field.
//   - "Year Intro" and "Year(s) Built" are different questions (entered service
//     vs construction period) and stay separate.
//   - "Primary Route / Service", "City / Network" and "Main Heritage Lines" all
//     loosely mean "where it runs", but a service description, a network
//     identity and a list of railways are not interchangeable, so they stay
//     three fields rather than being merged lossily.
const SECTIONS = [
  {
    slug: 'intercity', name: 'Intercity & High Speed',
    fields: { 0: 'class', 1: 'name', 2: 'traction', 3: 'builder', 4: 'yearIntro', 5: 'maxSpeedMph', 6: 'operators', 7: 'primaryService', 8: 'notes', 9: 'image' },
  },
  {
    slug: 'regional', name: 'Regional Passenger',
    fields: { 0: 'class', 1: 'name', 2: 'traction', 3: 'builder', 4: 'yearIntro', 5: 'maxSpeedMph', 6: 'operators', 7: 'primaryService', 8: 'notes', 9: 'image' },
  },
  {
    slug: 'commuter', name: 'Commuter & Suburban',
    fields: { 0: 'class', 1: 'name', 2: 'traction', 3: 'builder', 4: 'yearIntro', 5: 'maxSpeedMph', 6: 'operators', 7: 'primaryService', 8: 'notes', 9: 'image' },
  },
  {
    slug: 'freight', name: 'Freight',
    fields: { 0: 'class', 1: 'name', 2: 'traction', 3: 'builder', 4: 'yearIntro', 5: 'maxSpeedMph', 6: 'operators', 7: 'primaryService', 8: 'notes', 9: 'image' },
  },
  {
    slug: 'charter', name: 'Charter & Railtours',
    fields: { 0: 'class', 1: 'name', 2: 'traction', 3: 'builder', 4: 'yearIntro', 5: 'maxSpeedMph', 6: 'operators', 7: 'primaryService', 8: 'notes', 9: 'image' },
  },
  {
    slug: 'metro', name: 'Light Rail & Metro',
    fields: { 0: 'class', 1: 'name', 2: 'traction', 3: 'builder', 4: 'yearIntro', 5: 'maxSpeedMph', 6: 'fleetSize', 7: 'cityNetwork', 8: 'notes', 9: 'image' },
  },
  {
    slug: 'heritage', name: 'Heritage & Preserved',
    fields: { 0: 'class', 1: 'role', 2: 'traction', 3: 'builder', 4: 'yearsBuilt', 5: 'preservedExamples', 6: 'mainHeritageLines', 7: 'mainlineCertified', 8: 'notes', 9: 'image' },
  },
];

// Display columns per section, by FIELD NAME. Position here is presentation
// only — changing the order cannot change what a value means.
const COLUMNS = {
  standard: [
    { field: 'class', label: 'Class' },
    { field: 'name', label: 'Name / Nickname' },
    { field: 'traction', label: 'Traction Type' },
    { field: 'builder', label: 'Builder' },
    { field: 'yearIntro', label: 'Year Intro' },
    { field: 'maxSpeedMph', label: 'Max Speed (mph)' },
    { field: 'operators', label: 'Operator(s)' },
    { field: 'primaryService', label: 'Primary Route / Service' },
  ],
  metro: [
    { field: 'class', label: 'System / Class' },
    { field: 'name', label: 'Fleet Name' },
    { field: 'traction', label: 'Power Supply' },
    { field: 'builder', label: 'Builder' },
    { field: 'yearIntro', label: 'Year Intro' },
    { field: 'maxSpeedMph', label: 'Max Speed (mph)' },
    { field: 'fleetSize', label: 'Fleet Size' },
    { field: 'cityNetwork', label: 'City / Network' },
  ],
  heritage: [
    { field: 'class', label: 'Class / Loco' },
    { field: 'role', label: 'Type / Role' },
    { field: 'traction', label: 'Traction' },
    { field: 'builder', label: 'Builder' },
    { field: 'yearsBuilt', label: 'Year(s) Built' },
    { field: 'preservedExamples', label: 'Preserved Examples' },
    { field: 'mainHeritageLines', label: 'Main Heritage Lines' },
    { field: 'mainlineCertified', label: 'Mainline Certified?' },
  ],
};
const COLUMN_SET = {
  intercity: 'standard', regional: 'standard', commuter: 'standard',
  freight: 'standard', charter: 'standard', metro: 'metro', heritage: 'heritage',
};

// Fields shown in the expanded panel rather than the row grid. `notes` is the
// full-width panel body (Step 3); `image` drives the photo frame.
const PANEL_FIELDS = ['notes', 'image', 'numberBuilt', 'capacity', 'serviceYears'];

// ── Cross-listings ───────────────────────────────────────────────────────
// APPROVED SET ONLY (2026-08-04). `home` is the section the row physically
// lives in in the export and stays categories[0] — i.e. the canonical DOM id is
// unchanged, which is what keeps the map.html Fleet-chip anchors resolving.
// `also` are the additional sections it renders under.
//
// `note` is DRAFT COPY, flagged for review — see the report. It is emitted as
// `crossListNote` and rendered in the expanded panel.
//
// NOTE ON HOMES: 20/37/47 live in Charter & Railtours in the export, not in
// Freight — checked, not assumed. The approved pairing "20/37/47 <-> Charter/
// Heritage" therefore means Charter is already the home and Heritage is the
// added section. The build warns and exits non-zero if any `match` misses, so a
// wrong home cannot pass silently.
const CROSS_LISTINGS = [
  {
    match: { section: 'Commuter & Suburban', class: '777' }, also: ['metro'],
    note: 'Also listed under Light Rail & Metro: the Class 777 works Merseyrail’s self-contained third-rail network, which runs as a city metro rather than a conventional commuter railway.',
  },
  {
    match: { section: 'Intercity & High Speed', class: '43' }, also: ['charter'],
    note: 'Also listed under Charter & Railtours: alongside ScotRail Inter7City duties, HST power cars are regularly used on charter, test and support workings.',
  },
  {
    match: { section: 'Charter & Railtours', class: '20' }, also: ['heritage'],
    note: 'Also listed under Heritage & Preserved: surviving Class 20s are split between mainline charter work and preserved operation on heritage lines.',
  },
  {
    match: { section: 'Charter & Railtours', class: '37' }, also: ['heritage'],
    note: 'Also listed under Heritage & Preserved: the Class 37 remains in mainline charter and infrastructure use while a large preserved fleet runs on heritage railways.',
  },
  {
    match: { section: 'Charter & Railtours', class: '47' }, also: ['heritage'],
    note: 'Also listed under Heritage & Preserved: Class 47s continue on charter and support duties, with many more preserved across heritage lines.',
  },
  // 2026-08-04 (second pass) — the other three classes that had been recorded
  // TWICE (once in Commuter, once in Light Rail & Metro) before categories[]
  // existed. The duplicate rows are merged away in mergeDuplicates; these
  // entries are what actually keeps them visible under Light Rail & Metro.
  {
    match: { section: 'Commuter & Suburban', class: '345' }, also: ['metro'],
    note: 'Also listed under Light Rail & Metro: the Elizabeth line runs as a high-frequency cross-London metro through its central section while remaining a National Rail service at both ends.',
  },
  {
    match: { section: 'Commuter & Suburban', class: '378' }, also: ['metro'],
    note: 'Also listed under Light Rail & Metro: the Class 378 works London Overground’s orbital network, operated by TfL as part of the London metro system rather than as a conventional commuter railway.',
  },
  {
    match: { section: 'Commuter & Suburban', class: '710' }, also: ['metro'],
    note: 'Also listed under Light Rail & Metro: like the 378 it works TfL-operated London Overground routes, which sit inside the London metro network.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────
// MUST stay byte-identical to fleetClassSlug() in map.html AND database.html —
// those two already carry comments saying the same thing. This is the third
// copy and the reason the canonical DOM id below is left exactly as it was.
function fleetClassSlug(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

function build() {
  const raw = JSON.parse(readFileSync(SRC, 'utf8'));
  const ovFile = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
  const overrides = ovFile.overrides || {};
  const corrections = ovFile.corrections || {};
  const merges = ovFile.mergeDuplicates || [];
  const additions = ovFile.additions || {};

  // Pass 1 — map every row into the unified schema, keyed by its home section.
  const bySection = new Map();
  const warnings = [];
  for (const def of SECTIONS) {
    const sheet = raw[def.name];
    if (!sheet) throw new Error(`Section "${def.name}" missing from ${SRC}`);
    const title = clean(sheet[0] && sheet[0][0]);
    const subtitle = clean(sheet[1] && sheet[1][0]);
    const dataRows = sheet.slice(3).filter((r) => r && clean(r[0]));
    const classes = dataRows.map((row) => {
      const obj = {};
      for (const [idx, field] of Object.entries(def.fields)) {
        const v = clean(row[Number(idx)]);
        if (v) obj[field] = v;
      }
      // New fields (Step 1). Deliberately EMPTY, not guessed — every value here
      // has to be sourced. See the report: populating them is its own pass.
      obj.numberBuilt = obj.numberBuilt || '';
      obj.capacity = obj.capacity || '';
      obj.serviceYears = obj.serviceYears || '';
      const ov = (overrides[def.name] || {})[obj.class];
      if (ov) Object.assign(obj, ov); // unknown keys pass through by design
      const corr = (corrections[def.name] || {})[obj.class];
      if (corr) {
        for (const [k, v] of Object.entries(corr)) {
          if (k.startsWith('_')) continue; // _why is documentation, not a field
          obj[k] = v;
        }
        obj.hasCorrections = true;
      }
      return obj;
    });
    // ADDITIONS — classes that do not exist in the export at all. They live in
    // the overrides file rather than in rolling-stock.json because that file is
    // overwritten wholesale on re-export, which would delete them. Already in
    // unified-schema shape, so they only need the same empty-field defaults.
    // `_source` and `verifyFields` are carried through onto the class object on
    // purpose: an added class states where its figures came from, and which of
    // them are still blank pending verification.
    for (const add of additions[def.name] || []) {
      const obj = { ...add };
      for (const f of ['numberBuilt', 'capacity', 'serviceYears']) obj[f] = obj[f] || '';
      if (classes.some((c) => c.class === obj.class)) {
        warnings.push(`addition "${obj.class}" already exists in "${def.name}" — skipped`);
        continue;
      }
      obj.isAddition = true;
      classes.push(obj);
    }
    bySection.set(def.slug, { def, title, subtitle, classes });
  }

  // Pass 1b — duplicate merges. The SAME real-world class recorded twice under
  // different key formats (e.g. "777" in Commuter and "Class 777 — Merseyrail"
  // in Light Rail & Metro) predates categories[] and is what the cross-listing
  // model replaces. The kept row absorbs the named fields from the removed one
  // — the unified schema holds both sides' columns, so the merge is lossless —
  // and the removed row disappears so it stops being counted as a second class.
  for (const m of merges) {
    const keepDef = SECTIONS.find((s) => s.name === m.keep.section);
    const remDef = SECTIONS.find((s) => s.name === m.remove.section);
    if (!keepDef || !remDef) { warnings.push(`merge: unknown section in ${JSON.stringify(m)}`); continue; }
    const keepBucket = bySection.get(keepDef.slug), remBucket = bySection.get(remDef.slug);
    const keep = keepBucket.classes.find((c) => c.class === m.keep.class);
    const idx = remBucket.classes.findIndex((c) => c.class === m.remove.class);
    if (!keep || idx === -1) { warnings.push(`merge: row not found for ${JSON.stringify(m)}`); continue; }
    const removed = remBucket.classes[idx];
    for (const f of m.mergeFields || []) {
      if (removed[f] && !keep[f]) keep[f] = removed[f];
    }
    keep.mergedFrom = `${m.remove.section} / ${m.remove.class}`;
    remBucket.classes.splice(idx, 1);
  }

  // Pass 2 — categories[]. categories[0] is the home section, so the canonical
  // DOM id never moves.
  const bySlugClass = new Map();
  for (const [slug, s] of bySection) {
    for (const c of s.classes) {
      c.categories = [slug];
      bySlugClass.set(slug + ' ' + c.class, c);
    }
  }
  for (const cl of CROSS_LISTINGS) {
    const home = SECTIONS.find((s) => s.name === cl.match.section);
    if (!home) { warnings.push(`cross-listing: unknown section "${cl.match.section}"`); continue; }
    const target = bySlugClass.get(home.slug + ' ' + cl.match.class);
    if (!target) { warnings.push(`cross-listing: class "${cl.match.class}" not found in "${cl.match.section}"`); continue; }
    for (const extra of cl.also) {
      if (!bySection.has(extra)) { warnings.push(`cross-listing: unknown target category "${extra}"`); continue; }
      if (target.categories.includes(extra)) continue;
      target.categories.push(extra);
    }
    target.crossListNote = cl.note;
    target.crossListNoteStatus = 'draft-needs-review';
  }

  // Pass 3 — emit. A cross-listed class is emitted into each of its categories
  // so the renderer needs no lookups; `domId` differs per instance and
  // `isCanonicalHere` marks the one that owns the bare anchor.
  const categories = SECTIONS.map((def) => {
    const s = bySection.get(def.slug);
    const members = [];
    for (const [, other] of bySection) {
      for (const c of other.classes) {
        if (!c.categories.includes(def.slug)) continue;
        const canonical = c.categories[0] === def.slug;
        members.push({
          ...c,
          domId: canonical ? `fleet-${fleetClassSlug(c.class)}` : `fleet-${fleetClassSlug(c.class)}--${def.slug}`,
          isCanonicalHere: canonical,
          homeCategory: c.categories[0],
        });
      }
    }
    return {
      slug: def.slug, name: def.name, title: s.title, subtitle: s.subtitle,
      // PER-SECTION count: a cross-listed class counts in every section it
      // appears in. Distinct from totalClasses below.
      count: members.length,
      columns: COLUMNS[COLUMN_SET[def.slug]],
      panelFields: PANEL_FIELDS,
      classes: members,
    };
  });

  // GLOBAL count: each class ONCE, however many categories it is listed under.
  const distinct = new Set();
  for (const [slug, s] of bySection) for (const c of s.classes) distinct.add(slug + ' ' + c.class);

  return {
    payload: {
      _notes: 'GENERATED by scripts/build-locomotive-data.mjs from data/rolling-stock.json + data/rolling-stock-overrides.json. DO NOT HAND-EDIT — re-run the script instead. Rows use a unified named-field schema; column position carries no meaning. `totalClasses` counts each class once; each category\'s `count` counts classes appearing in that section, so a cross-listed class contributes to several section counts but only one global count.',
      totalClasses: distinct.size,
      crossListedClasses: [...bySection.values()].flatMap((s) => s.classes).filter((c) => c.categories.length > 1).length,
      categories,
    },
    warnings,
  };
}

const { payload, warnings } = build();
const json = JSON.stringify(payload, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current === json) { console.log('site-data.json is up to date (byte-identical).'); process.exit(0); }
  console.error('site-data.json DIFFERS from a fresh build — re-run without --check.');
  process.exit(1);
}

writeFileSync(OUT, json);
for (const w of warnings) console.warn('WARNING: ' + w);
console.log(`Wrote ${path.relative(ROOT, OUT)}`);
console.log(`  distinct classes (global total): ${payload.totalClasses}`);
console.log(`  cross-listed classes:            ${payload.crossListedClasses}`);
for (const c of payload.categories) console.log(`  ${c.name.padEnd(24)} ${String(c.count).padStart(3)} in section`);
console.log(`  sum of section counts:           ${payload.categories.reduce((s, c) => s + c.count, 0)}`);
if (warnings.length) process.exitCode = 1;

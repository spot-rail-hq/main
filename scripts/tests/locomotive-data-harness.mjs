/**
 * REGRESSION HARNESS — data/site-data.json integrity + count semantics.
 * See ./README.md for the approach. Run: node scripts/tests/locomotive-data-harness.mjs
 *
 * Unlike the other three harnesses this one does NOT slice map.html — site-data.json
 * is a generated artefact, so the checks run against the built file plus its two
 * inputs. It guards the invariants the 2026-08-04 schema migration introduced:
 * global-vs-per-section count semantics, DOM id uniqueness, and — most
 * importantly — that the 83 map.html Fleet-chip anchors still resolve, which is a
 * cross-file contract nothing else enforces.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const site = JSON.parse(readFileSync(path.join(ROOT, 'data', 'site-data.json'), 'utf8'));
const raw = JSON.parse(readFileSync(path.join(ROOT, 'data', 'rolling-stock.json'), 'utf8'));
const ops = JSON.parse(readFileSync(path.join(ROOT, 'operators-content.json'), 'utf8'));

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); failures++; }
}
// Must stay byte-identical to map.html / database.html / build-locomotive-data.mjs.
function fleetClassSlug(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const allInstances = site.categories.flatMap((c) => c.classes);
const canonical = allInstances.filter((k) => k.isCanonicalHere);

console.log('\n=== count semantics ===');
check('totalClasses equals the number of canonical instances',
  site.totalClasses === canonical.length, `${site.totalClasses} vs ${canonical.length}`);
check('every class has exactly one canonical instance',
  new Set(canonical.map((k) => k.homeCategory + ' ' + k.class)).size === canonical.length);
const sectionSum = site.categories.reduce((s, c) => s + c.count, 0);
const extra = allInstances.length - canonical.length;
check('sum(section counts) = totalClasses + cross-listed extra instances',
  sectionSum === site.totalClasses + extra, `${sectionSum} vs ${site.totalClasses} + ${extra}`);
check('each category.count matches its own classes array length',
  site.categories.every((c) => c.count === c.classes.length));
check('a cross-listed class is counted once globally, many times per-section',
  site.crossListedClasses > 0 && sectionSum > site.totalClasses);

console.log('\n=== DOM ids ===');
const ids = allInstances.map((k) => k.domId);
check('all instance DOM ids are unique', new Set(ids).size === ids.length,
  `${ids.length} ids, ${new Set(ids).size} unique`);
check('canonical ids carry NO category suffix (bare fleet-{slug})',
  canonical.every((k) => k.domId === 'fleet-' + fleetClassSlug(k.class)));
check('secondary ids are suffixed with their category slug',
  allInstances.filter((k) => !k.isCanonicalHere)
    .every((k) => /^fleet-.+--[a-z]+$/.test(k.domId)));

console.log('\n=== map.html Fleet-chip anchor contract ===');
const chipIds = new Set();
(function walk(o) {
  if (Array.isArray(o)) return o.forEach(walk);
  if (o && typeof o === 'object') {
    if (Array.isArray(o.fleet_classes)) {
      for (const f of o.fleet_classes) if (f && f.id != null) chipIds.add(String(f.id));
    }
    Object.values(o).forEach(walk);
  }
})(ops);
const idSet = new Set(ids);
const resolving = [...chipIds].filter((id) => idSet.has('fleet-' + fleetClassSlug(id)));
// 83 was measured against the pre-migration file (2026-08-04). It is a FLOOR:
// adding classes may raise it, but it must never drop — that would mean a Fleet
// chip in map.html stopped landing on a row.
check('at least 83 Fleet chips still resolve to a row',
  resolving.length >= 83, `${resolving.length} of ${chipIds.size} chips resolve`);
// The seven classes added 2026-08-04 specifically to close broken chip links.
// Named individually so a regression names the class rather than just a count.
const FIXED_CHIPS = ['139', '168', '197', '231', '318', '398', '756'];
const stillBroken = FIXED_CHIPS.filter((id) => !idSet.has('fleet-' + fleetClassSlug(id)));
check('the 7 previously-broken Fleet chips now resolve',
  stillBroken.length === 0, 'still broken: ' + stillBroken.join(', '));
// Whatever remains unresolved should be only the non-class ids (coaching stock,
// TGV sets, the 01/5 shunter) — deliberately out of scope, see the report.
const unresolved = [...chipIds].filter((id) => !idSet.has('fleet-' + fleetClassSlug(id)));
check('remaining unresolved chips are only the known out-of-scope ids',
  unresolved.every((id) => ['mark5', 'mark5a', 'pba', 'pbka', '01/5'].includes(id)),
  'unexpected unresolved: ' + unresolved.join(', '));

console.log('\n=== nothing silently dropped ===');
const rawCount = Object.entries(raw)
  .filter(([k]) => k !== 'OVERVIEW' && k !== 'Legend')
  .reduce((s, [, rows]) => s + rows.slice(3).filter((r) => r && String(r[0]).trim()).length, 0);
// CANONICAL instances only: a merged class that is also cross-listed appears
// more than once, and every instance carries the same `mergedFrom` marker, so
// counting all instances would over-count the merges that actually happened.
const merged = canonical.filter((k) => k.mergedFrom).length;
// The reconciliation that makes a silent drop impossible:
//   raw export rows  -  duplicates merged away  +  classes added in overrides
//   = canonical classes in the built file
// Additions are classes that exist ONLY in rolling-stock-overrides.json (the
// export is overwritten on re-export, so new rows cannot live there).
const added = canonical.filter((k) => k.isAddition).length;
check('raw rows - merged duplicates + additions = canonical classes',
  rawCount - merged + added === canonical.length,
  `${rawCount} raw - ${merged} merged + ${added} added = ${rawCount - merged + added}, built has ${canonical.length}`);
check('every canonical class has a non-empty class value',
  canonical.every((k) => k.class && k.class.trim()));
check('every instance carries a categories array containing its own section',
  site.categories.every((c) => c.classes.every((k) => k.categories.includes(c.slug))));
check('categories[0] is always the home category',
  allInstances.every((k) => k.categories[0] === k.homeCategory));

console.log('\n=== schema unification ===');
check('no instance carries a positional `row` array', allInstances.every((k) => !Array.isArray(k.row)));
check('every category defines named columns',
  site.categories.every((c) => Array.isArray(c.columns) && c.columns.every((col) => col.field && col.label)));
check('new fields exist on every class (may be empty, never absent)',
  allInstances.every((k) => 'numberBuilt' in k && 'capacity' in k && 'serviceYears' in k));
check('Formation/Status appear nowhere (they never existed to drop)',
  !allInstances.some((k) => 'formation' in k || 'status' in k));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);

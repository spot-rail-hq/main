/**
 * REGRESSION HARNESS — regionKeyFor() + data/station-regions.json coverage.
 * Run: node scripts/tests/station-region-harness.mjs
 *
 * shared.jsx has no build step and is loaded in the browser as a
 * text/babel script (React JSX, plus top-level `Object.assign(window, …)`
 * that fails outside a browser) — it cannot be `import`ed directly by plain
 * Node, so this follows the same pattern as the map.html harnesses (see
 * ./README.md): slice `regionKeyFor()`'s source text straight out of
 * shared.jsx and eval it with `new Function(...)`. That means this tests the
 * REAL shipped function, not a copy that can silently drift.
 *
 * Asserts the invariant CLAUDE.md's station-regions note exists to protect:
 * every one of the 3,443 current stations in station-list.json must resolve,
 * via regionKeyFor(), to a real entry in data/station-regions.json's
 * `current` map, whose `region` code is itself a real key in that file's own
 * `regions` table. A wrong join here (e.g. keying on a station's own
 * AdministrativeAreaCode instead of going through its locality) silently
 * produces plausible-looking garbage rather than an obvious failure — see
 * CLAUDE.md's "admin-area-110 trap" — so this is a floor-value coverage
 * check, not a spot check.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shared = readFileSync(path.join(ROOT, 'shared.jsx'), 'utf8');
const stations = JSON.parse(readFileSync(path.join(ROOT, 'station-list.json'), 'utf8'));
const regionsFile = JSON.parse(readFileSync(path.join(ROOT, 'data', 'station-regions.json'), 'utf8'));

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); failures++; }
}

// ── Slice regionKeyFor() out of shared.jsx ──────────────────────────────
const startMarker = 'function regionKeyFor(station) {';
const startIdx = shared.indexOf(startMarker);
if (startIdx === -1) throw new Error('slice missing: function regionKeyFor(station) { not found in shared.jsx');
// Body is 4 lines, closed by a bare `}` at zero indentation — same
// slice-to-next-top-level-close approach the map.html harnesses use.
const closeIdx = shared.indexOf('\n}', startIdx);
if (closeIdx === -1) throw new Error('slice missing: regionKeyFor() body not closed by a top-level "}"');
const src = shared.slice(startIdx, closeIdx + 2);
if (!src.includes('station.atco') || !src.includes("'crs:'")) {
  throw new Error('slice looks wrong: regionKeyFor() no longer mentions station.atco / crs: — check the marker still matches shared.jsx');
}
const regionKeyFor = new Function('station', src + '\nreturn regionKeyFor(station);');

console.log('\n=== regionKeyFor() resolution ===');

const current = regionsFile.current;
const regions = regionsFile.regions;

const results = stations.map((s) => {
  const key = regionKeyFor(s);
  const entry = key != null ? current[key] : undefined;
  return { station: s, key, entry };
});

check('every station produces a non-null key',
  results.every((r) => r.key != null),
  'missing key for: ' + results.filter((r) => r.key == null).map((r) => r.station.crs).join(', '));

const unresolved = results.filter((r) => !r.entry);
check(`all ${stations.length} stations resolve to a station-regions.json entry`,
  unresolved.length === 0,
  `${unresolved.length} unresolved: ` + unresolved.slice(0, 10).map((r) => `${r.station.crs} (key ${r.key})`).join(', '));

const badRegion = results.filter((r) => r.entry && !regions[r.entry.region]);
check('every resolved region code is a real key in the regions table',
  badRegion.length === 0,
  badRegion.slice(0, 10).map((r) => `${r.station.crs}: region "${r.entry.region}"`).join(', '));

// atco-first, crs: fallback only for stations with no atco of their own.
const atcoStations = stations.filter((s) => s.atco);
const crsFallbackStations = stations.filter((s) => !s.atco);
check('every station with its own atco resolves via that atco (not the crs: fallback)',
  atcoStations.every((s) => regionKeyFor(s) === s.atco));
check('every station with no atco resolves via the crs: fallback key',
  crsFallbackStations.every((s) => regionKeyFor(s) === 'crs:' + s.crs));
// CLAUDE.md documents 7 such stations (Bond Street, Barking Riverside,
// Custom House, Canary Wharf, Tottenham Court Road, Woolwich, Southampton
// Town Quay) — asserted by name, not just count, so a drift names itself.
const EXPECTED_CRS_FALLBACK = ['BDS', 'BGV', 'CUS', 'CWX', 'STQ', 'TCR', 'WWC'].sort();
check('the crs: fallback set is exactly the 7 stations CLAUDE.md documents',
  JSON.stringify(crsFallbackStations.map((s) => s.crs).sort()) === JSON.stringify(EXPECTED_CRS_FALLBACK),
  'got: ' + crsFallbackStations.map((s) => s.crs).sort().join(', '));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);

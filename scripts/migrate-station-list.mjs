#!/usr/bin/env node
/**
 * scripts/migrate-station-list.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Migrates station-list.json from {name, crs, lat, lon} to
 * {name, crs, atco, mode, network, lat, lon, interchange?} and appends the
 * tram/metro/underground stations extracted by fetch-naptan-stops.mjs.
 *
 * Run (fetch first — this reads its output, it does not download anything):
 *   node scripts/fetch-naptan-stops.mjs
 *   node scripts/migrate-station-list.mjs            # dry run, writes nothing
 *   node scripts/migrate-station-list.mjs --write
 *
 * SOLE WRITER of station-list.json. Idempotent: re-running against an
 * already-migrated file produces the same result, because the existing rows are
 * matched on `crs` and the appended rows on `atco`, neither of which this
 * script invents.
 *
 * ─── ADDITIVE, never a rebuild ────────────────────────────────────────────
 * A clean regenerate from NaPTAN's active RLY rows would look tidier and would
 * be WRONG: six CRS stations in the current file have no active RLY row at all
 * — BDS Bond Street, CUS Custom House, CWX Canary Wharf, TCR Tottenham Court
 * Road, WWC Woolwich, BGV Barking Riverside — because NaPTAN files them under
 * their Underground/DLR identity instead. Rebuilding would drop all six and
 * silently take their Darwin departure boards with them. So every existing row
 * is preserved and only annotated.
 *
 * ONE deliberate deletion: AGR Angel Road, closed 2019 and replaced by Meridian
 * Water. It is removed because it is genuinely shut, not as a side effect of the
 * rebuild it isn't. Recorded here so the row count drop is traceable.
 *
 * ─── `atco` backfill is a COORDINATE join, not a CRS lookup ───────────────
 * NaPTAN's CSV has no CRS column, and the ATCO code does not embed one either —
 * RLY codes are 9100 + a TIPLOC-like alpha string ("9100ABDARE" for Aberdare),
 * not the 3-letter CRS. But both this file and NaPTAN descend from the same
 * source, so their coordinates are IDENTICAL rather than merely close: matching
 * on longitude/latitude rounded to 5 decimal places resolves 2,621 of 2,629
 * rows. That is why the 551 MB XML (the only format carrying CrsRef) is never
 * downloaded.
 *
 * The 8 rows that do not match keep `crs` as their identity and get
 * `atco: null`. They are NOT matched by proximity: confirmed live that
 * proximity would pair two of them WRONGLY — Canary Wharf's nearest MET stop is
 * West India Quay DLR (149 m) and Woolwich's is Woolwich Arsenal DLR (242 m),
 * both different stations. A near-miss is not an identity.
 *
 * ─── 150 m suppression ────────────────────────────────────────────────────
 * A tram/metro stop within SUPPRESS_M of an existing CRS station is not
 * appended as its own row; its ATCO is recorded on the CRS row's `interchange`
 * array instead. This stops a double dot appearing at every major interchange
 * (Paddington, King's Cross, Bank, Stratford) while keeping the fact that the
 * other network serves that station.
 *
 * NOTE ON THE EXPECTED COUNT: the scoping report quoted "~578 genuinely new
 * stops", which was the beyond-400 m figure. The confirmed decision is 150 m,
 * which suppresses fewer stops and therefore appends MORE of them — see the
 * printed summary for the real number. Both figures are correct for their own
 * radius; 150 m is the one implemented.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATION_LIST = path.join(ROOT, 'station-list.json');
const NAPTAN_STOPS = path.join(ROOT, 'scripts', 'output', 'naptan-stops.json');
const REPORT_MD = path.join(ROOT, 'scripts', 'output', 'station-list-migration.md');

const SUPPRESS_M = 150;

// ─── suppression needs NAME agreement, not just proximity ─────────────────
// Distance alone identifies a LOCATION, not an IDENTITY — the same reason the 8
// orphan rows above are not proximity-matched to an ATCO. In dense city centres
// tram stops sit 300-400m apart, so a 150m radius round a rail station
// occasionally captures the WRONG one and suppresses a real station out of the
// dataset entirely.
//
// Confirmed live on the first run: of 112 proximity suppressions, 10 had
// mismatched names and 4 of those were genuinely different stations —
// 9400ZZDLWIQ West India Quay was suppressed onto CWX Canary Wharf at 149m
// while Canary Wharf's own DLR stop (9400ZZDLCAN) sat in the file separately,
// and West Midlands Metro's St Chad's and Albert Street were absorbed into
// Birmingham Snow Hill and Moor Street.
//
// So: suppress only when the stop is within SUPPRESS_M *and* its name agrees
// with the host station's. The general rule fails SAFE — a disagreement leaves
// an extra dot rather than deleting a station.
const NAME_STOPWORDS = /\b(rail|railway|station|london|underground|dlr|for|the)\b/g;
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[’']/g, '')
    .replace(/\bst\.?\b/g, 'st')
    .replace(NAME_STOPWORDS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Confirmed same station (or one signed interchange complex) whose NaPTAN name
// simply differs from the National Rail name, so the name gate above would
// wrongly let them through as separate dots. Each verified by hand against the
// first run's mismatch list. Keyed ATCO -> CRS so a wrong pairing can never be
// introduced by editing only one side.
const SAME_STATION = {
  '9400ZZLUKSX': 'KGX', // King's Cross St. Pancras -> London Kings Cross
  '9400ZZTWCST': 'NCL', // Central Station -> Newcastle (Newcastle Central)
  '9400ZZGLBUC': 'GLQ', // Buchanan Street subway -> Glasgow Queen Street (signed interchange)
  '9400ZZWMNWS': 'BHM', // Grand Central -> Birmingham New Street (the stop serves New Street)
};

// Closed 2019, replaced by Meridian Water. The only row this migration removes.
const CLOSED_CRS = { AGR: 'Angel Road — closed 2019, replaced by Meridian Water' };

// Hand-curated mode/network overrides, keyed by CRS. This loop otherwise
// hardcodes every pre-existing row to mode:'rail'/network:'National Rail'
// (line ~10 below) rather than reading its own prior output, so an override
// applied any other way would be silently destroyed on the next re-run —
// this constant is the escape hatch, following the same pattern as
// SAME_STATION/CLOSED_CRS above rather than inventing a new one.
//
// STQ Southampton Town Quay (investigated 2026-08-16, see CLAUDE.md's
// station-regions note): a National Rail-ticketed replacement BUS stop (the
// QuayConnect shuttle to the Red Funnel ferry terminal), not rail
// infrastructure — it was never going to have an RLY NaPTAN record, so
// `atco: null` here is permanent and correct, not a gap. Tagged distinctly
// so it doesn't render as a normal station once a Stations tab exists.
const MODE_OVERRIDES = {
  STQ: { mode: 'bus', network: 'National Rail (replacement bus)' },
};

const COORD_DP = 5;
const coordKey = (lon, lat) => `${lon.toFixed(COORD_DP)},${lat.toFixed(COORD_DP)}`;

function haversineM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function main() {
  const write = process.argv.includes('--write');
  if (!existsSync(NAPTAN_STOPS)) {
    console.error(`Missing ${NAPTAN_STOPS} — run: node scripts/fetch-naptan-stops.mjs`);
    process.exit(1);
  }
  const naptan = JSON.parse(readFileSync(NAPTAN_STOPS, 'utf8'));
  const existing = JSON.parse(readFileSync(STATION_LIST, 'utf8'));
  if (!Array.isArray(existing)) throw new Error('station-list.json is not an array — refusing to migrate');

  console.log('── station-list.json migration ──');
  console.log(`  existing rows ${existing.length} · NaPTAN in-scope stops ${naptan.stops.length} · RLY join rows ${naptan.rail_refs.length}`);

  // ── 1. drop the closed station ───────────────────────────────────────────
  const removed = existing.filter((s) => CLOSED_CRS[s.crs]);
  const kept = existing.filter((s) => !CLOSED_CRS[s.crs]);
  for (const r of removed) console.log(`  removed ${r.crs} — ${CLOSED_CRS[r.crs]}`);

  // ── 2. atco backfill by exact-coordinate join ────────────────────────────
  const railByCoord = new Map();
  for (const r of naptan.rail_refs) railByCoord.set(coordKey(r.lon, r.lat), r);

  const migrated = [];
  const unmatched = [];
  for (const s of kept) {
    const hit = railByCoord.get(coordKey(s.lon, s.lat));
    if (!hit) unmatched.push(s);
    const override = MODE_OVERRIDES[s.crs];
    migrated.push({
      name: s.name,
      crs: s.crs,
      atco: hit ? hit.atco : null,
      mode: override ? override.mode : 'rail',
      network: override ? override.network : 'National Rail',
      lat: s.lat,
      lon: s.lon,
    });
  }
  console.log(`  atco backfilled ${migrated.filter((s) => s.atco).length}/${migrated.length} (${((migrated.filter((s) => s.atco).length / migrated.length) * 100).toFixed(1)}%)`);
  console.log(`  no RLY match — keeping crs as identity, atco null: ${unmatched.length}`);
  for (const s of unmatched) console.log(`     ${s.crs}  ${s.name}`);

  // ── 3. 150 m suppression ─────────────────────────────────────────────────
  // Nearest surviving CRS row wins. Bounding-box prefilter before the haversine
  // so this stays linear-ish rather than 741 × 2,628 trig calls.
  const suppressed = [];
  const appended = [];
  const keptDespiteProximity = [];
  for (const stop of naptan.stops) {
    let best = null, bestD = Infinity;
    for (const s of migrated) {
      if (Math.abs(s.lon - stop.lon) > 0.01 || Math.abs(s.lat - stop.lat) > 0.006) continue;
      const d = haversineM([s.lon, s.lat], [stop.lon, stop.lat]);
      if (d < bestD) { bestD = d; best = s; }
    }
    let nameOk = false, why = '';
    if (best) {
      if (SAME_STATION[stop.atco] === best.crs) { nameOk = true; why = 'curated same-station'; }
      else {
        const a = normName(stop.name), b = normName(best.name);
        if (a && b && (a === b || a.includes(b) || b.includes(a))) { nameOk = true; why = 'name match'; }
      }
    }
    if (best && bestD <= SUPPRESS_M && nameOk) {
      (best.interchange = best.interchange || []).push({
        atco: stop.atco, network: stop.network, mode: stop.mode,
      });
      suppressed.push({ ...stop, onto: best.crs, distance_m: Math.round(bestD), why });
      continue;
    }
    if (best && bestD <= SUPPRESS_M) {
      // Close enough to suppress but the names disagree — kept as its own row
      // and recorded, because deleting a station we cannot confirm is a
      // duplicate is the worse error. See the NAME_STOPWORDS comment.
      keptDespiteProximity.push({ atco: stop.atco, name: stop.name, network: stop.network, near: best.crs, near_name: best.name, distance_m: Math.round(bestD) });
    }
    const row = {
      name: stop.name,
      crs: null,
      atco: stop.atco,
      mode: stop.mode,
      network: stop.network,
      lat: stop.lat,
      lon: stop.lon,
    };
    // Provenance only where the cleanup actually changed something — the raw
    // NaPTAN string is what search would need if it is ever wired to match
    // "Underground"/"DLR"/"Tram Stop" text (a Phase 2/3 decision, not made here).
    if (stop.name_raw && stop.name_raw !== stop.name) row.name_raw = stop.name_raw;
    appended.push(row);
  }
  // Deterministic order for a reviewable diff.
  for (const s of migrated) if (s.interchange) s.interchange.sort((a, b) => a.atco.localeCompare(b.atco));
  appended.sort((a, b) => a.atco.localeCompare(b.atco));

  const out = migrated.concat(appended);
  console.log(`  suppressed within ${SUPPRESS_M}m of a CRS station: ${suppressed.length}`);
  console.log(`  within ${SUPPRESS_M}m but names disagree — KEPT as own row: ${keptDespiteProximity.length}`);
  for (const k of keptDespiteProximity) console.log(`     ${String(k.distance_m).padStart(4)}m  ${k.atco.padEnd(13)}${k.name.padEnd(24)} vs ${k.near} ${k.near_name}`);
  console.log(`  appended as new rows: ${appended.length}`);
  console.log(`  CRS rows carrying an interchange: ${migrated.filter((s) => s.interchange).length}`);
  console.log(`  FINAL ROW COUNT: ${out.length}`);

  // ── 4. assertions ────────────────────────────────────────────────────────
  const problems = [];
  if (!Array.isArray(out)) problems.push('output is not an array');
  // map.html:1357 does `Array.isArray(data) ? data : []` — a top-level object,
  // even one carrying a helpful _notes key, would make the whole station list
  // silently load as empty. This file can never gain a _notes wrapper.
  if (out.length !== migrated.length + appended.length) problems.push('row arithmetic mismatch');
  if (out.some((s) => typeof s.name !== 'string' || !s.name)) problems.push('a row has no name');
  if (out.some((s) => !Number.isFinite(s.lat) || !Number.isFinite(s.lon))) problems.push('a row has a bad coordinate');
  if (out.some((s) => s.crs === undefined || s.atco === undefined)) problems.push('a row is missing crs/atco key');
  if (out.some((s) => !s.mode || !s.network)) problems.push('a row is missing mode/network');

  const crsRows = out.filter((s) => s.crs);
  if (crsRows.length !== existing.length - removed.length) {
    problems.push(`expected ${existing.length - removed.length} CRS rows, got ${crsRows.length}`);
  }
  const dupCrs = crsRows.length - new Set(crsRows.map((s) => s.crs)).size;
  if (dupCrs) problems.push(`${dupCrs} duplicate CRS codes`);
  const atcoRows = out.filter((s) => s.atco);
  const dupAtco = atcoRows.length - new Set(atcoRows.map((s) => s.atco)).size;
  if (dupAtco) problems.push(`${dupAtco} duplicate ATCO codes`);
  if (out.some((s) => !s.crs && !s.atco)) problems.push('a row has neither crs nor atco — unidentifiable');
  if (unmatched.length > 12) problems.push(`coordinate join degraded: ${unmatched.length} unmatched (expected ~8)`);

  // Per-network appended+suppressed must still equal what the fetch extracted.
  const byNetwork = {};
  for (const s of naptan.stops) byNetwork[s.network] = (byNetwork[s.network] || 0) + 1;
  const accounted = {};
  for (const s of appended) accounted[s.network] = (accounted[s.network] || 0) + 1;
  for (const s of suppressed) accounted[s.network] = (accounted[s.network] || 0) + 1;
  for (const [net, n] of Object.entries(byNetwork)) {
    if (accounted[net] !== n) problems.push(`${net}: extracted ${n} but accounted for ${accounted[net] || 0}`);
  }

  console.log('\n  network                         extracted  appended  suppressed');
  for (const [net, n] of Object.entries(byNetwork).sort((a, b) => b[1] - a[1])) {
    const a = appended.filter((s) => s.network === net).length;
    const sp = suppressed.filter((s) => s.network === net).length;
    console.log(`  ${net.padEnd(32)}${String(n).padStart(6)}${String(a).padStart(10)}${String(sp).padStart(12)}`);
  }

  if (problems.length) {
    console.error('\n  MIGRATION ASSERTIONS FAILED:');
    for (const p of problems) console.error(`    - ${p}`);
    process.exit(1);
  }
  console.log('\n  all migration assertions PASSED');

  const md = [];
  md.push('# station-list.json migration', '', `Generated ${new Date().toISOString()}`, '');
  md.push('| | rows |', '|---|---:|');
  md.push(`| before | ${existing.length} |`);
  md.push(`| removed (closed) | ${removed.length} |`);
  md.push(`| existing rows kept | ${migrated.length} |`);
  md.push(`| appended non-CRS stops | ${appended.length} |`);
  md.push(`| suppressed within ${SUPPRESS_M}m (recorded as interchange) | ${suppressed.length} |`);
  md.push(`| **after** | **${out.length}** |`, '');
  md.push(`\`atco\` backfilled on ${migrated.filter((s) => s.atco).length}/${migrated.length} existing rows via exact 5dp coordinate join.`, '');
  md.push('## Rows keeping CRS as identity (atco null)', '', '| CRS | Name |', '|---|---|');
  for (const s of unmatched) md.push(`| ${s.crs} | ${s.name} |`);
  md.push('', '## Per network', '', '| Network | Extracted | Appended | Suppressed |', '|---|---:|---:|---:|');
  for (const [net, n] of Object.entries(byNetwork).sort((a, b) => b[1] - a[1])) {
    md.push(`| ${net} | ${n} | ${appended.filter((s) => s.network === net).length} | ${suppressed.filter((s) => s.network === net).length} |`);
  }
  md.push('', `## Kept despite being within ${SUPPRESS_M}m (names disagree)`, '',
    '| Distance | ATCO | Name | Nearest CRS |', '|---:|---|---|---|');
  for (const k of keptDespiteProximity.sort((a, b) => a.distance_m - b.distance_m)) {
    md.push(`| ${k.distance_m} m | ${k.atco} | ${k.name} | ${k.near} ${k.near_name} |`);
  }
  md.push('', '## Suppressed stops', '', '| ATCO | Name | Network | Onto CRS | Distance | Matched by |', '|---|---|---|---|---:|---|');
  for (const s of suppressed.sort((a, b) => a.distance_m - b.distance_m)) {
    md.push(`| ${s.atco} | ${s.name} | ${s.network} | ${s.onto} | ${s.distance_m} m | ${s.why} |`);
  }

  if (!write) {
    console.log('\n  DRY RUN — nothing written. Re-run with --write to apply.');
    return;
  }
  // ONE OBJECT PER LINE, deliberately. The pre-migration file was a single
  // 267KB line, so any change to it diffs as "1 line changed" — unreviewable.
  // Fully-indented output is readable but turns every row into 8 lines and the
  // whole file into a 672KB rewrite. One row per line gives a diff with one
  // line per station, which is the only form in which a 3,260-row change can
  // actually be checked by eye. Still a plain JSON array — map.html:1357 does
  // `Array.isArray(data) ? data : []`, so this file can never gain a top-level
  // _notes wrapper the way the *-content.json files have; the schema is
  // documented in this script's header instead.
  writeFileSync(STATION_LIST, '[\n' + out.map((r) => JSON.stringify(r)).join(',\n') + '\n]\n');
  writeFileSync(REPORT_MD, md.join('\n') + '\n');
  console.log(`\n  wrote ${STATION_LIST}`);
  console.log(`  wrote ${REPORT_MD}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

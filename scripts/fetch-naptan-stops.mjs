#!/usr/bin/env node
/**
 * scripts/fetch-naptan-stops.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Fetches the national NaPTAN stop dataset and extracts the two sets the
 * station-list.json migration needs:
 *   stops      — the tram/metro/underground STATIONS we want to add (740)
 *   rail_refs  — every active heavy-rail station, used ONLY as the join table
 *                that backfills `atco` onto station-list.json's existing rows
 *
 * REPORT/EXTRACT PASS ONLY. Writes exclusively to
 * scripts/output/naptan-stops.json (+ .md). It does NOT write station-list.json
 * — that is scripts/migrate-station-list.mjs's job, deliberately split so the
 * network fetch and the destructive edit are separate, re-runnable steps.
 *
 * Run:
 *   node scripts/fetch-naptan-stops.mjs
 *   NAPTAN_CSV=/path/to/naptan.csv node scripts/fetch-naptan-stops.mjs   (skip the download)
 *
 * ─── Endpoint: one bulk file, no pagination ───────────────────────────────
 * https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv
 *   97 MB (101,764,853 B), 435,184 rows, 43 columns. Measured 2026-07-30:
 *   4.5s to download, 0.9s to stream-parse — ~5.5s end to end.
 *   HEAD returns 405 on this host; use GET. Range requests are supported.
 *
 * WHY NOT THE XML: the CSV carries no CRS column at all. CRS lives only in the
 * XML format's <AnnotatedRailRef> (TiplocRef/CrsRef/StationName, 2,670 of
 * them) — and that download is 551 MB. It is not needed: CRS only matters for
 * heavy rail, which station-list.json already holds, and `atco` can be joined
 * onto those rows by coordinate instead. Confirmed live that the join is sound
 * — 2,621 of 2,629 existing rows match an active RLY row on EXACT 5-decimal
 * coordinates, because both sides are NaPTAN-derived and share the same
 * numbers rather than merely being close. So the 97 MB file is sufficient and
 * the 551 MB one is never fetched.
 *
 * ─── StopType: MET only ───────────────────────────────────────────────────
 * Active counts measured 2026-07-30: RLY 2,669 · MET 953 · PLT 1,572 ·
 * TMU 1,419 · RSE 3,741. MET is the STATION-level record for
 * tram/metro/underground. PLT (platform) and TMU (entrance) are sub-features
 * of the same stations and would put 2-3 dots on every one of them.
 *
 * ─── Classification: an ALLOWLIST, never a heritage denylist ──────────────
 * NaPTAN has no operator or network column. The signal is the ATCO code shape
 * 9400ZZ<SS><station>, where SS is a system code, cross-checked against the
 * network name embedded in CommonName.
 *
 * Heritage railways are ALSO MET stops — 190 of them across 50 system codes
 * (9400ZZWS West Somerset, 9400ZZNY North Yorkshire Moors, 9400ZZBB Bluebell,
 * 9400ZZTL Talyllyn, ...), each carrying "(… Railway)" in its name. An
 * allowlist excludes every one of them by construction, so a heritage railway
 * newly added to NaPTAN can never leak in and collide with the heritage dots
 * data/heritage-railways.json already ships. A denylist would have to be
 * maintained forever and would fail silently the first time it was missed.
 * Note 9400ZZST Seaton TRAMWAY is heritage despite the name — another reason
 * the mode word in a name is not safe to classify on.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'scripts', 'output');
const OUT_JSON = path.join(OUTPUT_DIR, 'naptan-stops.json');
const OUT_MD = path.join(OUTPUT_DIR, 'naptan-stops.md');
// Cached OUTSIDE the repo on purpose. The raw download is 97MB (112MB on disk)
// — well past GitHub's 100MB file limit — so writing it under scripts/output/
// puts an uncommittable file straight into the working tree, where it shows up
// in the diff the reviewer is about to read and can break a push. It is a
// 4-second re-download, so caching it in the repo buys nothing.
const CACHE_CSV = path.join(os.tmpdir(), 'srhq-naptan-raw.csv');

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv';
const USER_AGENT =
  'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

// ─── the 11 in-scope systems ───────────────────────────────────────────────
// `expected` is the LOCKED NaPTAN baseline measured 2026-07-30 — the assertion
// below fails the build if it moves, which is the whole point: NaPTAN drift
// must be seen, not absorbed. `sourced` is the independently published figure,
// reported alongside as a cross-check but NOT asserted on, because four
// networks legitimately differ from their published counts today (extensions
// opened, stop counts quoted at different dates) and hard-failing on that would
// mean this script could never run at all.
const SYSTEMS = {
  LU: { network: 'London Underground',         mode: 'underground', expected: 272, sourced: 272 },
  DL: { network: 'Docklands Light Railway',    mode: 'dlr',         expected: 45,  sourced: 45 },
  CR: { network: 'London Trams',               mode: 'tram',        expected: 39,  sourced: 39 },
  MA: { network: 'Manchester Metrolink',       mode: 'tram',        expected: 99,  sourced: 99 },
  NO: { network: 'Nottingham Express Transit', mode: 'tram',        expected: 50,  sourced: 51 },
  SY: { network: 'South Yorkshire Supertram',  mode: 'tram',        expected: 51,  sourced: 48 },
  WM: { network: 'West Midlands Metro',        mode: 'tram',        expected: 47,  sourced: null },
  BP: { network: 'Blackpool Tramway',          mode: 'tram',        expected: 40,  sourced: 38 },
  TW: { network: 'Tyne and Wear Metro',        mode: 'metro',       expected: 60,  sourced: 60 },
  GL: { network: 'Glasgow Subway',             mode: 'subway',      expected: 15,  sourced: 15 },
  ED: { network: 'Edinburgh Trams',            mode: 'tram',        expected: 23,  sourced: 23 },
};

// ─── the 10 misfiled rows ──────────────────────────────────────────────────
// ATCO system code -> the system it ACTUALLY belongs to. Every one of these was
// found by cross-checking the code against the network named in CommonName;
// correcting them makes seven of the eleven networks reconcile EXACTLY with
// their published totals, which is the evidence that the codes are wrong rather
// than the published figures.
//
//  - The eight 9400ZZTWWJ* rows are the whole Edinburgh Trams Newhaven
//    extension, filed under TW (Tyne & Wear). Their names all say
//    "(Edinburgh Trams)". This single upstream mistake caused BOTH anomalies:
//    Edinburgh read 15 instead of 23, Tyne & Wear 68 instead of 60. Correcting
//    it fixes both at once (15+8=23, 68-8=60).
//  - 9400ZZBPSUST Battersea Power Station is a London Underground station whose
//    own code happens to begin "BP", COLLIDING with Blackpool Tramway's system
//    code. Left alone it inflates Blackpool to 41 and leaves LU one short.
//  - 9400ZZNEUGST Nine Elms has its own "NE" code rather than LU. With
//    Battersea, this is what takes LU from 270 to exactly 272.
const OVERRIDES = {
  '9400ZZTWWJN': 'ED', // Newhaven
  '9400ZZTWWJO': 'ED', // Ocean Terminal
  '9400ZZTWWJP': 'ED', // Port of Leith
  '9400ZZTWWJQ': 'ED', // The Shore
  '9400ZZTWWJR': 'ED', // Foot of the Walk
  '9400ZZTWWJS': 'ED', // Balfour Street
  '9400ZZTWWJT': 'ED', // McDonald Road
  '9400ZZTWWJU': 'ED', // Picardy Place
  '9400ZZBPSUST': 'LU', // Battersea Power Station
  '9400ZZNEUGST': 'LU', // Nine Elms
};

// ─── deliberately excluded non-rail systems ───────────────────────────────
// These are MET stops in the national area that are not rail at all. Listed
// explicitly so the exclusion is a recorded decision rather than a silent
// consequence of the allowlist.
const EXCLUDED_NON_RAIL = {
  AL: 'Emirates Air Line cable car',
  AR: 'Birmingham Air-Rail Link (maglev shuttle)',
  GW: 'Gatwick inter-terminal shuttle',
};

// ─── name cleanup ─────────────────────────────────────────────────────────
// 12 distinct name shapes across the 740, and map.html's existing
// stripStationNameSuffix() handles NONE of them correctly — its regex
// /\s+(?:Rail|Railway|Metro)?\s*Station$/ leaves dangling words behind
// ("Buckhurst Hill Underground", "Abbey Road DLR", "Bridge Street SPT Subway")
// and cannot touch a parenthetical at all. Order matters: network
// parentheticals first, then suffix words, then a bare trailing "Station".
//
// NaPTAN is internally inconsistent here — "(Tyne and Wear Metro Station)"
// appears 59 times and "(Tyne & Wear Metro Station)" once — so both spellings
// are listed rather than relying on one.
const NETWORK_PARENTHETICALS = [
  /\s*\(Manchester Metrolink\)\s*$/i,
  /\s*\(Tyne and Wear Metro Station\)\s*$/i,
  /\s*\(Tyne & Wear Metro Station\)\s*$/i,
  /\s*\(West Midlands Metro\)\s*$/i,
  /\s*\(Blackpool Tramway\)\s*$/i,
  /\s*\(Edinburgh Trams\)\s*$/i,
];
const SUFFIXES = [
  /\s+Underground Station$/i,
  /\s+DLR Station$/i,
  /\s+Tram Stop$/i,
  /\s+SPT Subway Station$/i,
  /\s+Subway Station$/i,
  /[-\s]+Underground$/i, // "Paddington (H&C Line)-Underground"
  /\s+Railway Station$/i, // "Rochdale Railway Station (Manchester Metrolink)"
];

function cleanName(raw) {
  let n = (raw || '').trim();
  for (const re of NETWORK_PARENTHETICALS) n = n.replace(re, '');
  for (const re of SUFFIXES) n = n.replace(re, '');
  // NO generic bare-"Station" strip. It was tried and removed: it fires on only
  // 8 of the 741 and gets half of them wrong, because for these stops "Station"
  // is usually part of the real name rather than a suffix. It turned
  // "Battersea Power Station" into "Battersea Power" (Station is part of the
  // compound noun) and "Rochdale Railway Station" into "Rochdale Railway";
  // it also degraded "Central Station" to "Central" and "North Station" to
  // "North", losing the only word that identified them. The remaining
  // "… Station" names are correct as they stand — a tram stop called
  // "Nottingham Station" is named that because it serves Nottingham station,
  // and keeping the word also stops it colliding with a plain "Nottingham".
  // "Railway Station" is handled as an explicit suffix above instead.
  n = n.replace(/[\s,\-–]+$/, '').trim();
  return n || (raw || '').trim();
}

// ─── CSV ──────────────────────────────────────────────────────────────────
// NaPTAN quotes any field containing a comma, so a naive split() corrupts rows.
// This is a minimal RFC4180 reader rather than a dependency, matching the
// no-new-deps discipline every other script here follows.
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function ensureCsv() {
  const override = process.env.NAPTAN_CSV;
  if (override) {
    if (!existsSync(override)) throw new Error(`NAPTAN_CSV set but not found: ${override}`);
    console.log(`  using local CSV: ${override}`);
    return override;
  }
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`  downloading ${NAPTAN_URL}`);
  const t0 = Date.now();
  const res = await fetch(NAPTAN_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`NaPTAN download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(CACHE_CSV));
  console.log(`  downloaded in ${((Date.now() - t0) / 1000).toFixed(2)}s -> ${CACHE_CSV}`);
  return CACHE_CSV;
}

async function main() {
  console.log('── NaPTAN stop extract ──');
  const csvPath = await ensureCsv();

  const t0 = Date.now();
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let header = null;
  const col = {};
  let rowCount = 0;
  const byStopType = {};

  const metAll = [];   // every active MET row, national area or not
  const railRefs = []; // every active RLY row — the coordinate join table

  for await (const line of rl) {
    if (!header) {
      header = splitCsvLine(line);
      header.forEach((h, i) => { col[h.trim()] = i; });
      for (const required of ['ATCOCode', 'CommonName', 'Longitude', 'Latitude', 'StopType', 'Status']) {
        if (col[required] === undefined) throw new Error(`NaPTAN CSV is missing the ${required} column — schema changed upstream`);
      }
      continue;
    }
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    rowCount++;
    const stopType = f[col.StopType];
    byStopType[stopType] = (byStopType[stopType] || 0) + 1;
    if (f[col.Status] !== 'active') continue;

    if (stopType === 'RLY') {
      railRefs.push({
        atco: f[col.ATCOCode],
        name: f[col.CommonName],
        lon: Number(f[col.Longitude]),
        lat: Number(f[col.Latitude]),
      });
    } else if (stopType === 'MET') {
      metAll.push({
        atco: f[col.ATCOCode],
        name_raw: f[col.CommonName],
        lon: Number(f[col.Longitude]),
        lat: Number(f[col.Latitude]),
        locality: f[col.LocalityName] || null,
      });
    }
  }
  console.log(`  parsed ${rowCount.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  console.log(`  active RLY ${railRefs.length} · active MET ${metAll.length}`);

  // ── national area only ───────────────────────────────────────────────────
  // MET rows outside the 9400ZZ national metro area are local-authority
  // duplicates of rows that already exist nationally: 10 of the 11 sit within
  // 250m of a national row (Essex-area London Underground rows such as
  // Buckhurst Hill, entered three times over). Taking the national area only is
  // the dedupe. The 11th (9450ZZLT Luton Airport DART) is a real but out-of-
  // scope people-mover.
  const national = metAll.filter((r) => r.atco.startsWith('9400ZZ'));
  const localDupes = metAll.filter((r) => !r.atco.startsWith('9400ZZ'));

  // ── classify ─────────────────────────────────────────────────────────────
  const stops = [];
  const excluded = { heritage: [], nonRail: [], other: [] };
  const systemCounts = {};
  const overridesApplied = [];

  for (const r of national) {
    const rawCode = r.atco.slice(6, 8);
    const code = OVERRIDES[r.atco] || rawCode;
    if (OVERRIDES[r.atco]) overridesApplied.push({ atco: r.atco, name: r.name_raw, from: rawCode, to: code });

    const sys = SYSTEMS[code];
    if (!sys) {
      // `Rail)` / `Line)` catch the preserved lines that never say "Railway" —
      // "Darley Dale (Peak Rail)", "Shackerstone Rail Station (Battlefield
      // Line)". Without them 5 heritage stops were reported as "other", which
      // understated the heritage exclusion in the report even though the
      // allowlist had already (correctly) dropped them.
      const bucket = /Railway|Rly|RHDR|KESR|W&LLR|Steam|Tramway\)|Rail\)|Line\)/i.test(r.name_raw)
        ? excluded.heritage
        : EXCLUDED_NON_RAIL[rawCode] ? excluded.nonRail : excluded.other;
      bucket.push({ atco: r.atco, name: r.name_raw, code: rawCode });
      continue;
    }
    systemCounts[code] = (systemCounts[code] || 0) + 1;
    stops.push({
      atco: r.atco,
      name: cleanName(r.name_raw),
      name_raw: r.name_raw,
      crs: null,
      mode: sys.mode,
      network: sys.network,
      lat: r.lat,
      lon: r.lon,
    });
  }

  // ── assertions ───────────────────────────────────────────────────────────
  // Hard failure, not a warning. A silently-changed count is exactly the class
  // of drift this script exists to catch — a network gaining or losing stops
  // upstream must be looked at by a human before it reaches station-list.json.
  const failures = [];
  for (const [code, sys] of Object.entries(SYSTEMS)) {
    const got = systemCounts[code] || 0;
    if (got !== sys.expected) failures.push(`${code} (${sys.network}): expected ${sys.expected}, got ${got}`);
  }
  for (const atco of Object.keys(OVERRIDES)) {
    if (!national.some((r) => r.atco === atco)) {
      failures.push(`override row ${atco} is no longer present in NaPTAN — it may have been fixed upstream; re-check before removing`);
    }
  }

  console.log('\n  code  network                        got  expected  sourced  delta-vs-sourced');
  for (const [code, sys] of Object.entries(SYSTEMS)) {
    const got = systemCounts[code] || 0;
    const d = sys.sourced == null ? '—' : (got - sys.sourced > 0 ? '+' : '') + (got - sys.sourced);
    const flag = got === sys.expected ? ' ' : '!';
    console.log(`  ${flag} ${code}  ${sys.network.padEnd(30)}${String(got).padStart(4)}${String(sys.expected).padStart(10)}${String(sys.sourced ?? '—').padStart(9)}${String(d).padStart(9)}`);
  }
  console.log(`\n  in scope ${stops.length} · excluded heritage ${excluded.heritage.length} · non-rail ${excluded.nonRail.length} · other ${excluded.other.length} · local dupes ${localDupes.length}`);
  console.log(`  overrides applied: ${overridesApplied.length}/${Object.keys(OVERRIDES).length}`);

  if (failures.length) {
    console.error('\n  COUNT ASSERTIONS FAILED:');
    for (const f of failures) console.error(`    - ${f}`);
    throw new Error(`${failures.length} NaPTAN count assertion(s) failed — NaPTAN has drifted. Review, then update SYSTEMS.expected deliberately.`);
  }
  console.log('  all count assertions PASSED');

  // ── output ───────────────────────────────────────────────────────────────
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: NAPTAN_URL,
    naptan_rows_parsed: rowCount,
    stop_type_counts: byStopType,
    system_counts: systemCounts,
    overrides_applied: overridesApplied,
    excluded_counts: {
      heritage: excluded.heritage.length,
      non_rail: excluded.nonRail.length,
      other: excluded.other.length,
      local_area_duplicates: localDupes.length,
    },
    excluded_non_rail: excluded.nonRail,
    excluded_other: excluded.other,
    local_area_duplicates: localDupes.map((r) => ({ atco: r.atco, name: r.name_raw })),
    stops,
    rail_refs: railRefs,
  }, null, 2) + '\n');

  const md = [];
  md.push('# NaPTAN stop extract', '', `Generated ${new Date().toISOString()}`, '');
  md.push(`Source: \`${NAPTAN_URL}\` — ${rowCount.toLocaleString()} rows parsed.`, '');
  md.push('## In-scope networks', '', '| Code | Network | Mode | Stops | Sourced | Δ |', '|---|---|---|---:|---:|---:|');
  for (const [code, sys] of Object.entries(SYSTEMS)) {
    const got = systemCounts[code] || 0;
    const d = sys.sourced == null ? '—' : (got - sys.sourced > 0 ? '+' : '') + (got - sys.sourced);
    md.push(`| ${code} | ${sys.network} | ${sys.mode} | ${got} | ${sys.sourced ?? '—'} | ${d} |`);
  }
  md.push(`| | **Total** | | **${stops.length}** | 728 | ${stops.length - 728 > 0 ? '+' : ''}${stops.length - 728} |`, '');
  md.push('## Excluded', '', '| Reason | Count |', '|---|---:|');
  md.push(`| heritage / preserved railways (allowlist excludes by construction) | ${excluded.heritage.length} |`);
  md.push(`| non-rail (cable car, air-rail links, shuttles) | ${excluded.nonRail.length} |`);
  md.push(`| other unrecognised systems | ${excluded.other.length} |`);
  md.push(`| local-area duplicate MET rows | ${localDupes.length} |`, '');
  md.push('## Overrides applied (misfiled ATCO system codes)', '', '| ATCO | Name | Filed as | Corrected to |', '|---|---|---|---|');
  for (const o of overridesApplied) md.push(`| ${o.atco} | ${o.name} | ${o.from} | ${o.to} |`);
  writeFileSync(OUT_MD, md.join('\n') + '\n');

  console.log(`\n  wrote ${OUT_JSON}`);
  console.log(`  wrote ${OUT_MD}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}

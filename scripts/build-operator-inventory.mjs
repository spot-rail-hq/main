#!/usr/bin/env node
/**
 * scripts/build-operator-inventory.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 0 of the operator-colored rail line project (see the approved plan,
 * "Operator-colored rail line rendering", for the full 8-phase context).
 *
 * Queries every GB train/light_rail/tram/subway route relation from a local
 * Overpass instance (see OVERPASS_URL below — same self-hosted setup used
 * by fetch-osm-facts.mjs), collects the distinct raw operator/brand tag
 * strings actually in use, and maps each one to a canonical bucket:
 *
 *   toc      — a real train operating company, canonical name matches an
 *              operators-content.json key (CANONICAL_TOC below)
 *   metro    — light rail / tram / subway / metro systems, kept visually
 *              distinct from national-rail TOCs per the existing Database-
 *              mode legend ("Metro/LRT (purple)")
 *   heritage — preserved/heritage lines, sharing one treatment since they
 *              never physically overlap each other
 *   excluded — defunct/stale tags, museum exhibits, ambiguous historic
 *              company names, or anything that isn't a live passenger
 *              service — rendered as the plain base line, not colored
 *
 * This mapping is deliberately its own thing, NOT a strict reuse of
 * operators-content.json's `aliases` array — that field exists for station-
 * data provenance precision (e.g. "West Midlands Trains" is WMR's
 * `legal_entity`, not folded into `aliases`, and "Trafnidiaeth Cymru" is
 * AW's `welsh_name`, deliberately left unfolded in station data too) — but
 * a line-color map needs ONE consistent color per real service regardless
 * of which legal/bilingual name a given relation happens to carry, so both
 * are folded to their TOC's color here even though station-content.json
 * correctly keeps them unfolded.
 *
 * Run:
 *   node scripts/build-operator-inventory.mjs
 *
 * Output: scripts/output/operator-inventory.json — the full raw-string →
 * bucket/canonical mapping, plus relation counts per bucket, for review
 * before Phase 1 (palette) or Phase 2 (segment graph) touch it.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output');
const OUT_PATH = path.join(OUT_DIR, 'operator-inventory.json');

const OVERPASS_URL = process.env.OVERPASS_URL || 'http://localhost:12345/api/interpreter';

// ─── Canonical TOC mapping — raw operator/brand string → operators-
// content.json code. Extends that file's own `aliases` with line-data-only
// variants (legal_entity/welsh_name strings, plural/casing variants found
// live) that station data deliberately keeps separate. Verified against a
// live query of all 1,211 GB route relations (2026-07-14) — see the
// approved plan's Context section for the full raw-string frequency list.
const CANONICAL_TOC = {
  // Direct names
  'West Midlands Railway': 'WMR', 'Avanti West Coast': 'VT', 'LNER': 'GR',
  'CrossCountry': 'XC', 'East Midlands Railway': 'EM',
  'London Northwestern Railway': 'LN', 'Great Western Railway': 'GW',
  'South Western Railway': 'SW', 'Southeastern': 'SE', 'Southern': 'SN',
  'Thameslink': 'TL', 'Gatwick Express': 'GX', 'Great Northern': 'GN',
  'c2c': 'CC', 'Chiltern Railways': 'CH', 'Greater Anglia': 'LE',
  'Northern': 'NT', 'TransPennine Express': 'TP', 'Merseyrail': 'ME',
  'ScotRail': 'SR', 'Caledonian Sleeper': 'CS', 'Grand Central': 'GC',
  'Hull Trains': 'HT', 'Lumo': 'LD', 'Heathrow Express': 'HX',
  'Elizabeth line': 'XR', 'Transport for Wales': 'AW', 'Island Line': 'IL',
  'West Coast Railways': 'WR', 'Eurostar': 'ES',
  // operators-content.json's existing `aliases`
  'London North Eastern Railway': 'GR', 'Virgin Trains East Coast': 'GR',
  'Cross Country': 'XC', 'Arriva CrossCountry': 'XC', 'East Midlands': 'EM',
  'GWR': 'GW', 'First Great Western': 'GW', 'Great Western Railways': 'GW',
  'South Eastern': 'SE', 'Southeastern Railway': 'SE',
  'Southern Railway': 'SN', 'Abellio Greater Anglia': 'LE',
  'Northern Rail': 'NT', 'Northern Trains': 'NT', 'Arriva Trains North': 'NT',
  'Arriva Rail North': 'NT', 'Transpennine Express': 'TP',
  'GTS Rail Operations': 'LD', 'Island Line Trains': 'IL',
  'Eurostar International Ltd': 'ES',
  // Line-data-only variants — legal_entity/welsh_name strings and casing/
  // plural forms found live, none of them in station data's `aliases`
  'West Midlands Trains': 'WMR', 'Trafnidiaeth Cymru': 'AW',
  'Southeastern Railways': 'SE', // plural — new variant, not seen in station data
  // "Greater Thameslink Railway" is deliberately NOT mapped to SN/TL/GN/GX
  // here — see GTR_NOTE below.
};

// 2026-07-14 finding: the single biggest non-TOC-mapped string is "Greater
// Thameslink Railway" (104 relations) — since the 31 May 2026
// renationalization, OSM's bulk relation updates largely retagged Southern/
// Thameslink/Great Northern/Gatwick Express route relations at the PARENT
// company level rather than the individual sub-brand. Only a small residual
// of relations still carry the old specific brand tags (Southern: 13,
// "Southern Railway": 3, "Thameslink Railway": 2, "Govia Thameslink
// Railway": 2) — nowhere near enough to reconstruct which sub-brand a
// "Greater Thameslink Railway"-tagged relation actually represents without
// route-name/geography heuristics, which is real, separate, higher-risk
// work (out of scope for Phase 0). Pragmatic call: give "Greater Thameslink
// Railway" its OWN canonical color (not yet an operators-content.json
// entry — flagging that as a follow-up, not doing it here, since that
// file's maintenance is a separate concern from this line-coloring pass),
// and fold the small residual old-brand-tagged relations into IT too
// (not into SN/TL's existing colors) rather than giving a handful of
// stale-tagged relations their own distinct color that barely appears
// anywhere.
const GTR_NOTE = 'Greater Thameslink Railway is its own canonical TOC-tier entry (code: GTR), not yet in operators-content.json — see script header.';
const GTR_FOLD = ['Greater Thameslink Railway', 'Southern Railway', 'Thameslink Railway', 'Govia Thameslink Railway'];
// NOTE: 'Southern Railway' is ALSO SN's alias in station data (the "same
// brand, stale duplicate relation tag" finding from the station-operator
// confidence work) — but at the ROUTE-RELATION level specifically, GTR_FOLD
// only catches the exact string 'Southern Railway'; the far more common
// bare 'Southern' (13 relations) still maps to SN above, since those are
// genuinely still-live Southern-branded relations, not GTR's bulk retag.

// ─── Metro / LRT — visually distinct from national-rail TOCs, one purple-
// family treatment (see Phase 1), with London Underground/DLR/Elizabeth
// line's OWN famous per-line colors layered in later where OSM tagging
// supports it (Phase 1/3) — Elizabeth line already has its real purple as
// a TOC entry above (XR), so it's excluded from this metro bucket.
const CANONICAL_METRO = {
  'Transport for London': 'Transport for London',
  'Nexus': 'Tyne and Wear Metro',
  'Transport for Greater Manchester': 'Manchester Metrolink',
  'TfGM': 'Manchester Metrolink',
  'KeolisAmey Docklands Ltd': 'Docklands Light Railway',
  'Tram Operations Ltd': 'Croydon Tramlink',
  'South Yorkshire Future Trams': 'Sheffield Supertram',
  'Midland Metro Limited (WMCA)': 'West Midlands Metro',
  'Tramlink Nottingham': 'Nottingham Express Transit',
  'Glasgow Subway': 'Glasgow Subway',
};

// ─── Heritage — preserved lines, never physically overlap each other, one
// shared amber-family treatment (see Phase 1). West Coast Railways (WR) is
// already a TOC-tier entry above (it's a real, if niche, National Rail
// passenger charter operator, not a preserved line) — excluded from here.
const CANONICAL_HERITAGE = [
  'Festiniog Railway Company', 'West Somerset Railway Plc',
  'Mid-Norfolk Railway', 'Gwili Railway Co. Ltd',
  'Ravenglass & Eskdale Railway', 'Scottish Railway Preservation Society',
  'Brechin Railway Preservation Society', 'Almond Valley Heritage Centre',
  'Barrow Hill Roundhouse Railway Museum',
  'Merseyside Tramway Preservation Society',
];

// ─── Excluded — defunct/stale tags (kept OUT of the colored overlay
// entirely, rendered as the plain base line, per each note):
//   'London Midland' — per this session's explicit instruction not to
//     remap it in station data (stale pre-2017 tag); consistent treatment
//     here is to also not fold it into WMR's color, just exclude it.
//   'North TransPennine' — per this session's explicit instruction NOT to
//     fold into TransPennine Express; excluding (not coloring) respects
//     that without inventing a new one-relation color either.
//   'National Express' — the exact stale-tag pattern already confirmed and
//     removed from station data this session (Newcastle Central); likely a
//     leftover from National Express's 1996-2008 Gatwick Express franchise.
//   '(none)' — no operator/brand tag at all.
//   'Network Rail' — infrastructure owner, not a passenger-service tag in
//     this context (mirrors the station-data finding that Network Rail
//     tags reflect facility MANAGEMENT, not service).
//   Ambiguous/historic company names and museum-exhibit tags that aren't
//     live preserved railways: 'M-Shed', 'British Postal Museum',
//     'Brighton & Hove City Council', 'Midland and Great Northern Joint
//     Railway', 'TVR', 'Southampton & Dorchester Railway'.
const EXCLUDED = new Set([
  'London Midland', 'North TransPennine', 'National Express', '(none)',
  'Network Rail', 'M-Shed', 'British Postal Museum',
  'Brighton & Hove City Council', 'Midland and Great Northern Joint Railway',
  'TVR', 'Southampton & Dorchester Railway',
]);

function classify(raw) {
  if (GTR_FOLD.includes(raw)) return { bucket: 'toc', canonical: 'Greater Thameslink Railway', code: 'GTR' };
  if (CANONICAL_TOC[raw]) return { bucket: 'toc', canonical: CANONICAL_TOC[raw], code: CANONICAL_TOC[raw] };
  if (CANONICAL_METRO[raw]) return { bucket: 'metro', canonical: CANONICAL_METRO[raw], code: null };
  if (CANONICAL_HERITAGE.includes(raw)) return { bucket: 'heritage', canonical: 'Heritage', code: null };
  if (EXCLUDED.has(raw)) return { bucket: 'excluded', canonical: null, code: null };
  return { bucket: 'unrecognized', canonical: null, code: null };
}

async function overpassQuery(q) {
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(q) });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Overpass returned non-JSON (likely an error page): ${text.slice(0, 300)}`);
  }
}

async function main() {
  console.log(`Querying ${OVERPASS_URL} for all GB train/light_rail/tram/subway route relations...`);
  const q = '[out:json][timeout:120];rel["type"="route"]["route"~"^(train|light_rail|tram|subway)$"];out tags;';
  const data = await overpassQuery(q);
  const rels = data.elements;
  console.log(`  ${rels.length} relations found.`);

  const raw = {}; // rawString -> count
  for (const r of rels) {
    const op = r.tags.operator || r.tags.brand || '(none)';
    raw[op] = (raw[op] || 0) + 1;
  }

  const mapping = {};
  const bucketCounts = { toc: 0, metro: 0, heritage: 0, excluded: 0, unrecognized: 0 };
  const unrecognized = [];
  for (const [rawStr, count] of Object.entries(raw)) {
    const cls = classify(rawStr);
    mapping[rawStr] = { count, ...cls };
    bucketCounts[cls.bucket] += count;
    if (cls.bucket === 'unrecognized') unrecognized.push({ raw: rawStr, count });
  }

  const report = {
    generated_at: new Date().toISOString(),
    total_relations: rels.length,
    total_raw_strings: Object.keys(raw).length,
    bucket_relation_counts: bucketCounts,
    unrecognized: unrecognized.sort((a, b) => b.count - a.count),
    mapping,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');

  console.log('\n=== Bucket relation counts ===');
  console.log(bucketCounts);
  if (unrecognized.length) {
    console.log('\n=== UNRECOGNIZED raw strings — not classified, need a mapping decision ===');
    unrecognized.forEach((u) => console.log(`  "${u.raw}" (${u.count})`));
  } else {
    console.log('\nAll raw operator/brand strings classified — no unrecognized entries.');
  }
  console.log(`\nFull report written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

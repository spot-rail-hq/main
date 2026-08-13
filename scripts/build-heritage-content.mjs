#!/usr/bin/env node
/**
 * scripts/build-heritage-content.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Generates heritage-content.json — per-railway intro text, official website
 * and Wikipedia/Wikidata provenance, keyed by heritage_slug.
 *
 * Reads:
 *   scripts/lib/heritage-canonical.mjs          HERITAGE_META (the 175 rows)
 *   scripts/output/heritage-wikidata-report.json  from fetch-heritage-wikidata.mjs
 * Writes:
 *   heritage-content.json                       (only with --write)
 *
 * Default is SAMPLE mode: prints generated entries to stdout and writes
 * nothing. `--write` is required to produce the file. `--sample=slug,slug`
 * prints just those.
 *
 * ─── Every field is derived; nothing is invented ──────────────────────────
 * The intro sentence is assembled from HERITAGE_META's own `type`/`secondary`/
 * `km` plus a LOCATION phrase lifted from the matched Wikidata description.
 * Nothing else is asserted about a railway, because nothing else is available
 * for all 183 — see the three deliberate omissions below.
 *
 * OMITTED 1 — "between A and B" (terminus names). NOT DERIVABLE, and the
 * field that looks like it would serve is a trap: heritage-railways.json's
 * `principal_station` is populated for only 61/183, and it is not a terminus
 * of the heritage railway at all — build-heritage-client-data.mjs sets it to
 * the nearest NATIONAL RAIL station within 200m/1km, purely to place the map
 * dot (its own header says so, and calls out that "a terminus is not a
 * midpoint"). For Aberystwyth Cliff Railway it is "Aberystwyth Rail Station",
 * the mainline station — not either end of the cliff railway. The segment
 * graph does hold terminus COORDINATES (degree-1 nodes) but no names for
 * them, so there is no A and no B to name. The REST extract this pipeline
 * already captures very often states the termini in prose ("...runs between
 * Sheringham and Holt"), so a later Claude-extraction pass over that text —
 * the fetch-wikipedia-facts.mjs pathway — is the honest way to add termini
 * for the matched subset. Guessing them from the dot is not.
 *
 * OMITTED 2 — "independently operated". Not true of all 183 and not recorded
 * anywhere: Great Orme Tramway is owned by Conwy County Borough Council and
 * Cairngorm Funicular by Highlands and Islands Enterprise, so asserting
 * independence site-wide would be false on a known subset.
 *
 * OMITTED 3 — any count of railways or operating companies ("one of N
 * heritage railways/companies"). Two separate reasons, either sufficient:
 *   a) HERITAGE_META has no operating-company field — only slug/type/
 *      secondary/band/km/prose_name — so the "no two railways share a company"
 *      check
 *      that such phrasing depends on cannot be run against the curated table.
 *   b) The check would fail anyway. Railways and companies are not 1:1 here:
 *      Ffestiniog Railway and Welsh Highland Railway are two separate
 *      HERITAGE_META rows run by one operator, the Festiniog Railway Company
 *      — which is why HERITAGE_CANONICAL maps the raw OSM string "Ffestiniog
 *      Railway" onto Welsh Highland Railway. So a per-railway total would
 *      overstate a per-company one, and no number is hard-coded here.
 * Wikidata P137 (operator) could supply real per-company grouping if that
 * phrasing is ever wanted; it is not fetched today.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HERITAGE_META } from './lib/heritage-canonical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'scripts', 'output', 'heritage-wikidata-report.json');
const OUT_PATH = path.join(ROOT, 'heritage-content.json');

// ─── READ-MERGE-PRESERVE (2026-08-19) ──────────────────────────────────────
// FIXED A REAL BUG: this generator used to build `content` from HERITAGE_META
// + the wikidata report ALONE and overwrite heritage-content.json wholesale —
// it never read the file it was about to replace. That silently destroyed any
// hand-curated field a human (or Claude, doing hand research) had added
// outside this pipeline — confirmed live: established_year and its three
// sibling fields (opened_year, heritage_reopened_year, established_year_type,
// _established_year — added by a separate, manual per-railway research pass,
// see scratchpad/heritage-established-year-*.md) exist on 50 entries today and
// would all have been wiped by the next unrelated re-run of this script.
//
// GENERATOR_OWNED_KEYS is the complete set of keys buildEntry() itself ever
// writes — read it straight off that function, don't hand-maintain a second
// copy. This is deliberately NOT a "preserve" allowlist of hand-curated field
// names: an allowlist has to be remembered and updated every time someone
// adds a new hand-curated field, and forgetting is exactly the silent-failure
// class this fix exists to close (a hand-curated field left off the list
// would be wiped exactly as before, just for a shorter list of fields).
// Inverted instead: the generator already has to state its OWN output shape
// explicitly to build an entry in the first place, so that's the one list
// that's structurally kept in sync with reality — anything ELSE present on
// an existing entry, whatever it's called, survives a regen automatically,
// with no second list to maintain and no way for a newly-added hand-curated
// field to be silently unprotected.
//
// NOT the existing underscore-prefix convention either — checked first and
// rejected: `_wikidata`/`_wikipedia`/`_review` already use a leading
// underscore purely as a "this is metadata, not primary content" naming
// convention, and ARE meant to be regenerated and overwritten every run (that
// IS their whole purpose — fresh Wikidata resolution results). Treating
// "starts with underscore" as "preserve, don't touch" would have protected
// those THREE FIELDS FROM EVER UPDATING AGAIN — backwards. It also would have
// MISSED three of the four established_year-family fields, which aren't
// underscore-prefixed at all (only `_established_year` is) — a false
// negative on the exact fields this fix is for. The underscore prefix means
// something else in this codebase already; reusing it here would silently
// fail in both directions at once.
const GENERATOR_OWNED_KEYS = new Set([
  'name', 'type', 'intro', 'legal_name', 'type_secondary', 'length_km',
  'website', 'wikipedia_title', '_wikipedia', '_wikidata', '_review',
]);

function loadExistingContent() {
  if (!existsSync(OUT_PATH)) return {};
  const parsed = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  delete parsed._notes;
  return parsed;
}

// Everything on `oldEntry` that isn't one of the generator's own keys —
// hand-curated by definition, regardless of what it's called or whether this
// generator has ever heard of it.
function preservedFields(oldEntry) {
  if (!oldEntry) return {};
  const preserved = {};
  for (const [k, v] of Object.entries(oldEntry)) {
    if (!GENERATOR_OWNED_KEYS.has(k)) preserved[k] = v;
  }
  return preserved;
}

// LOUD GUARD, run right before writing. Defense in depth on top of the merge
// itself (which is safe by construction — see below) — this project has
// already shipped two silent-wrong bugs in hand-merged heritage data in the
// established_year work this generator fix follows, so a re-run that could
// destroy 50+ entries of manual research gets an explicit, checked assertion
// rather than trusting the merge logic alone. Compares every PRESERVED field
// (not generator-owned, non-null/non-empty in the old file) against the same
// slug+key in the freshly-built output; any populated value that's missing
// or changed aborts the write with the exact slug and field, before
// touching disk. Only checks slugs still present in the new output — a
// railway legitimately removed from HERITAGE_META losing its hand-curated
// fields with it is an intentional prune, not a bug.
function assertNoDataLoss(oldContent, newContent) {
  const problems = [];
  for (const [slug, oldEntry] of Object.entries(oldContent)) {
    const newEntry = newContent[slug];
    if (!newEntry) continue; // slug removed from HERITAGE_META — intentional, not this guard's concern
    for (const [k, v] of Object.entries(oldEntry)) {
      if (GENERATOR_OWNED_KEYS.has(k)) continue;
      if (v === null || v === undefined || v === '') continue;
      const newV = newEntry[k];
      if (JSON.stringify(newV) !== JSON.stringify(v)) {
        problems.push(`${slug}.${k}: had ${JSON.stringify(v)}, would become ${JSON.stringify(newV)}`);
      }
    }
  }
  if (problems.length) {
    console.error(`\nABORTING — ${problems.length} hand-curated field(s) would be lost or changed by this write:`);
    problems.slice(0, 20).forEach((p) => console.error('  ' + p));
    if (problems.length > 20) console.error(`  ...and ${problems.length - 20} more`);
    console.error('\nNothing was written. If this is intentional (e.g. a deliberate correction to a');
    console.error('hand-curated field), edit heritage-content.json directly rather than through this generator.');
    process.exit(1);
  }
}

// Flags that make a row's Wikidata match unsafe to draw ANY content from —
// the entity may not be this railway. A flagged row still gets an intro
// sentence (from HERITAGE_META, which is curated and always correct), just
// without the location phrase and without a website/Wikipedia link.
const BLOCKING_FLAGS = new Set([
  'wrong-entity-class',
  'historic-company',
  'geo-rejected',
]);

// geo-unconfirmed / no-center / geo-only-title-differs are REVIEW flags, not
// blocking ones: the entity is probably right but unverified on one axis. They
// are recorded per entry as `_review` so a human can sweep them, and are listed
// in the report — but they don't suppress content, or ~a third of the set would
// silently lose its links.
const REVIEW_FLAGS = new Set(['geo-unconfirmed', 'no-center', 'geo-only-title-differs']);

// ─── length phrasing ───────────────────────────────────────────────────────
// Sub-kilometre reads badly in km ("0.1 km of track"), and 13 of the 14
// funiculars are under 1km (median 0.10km / 100m), so anything under 1km is
// expressed in metres. Rounded to 10m to avoid implying survey precision the
// segment graph doesn't have.
function formatLength(km) {
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.round((km * 1000) / 10) * 10} m`;
}

// ─── location phrase ───────────────────────────────────────────────────────
// Wikidata's English description is overwhelmingly "<class> in <place>"
// ("heritage railway in East Sussex, England", "Funicular railway in
// Bridgnorth, Shropshire, England"), so the place is the tail after the last
// " in ". Trailing ", UK"/", United Kingdom" is dropped — every railway here
// is in Great Britain, so it adds length and no information.
function extractLocation(description) {
  if (!description) return null;
  // FIRST SENTENCE ONLY. Confirmed live: Aberystwyth Cliff Railway's Wikidata
  // description is "Grade II listed building in Ceredigion. At the bottom of the
  // terrace, facing dow..." — reading the last " in " across the whole string
  // lands in the second sentence's prose and yields no usable place, losing a
  // location we do in fact have ("Ceredigion").
  description = description.split(/(?<=\.)\s+/)[0];
  const idx = description.toLowerCase().lastIndexOf(' in ');
  if (idx === -1) return null;
  let place = description
    .slice(idx + 4)
    .replace(/[.\s]+$/, '')
    .replace(/,\s*(UK|United Kingdom|U\.K\.)$/i, '')
    .trim();
  if (!place || place.length > 60) return null;
  // Must look like a proper place name, not a trailing clause fragment
  // ("...in the eastern Highlands" is fine; "...in 1974" or a lowercase
  // fragment is not).
  if (!/^(the\s+)?[A-Z]/.test(place)) return null;
  if (/^\d/.test(place)) return null;
  return place;
}

// ─── intro templates, one per heritage_type ────────────────────────────────
// Varied by type so a museum site and a cliff railway don't read like a
// mainline operating railway, per the brief. `secondary` adds or adjusts a
// clause rather than switching template, so the 6 dual-type rows stay
// consistent with their primary type.
function buildIntro(name, meta, location) {
  const { type, secondary, km } = meta;
  const where = location ? ` in ${location}` : '';
  const len = km > 0 ? formatLength(km) : null;

  if (type === 'funicular') {
    // Always has measurable track (min 0.03 km), so `len` is never null here.
    return `${name} is a funicular railway${where}, rising over ${len} of track.`;
  }

  if (type === 'tramway') {
    return len
      ? `${name} is a heritage tramway${where}, running ${len} of track.`
      : `${name} is a heritage tramway${where}.`;
  }

  if (type === 'museum') {
    if (secondary === 'tramway') {
      return len
        ? `${name} is a museum${where} with a working heritage tramway, running ${len} of track.`
        : `${name} is a museum${where} with a working heritage tramway.`;
    }
    return len
      ? `${name} is a railway museum${where}, with ${len} of demonstration line.`
      : `${name} is a railway museum${where}.`;
  }

  // operating
  const subject = secondary === 'museum' ? 'a heritage railway and museum' : 'a heritage railway';
  return len
    ? `${name} is ${subject}${where}, operating ${len} of preserved line.`
    : `${name} is ${subject}${where}.`;
}

function buildEntry(name, meta, row) {
  const flags = (row && row.flags) || [];
  const blocked = flags.some((f) => BLOCKING_FLAGS.has(f));
  const usable = row && row.status === 'matched' && !blocked;

  const location = usable ? extractLocation(row.wikidata_description || row.rest_description) : null;

  // Display name is prose_name when the curated key is a legal entity — the
  // SAME field data/heritage-railways.json uses for the dot tooltip and search
  // result, so the map and the panel cannot show different names for one
  // railway. The legal name is retained rather than discarded.
  const displayName = meta.prose_name || name;
  const entry = {
    name: displayName,
    type: meta.type,
    intro: buildIntro(displayName, meta, location),
  };
  if (meta.prose_name && meta.prose_name !== name) entry.legal_name = name;
  if (meta.secondary) entry.type_secondary = meta.secondary;
  entry.length_km = meta.km;

  if (usable) {
    if (row.website) entry.website = row.website;
    if (row.wikipedia_title) {
      entry.wikipedia_title = row.wikipedia_title;
      entry._wikipedia = { title: row.wikipedia_title, url: row.wikipedia_url, license: 'CC BY-SA 4.0' };
    }
    entry._wikidata = {
      fetched_at: row.fetched_at || null,
      qid: row.qid || null,
      confidence: row.confidence || null,
    };
  } else if (row) {
    // Deliberately records WHY a railway has no link, so a re-run or a human
    // sweep can tell "never checked" from "checked, rejected as the wrong
    // entity" — the same distinction fetch-official-websites.mjs draws by
    // writing `_wikidata` even when no claim was found.
    entry._wikidata = {
      fetched_at: row.fetched_at || null,
      qid: blocked ? null : row.qid || null,
      confidence: null,
      suppressed: blocked ? flags.filter((f) => BLOCKING_FLAGS.has(f)) : ['unresolved'],
      candidate_title: row.wikipedia_title || null,
    };
  }

  const review = flags.filter((f) => REVIEW_FLAGS.has(f));
  if (review.length) entry._review = review;

  return entry;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const sampleArg = args.find((a) => a.startsWith('--sample='));
  const sampleSlugs = sampleArg ? sampleArg.slice(9).split(',').map((s) => s.trim()) : null;

  if (!existsSync(REPORT_PATH)) {
    console.error(`Missing ${REPORT_PATH} — run: node scripts/fetch-heritage-wikidata.mjs`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  const bySlug = {};
  for (const r of report.rows || []) bySlug[r.slug] = r;

  // Read BEFORE building — the whole point of this fix. Empty object on a
  // first-ever run (no file to preserve from yet), same as every other
  // "read prior output if it exists" pattern in this repo.
  const existingContent = loadExistingContent();

  const content = {};
  const stats = { total: 0, with_website: 0, with_wikipedia: 0, suppressed: 0, review: 0, with_location: 0, preserved: 0 };

  for (const [name, meta] of Object.entries(HERITAGE_META)) {
    const entry = buildEntry(name, meta, bySlug[meta.slug]);
    // Preserved (hand-curated) fields first, generator's own fresh fields
    // second — a generator-owned key always wins on collision (it's meant
    // to regenerate), and everything else from the prior file rides along
    // untouched.
    const preserved = preservedFields(existingContent[meta.slug]);
    content[meta.slug] = { ...preserved, ...entry };
    if (Object.keys(preserved).length) stats.preserved++;
    stats.total++;
    if (entry.website) stats.with_website++;
    if (entry.wikipedia_title) stats.with_wikipedia++;
    if (entry._wikidata && entry._wikidata.suppressed) stats.suppressed++;
    if (entry._review) stats.review++;
    if (/ in /.test(entry.intro)) stats.with_location++;
  }

  if (sampleSlugs) {
    for (const slug of sampleSlugs) {
      if (!content[slug]) { console.log(`(no such slug: ${slug})`); continue; }
      console.log(JSON.stringify({ [slug]: content[slug] }, null, 2));
      console.log('');
    }
    return;
  }

  console.log(JSON.stringify(stats, null, 2));

  if (stats.preserved) console.log(`(${stats.preserved} entries carry hand-curated fields preserved from the existing file)`);

  if (!write) {
    console.log('\nSAMPLE MODE — nothing written. Re-run with --write to produce heritage-content.json.');
    return;
  }

  // Defense in depth — see assertNoDataLoss()'s own comment. The merge above
  // is safe by construction, but this checks the actual before/after rather
  // than trusting that, and refuses to write at all if anything hand-curated
  // would be lost.
  assertNoDataLoss(existingContent, content);

  const out = {
    _notes:
      'Per-heritage-railway narrative content, keyed by the same heritage_slug that ' +
      'operators.pmtiles carries per segment and that data/heritage-railways.json uses. ' +
      'GENERATED by scripts/build-heritage-content.mjs from HERITAGE_META (curated) plus ' +
      'scripts/output/heritage-wikidata-report.json (resolved by scripts/fetch-heritage-wikidata.mjs). ' +
      '`intro` is assembled from curated type/length plus a location phrase taken from the matched ' +
      'Wikidata description — it never asserts termini or ownership, and hard-codes no count of ' +
      'railways or companies; see the generator header for why each of those is omitted. ' +
      'An entry whose _wikidata.suppressed is set was checked and its match REJECTED as the wrong ' +
      'entity — it has no website/Wikipedia link on purpose. _review lists per-entry match ' +
      'caveats (geo-unconfirmed / no-center / geo-only-title-differs) that a human should sweep. ' +
      'established_year/established_year_type/opened_year/heritage_reopened_year/_established_year ' +
      'are NOT produced by this generator — they come from a separate, manual per-railway research ' +
      'pass (see scratchpad/heritage-established-year-*.md) and are READ-MERGE-PRESERVED across ' +
      'regeneration, not regenerated; see GENERATOR_OWNED_KEYS at the top of this script.',
    ...content,
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${OUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

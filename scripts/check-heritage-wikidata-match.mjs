#!/usr/bin/env node
/**
 * scripts/check-heritage-wikidata-match.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * WRONG-ENTITY PRE-FILTER for the established_year research pass. Read-only:
 * checks scripts/output/heritage-wikidata-report.json's matched Wikipedia
 * title against each HERITAGE_META railway's own name, BEFORE any
 * WebFetch/date-extraction is attempted, and flags matches likely to be the
 * wrong entity — the failure mode that produced all three wrong-entity
 * matches in tranche 1 (Bo'ness & Kinneil -> "Kinneil railway station",
 * Bodmin & Wenford -> "Bodmin Parkway railway station", Cairngorm Funicular
 * -> "Cairngorms").
 *
 * NOT a general-purpose entity-resolution classifier — one specific,
 * validated heuristic, deliberately conservative per instruction ("a false
 * reject costs a blank a human then fills, cheaper than a false accept
 * producing a confident wrong year"):
 *
 *   1. STATION-SUFFIX + INCOMPLETE NAME. The matched title ends in
 *      "railway station"/"station", AND is missing at least one distinctive
 *      word from the railway's own name (after stripping generic words —
 *      "railway", "station", "museum", etc.). Catches a match to a specific,
 *      DIFFERENT station along the route or on the same line, while still
 *      passing a station article that genuinely covers the whole named
 *      railway (Whitwell and Reepham Railway -> "Whitwell & Reepham railway
 *      station" keeps every distinctive word, passes).
 *   2. NO TRANSPORT/MUSEUM KEYWORD AT ALL. The matched title contains none
 *      of railway/railroad/tramway/tram/funicular/museum, AND doesn't match
 *      rule 1 either — catches a match to a bare place/geographic article
 *      (Cairngorm Funicular -> "Cairngorms": no keyword, 0% name-token
 *      overlap, not station-shaped).
 *
 * KNOWN, ACCEPTED LIMITATION, not silently glossed over: this cannot catch
 * a match where the TITLE is exactly right but the ARTICLE is about a
 * different ERA of the same-named entity — Great Central Railway's wikidata
 * match ("Great Central Railway") is the historic 1897-1923 company, not the
 * modern heritage railway (scratchpad/heritage-established-year-batch1-
 * report.md), and no title-string heuristic can tell those apart. That
 * needs reading the actual article (checking for a heritage-railway
 * disambiguation hatnote, an opening year that predates any preservation
 * movement, etc.) — this filter is a pre-filter, not a replacement for that.
 *
 * Usage:
 *   node scripts/check-heritage-wikidata-match.mjs             # full report
 *   node scripts/check-heritage-wikidata-match.mjs --slug=X,Y  # just these
 *   node scripts/check-heritage-wikidata-match.mjs --rejects-only
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { HERITAGE_META } from './lib/heritage-canonical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'scripts', 'output', 'heritage-wikidata-report.json');

// No trailing \b on funicular/tram/railway/etc — deliberately, so a plural
// ("Scarborough funiculars") or a compound ("branch line") still matches;
// only the LEADING \b matters, to avoid matching inside an unrelated word.
// "line" included after finding a real false reject on "Alnwick branch
// line" (Aln Valley Railway's genuine, correct Wikipedia match — smaller UK
// heritage lines are very often covered under the historic branch line's
// own article title rather than a separate modern one) — "line" alone is
// generic English, but in this specific matched-Wikipedia-title context a
// railway-domain source, so the false-negative risk of NOT including it
// (missing genuine matches like this one) outweighs the false-positive risk
// of including it.
const KEYWORD_RE = /\b(railway|railroad|tramway|tram|funicular|museum|line)/i;
const STATION_SUFFIX_RE = /\brailway station\b|\bstation\s*$/i;
const STOPWORDS = new Set([
  'the', 'and', 'of', 'a', 'an', 'railway', 'station', 'line', 'light',
  'heritage', 'museum', 'centre', 'center', 'tramway', 'tram', 'funicular',
  'railroad', 'collection', 'co', 'ltd', 'cio',
]);

function tokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

// Exported for reuse (e.g. by a future automated research script); also the
// sole logic this file's CLI wraps.
export function checkMatch(heritageMetaName, matchedTitle) {
  if (!matchedTitle) return { pass: true, reason: 'no matched title to check (unresolved)' };

  const looksLikeStation = STATION_SUFFIX_RE.test(matchedTitle);
  const hasKeyword = KEYWORD_RE.test(matchedTitle);

  const nameTokens = tokens(heritageMetaName);
  const titleTokenSet = new Set(tokens(matchedTitle));
  const missing = nameTokens.filter((t) => !titleTokenSet.has(t));
  const coverage = nameTokens.length ? (nameTokens.length - missing.length) / nameTokens.length : 1;

  if (looksLikeStation && coverage < 1) {
    return {
      pass: false,
      reason: `matched title looks like a specific station article and is missing distinctive name word(s): ${missing.join(', ')}`,
    };
  }
  // Rule 2 requires BOTH no keyword AND incomplete name coverage — an EXACT
  // or full-coverage name match (e.g. "Watercress Line" -> "Watercress
  // Line", "Whistlestop Valley" -> "Whistlestop Valley") is never rejected
  // just for not containing "railway"/"tramway"/etc literally, however
  // plausible-looking the keyword absence alone might seem. Found live,
  // fixed before shipping: an earlier version of this rule ignored coverage
  // here and wrongly rejected 5 exact/near-exact matches on the real 175 —
  // The Leas Lift, Watercress Line, Waverley Route Heritage Association,
  // Whistlestop Valley, Vivian Incline — none of which contain any of this
  // filter's keywords (cliff lifts and inclines are a real, distinct
  // sub-genre this keyword list doesn't happen to name), all of which are
  // otherwise a complete or near-complete name match and should never have
  // been flagged. A full-coverage match is a strong enough positive signal
  // on its own to override a merely-absent keyword.
  if (!hasKeyword && !looksLikeStation && coverage < 1) {
    return {
      pass: false,
      reason: `matched title has no railway/tramway/funicular/museum keyword AND is missing distinctive name word(s): ${missing.join(', ')} — looks like a place or unrelated topic`,
    };
  }
  return { pass: true, reason: coverage < 1 ? `plausible (partial name overlap, missing: ${missing.join(', ') || 'none'})` : 'plausible (full name overlap)' };
}

function main() {
  const args = process.argv.slice(2);
  const slugArg = args.find((a) => a.startsWith('--slug='));
  const wantSlugs = slugArg ? new Set(slugArg.slice(7).split(',').map((s) => s.trim())) : null;
  const rejectsOnly = args.includes('--rejects-only');

  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  const bySlug = {};
  for (const r of report.rows || []) bySlug[r.slug] = r;

  let checked = 0, rejected = 0, noTitle = 0;
  const rejects = [];

  for (const [name, meta] of Object.entries(HERITAGE_META)) {
    if (wantSlugs && !wantSlugs.has(meta.slug)) continue;
    const row = bySlug[meta.slug];
    const title = row && row.wikipedia_title;
    if (!title) { noTitle++; continue; }
    checked++;
    const result = checkMatch(name, title);
    if (!result.pass) {
      rejected++;
      rejects.push({ slug: meta.slug, name, matched: title, reason: result.reason });
    }
    if (!rejectsOnly || !result.pass) {
      console.log(`${result.pass ? 'PASS  ' : 'REJECT'} ${meta.slug.padEnd(45)} "${name}" -> "${title}"`);
      if (!result.pass || wantSlugs) console.log(`         ${result.reason}`);
    }
  }

  console.log(`\n${checked} matched titles checked, ${rejected} rejected, ${noTitle} had no wikidata match to check at all.`);
  if (rejects.length) {
    console.log('\nRejected slugs (need a manual re-search before date extraction, not a blind fetch of the matched title):');
    rejects.forEach((r) => console.log(`  ${r.slug}`));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

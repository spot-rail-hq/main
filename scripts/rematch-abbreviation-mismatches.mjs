#!/usr/bin/env node
/**
 * scripts/rematch-abbreviation-mismatches.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPING / REPORT PASS ONLY. Does not read or write stations-content.json.
 *
 * Targeted re-test of the "mixed-other" needs-manual-review bucket from
 * scripts/scope-wikipedia-coverage.mjs's report — stations where a real,
 * non-disambiguation Wikipedia page was found for at least one candidate
 * but couldn't be confirmed (title didn't match, no/rejecting coordinates).
 * A chunk of that bucket turned out to be caused by one specific, fixable
 * problem: NaPTAN's abbreviated county qualifier (e.g. "Warks") doesn't
 * match Wikipedia's disambiguator convention, which spells the county out
 * in full (e.g. "Hatton railway station (Warwickshire)").
 *
 * This script does NOT re-implement matching — it imports matchStation()
 * from scope-wikipedia-coverage.mjs and passes it extra candidate titles
 * built from data/naptan-county-abbreviations.json, so the acceptance
 * logic (title/geo confirmation, disambiguation rejection, etc.) is
 * identical to the main run, just with one more candidate to try.
 *
 * Only touches the specific CRS codes in the "mixed-other" bucket —
 * the disambiguation-only and genuinely-no-page buckets are untouched,
 * per the agreed handling (those need separate treatment, not guessing).
 *
 * Run:
 *   node scripts/rematch-abbreviation-mismatches.mjs
 */

import {
  matchStation,
  classifyTier,
  splitNaptanName,
  loadJson,
  saveJson,
  STATION_LIST_PATH,
  CHECKPOINT_PATH,
  REPORT_JSON_PATH,
  REPORT_MD_PATH,
  STUB_THRESHOLD_CHARS,
  GEO_REJECT_KM,
} from './scope-wikipedia-coverage.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ABBREV_PATH = path.join(ROOT, 'data', 'naptan-county-abbreviations.json');

function buildAbbreviationMap() {
  const raw = loadJson(ABBREV_PATH, { observedInStationList: {}, preemptive: {} });
  return { ...raw.observedInStationList, ...raw.preemptive };
}

function extraCandidatesFor(base, qualifier, abbrevMap) {
  if (!qualifier) return { extras: [], expandedQualifier: null };
  const expanded = abbrevMap[qualifier];
  if (!expanded || expanded === qualifier) return { extras: [], expandedQualifier: null };
  return {
    extras: [
      `${base} railway station (${expanded})`,
      `${base} station (${expanded})`,
      `${base} (${expanded})`,
    ],
    expandedQualifier: expanded,
  };
}

async function main() {
  const report = loadJson(REPORT_JSON_PATH, null);
  if (!report || !report.needsManualReviewBreakdown) {
    throw new Error('wikipedia-coverage-report.json (with needsManualReviewBreakdown) not found — run scope-wikipedia-coverage.mjs first.');
  }
  const targets = report.needsManualReviewBreakdown.entries['mixed-other'];
  if (!targets || !targets.length) throw new Error('No mixed-other bucket found in the report.');

  const stations = loadJson(STATION_LIST_PATH, []);
  const stationByCrs = new Map(stations.map((s) => [s.crs, s]));
  const abbrevMap = buildAbbreviationMap();
  const checkpoint = loadJson(CHECKPOINT_PATH, { results: {} });

  console.log(`Re-testing ${targets.length} stations from the mixed-other bucket...\n`);

  const before = [];
  const after = [];
  let newlyMatched = 0;
  let stillUnresolved = 0;
  let notApplicable = 0;

  for (const target of targets) {
    const station = stationByCrs.get(target.crs);
    if (!station) {
      console.log(`  ${target.crs}: not found in station-list.json, skipped`);
      continue;
    }
    const beforeEntry = checkpoint.results[target.crs];
    before.push({ crs: target.crs, name: station.name, status: beforeEntry?.status, tier: beforeEntry?.tier });

    const { base, qualifier } = splitNaptanName(station.name);
    const { extras, expandedQualifier } = extraCandidatesFor(base, qualifier, abbrevMap);

    if (!extras.length) {
      notApplicable++;
      after.push({ crs: target.crs, name: station.name, status: 'needs-review', tier: 'no-article', note: qualifier ? `qualifier "${qualifier}" not in abbreviation table` : 'no qualifier to expand' });
      console.log(`  ${target.crs} (${station.name}): SKIPPED — ${qualifier ? `qualifier "${qualifier}" not in abbreviation table` : 'no parenthetical qualifier at all'}`);
      continue;
    }

    const result = await matchStation(station, extras);
    const tier = classifyTier(result);

    checkpoint.results[target.crs] = {
      crs: station.crs,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      tier,
      ...result,
    };

    if (result.status === 'matched') {
      newlyMatched++;
      console.log(`  ${target.crs} (${station.name}): MATCHED via expanded qualifier "${qualifier}" → "${expandedQualifier}" — "${result.matchedTitle}" (${tier}, ${result.extractLength} chars)`);
    } else {
      stillUnresolved++;
      console.log(`  ${target.crs} (${station.name}): still unresolved even with "${qualifier}" → "${expandedQualifier}" — ${result.reason}`);
    }
    after.push({ crs: target.crs, name: station.name, status: result.status, tier, matchedTitle: result.matchedTitle || null });
  }

  saveJson(CHECKPOINT_PATH, checkpoint);

  // ─── Fold results back into the tier report ─────────────────────────────
  const all = Object.values(checkpoint.results);
  const matched = all.filter((r) => r.status === 'matched');
  const needsReview = all.filter((r) => r.status === 'needs-review');
  const tiers = { 'no-article': [], stub: [], substantive: [] };
  for (const r of all) tiers[r.tier].push(r.crs);

  report.matchRate = { autoMatched: matched.length, needsManualReview: needsReview.length };
  report.tierCounts = {
    'no-article': tiers['no-article'].length,
    stub: tiers.stub.length,
    substantive: tiers.substantive.length,
  };
  report.tierCrsLists = tiers;
  report.needsManualReview = needsReview.map((r) => ({
    crs: r.crs,
    name: r.name,
    reason: r.reason,
    weakCandidate: r.weakCandidate,
    candidatesTried: r.candidatesTried,
  }));

  // Rebuild the breakdown: remove now-resolved CRS codes from mixed-other,
  // leave disambiguation-only and no-page-found buckets untouched (per the
  // agreed handling), recompute counts.
  const resolvedCrs = new Set(after.filter((a) => a.status === 'matched').map((a) => a.crs));
  const oldMixed = report.needsManualReviewBreakdown.entries['mixed-other'];
  const stillMixed = oldMixed.filter((e) => !resolvedCrs.has(e.crs));
  report.needsManualReviewBreakdown.entries['mixed-other'] = stillMixed;
  report.needsManualReviewBreakdown.counts['mixed-other'] = stillMixed.length;
  report.needsManualReviewBreakdown._note += ` [Updated ${new Date().toISOString()}: re-tested via scripts/rematch-abbreviation-mismatches.mjs with a NaPTAN-abbreviation → full-county-name lookup table (data/naptan-county-abbreviations.json) as an extra matching candidate — ${newlyMatched} of the original 22 resolved this way, ${stillUnresolved} still didn't match even with the expansion, ${notApplicable} had no abbreviated qualifier to expand in the first place and are unchanged.]`;

  saveJson(REPORT_JSON_PATH, report);

  const md = `# Wikipedia coverage scoping report — naptan_stations

Generated: ${report.generatedAt}
Updated: ${new Date().toISOString()} (abbreviation-mismatch re-test, scripts/rematch-abbreviation-mismatches.mjs)

## Match rate (Phase 1)
- Auto-matched: ${report.matchRate.autoMatched} / ${report.totalStations}
- Needs manual review: ${report.matchRate.needsManualReview} / ${report.totalStations}

## Tier breakdown (Phase 2)
- no-article: ${report.tierCounts['no-article']}
- stub (extract < ${STUB_THRESHOLD_CHARS} chars): ${report.tierCounts.stub}
- substantive (extract >= ${STUB_THRESHOLD_CHARS} chars): ${report.tierCounts.substantive}

## Sample substantive entries
${report.sampleSubstantive.map((s) => `### ${s.name} (${s.crs}) — matched "${s.matchedTitle}", ${s.extractLength} chars\n> ${s.extractPreview}${s.extractLength > 500 ? '…' : ''}\n`).join('\n')}

## Needs manual review — breakdown by cause
- disambiguation-only-likely-has-article: ${report.needsManualReviewBreakdown.counts['disambiguation-only-likely-has-article']} (untouched this pass)
- unverified-page-found: ${report.needsManualReviewBreakdown.counts['unverified-page-found']} (untouched this pass)
- no-page-found-any-candidate: ${report.needsManualReviewBreakdown.counts['no-page-found-any-candidate']} (untouched this pass)
- mixed-other (abbreviation mismatch): ${report.needsManualReviewBreakdown.counts['mixed-other']} remaining after re-test (was 22; ${newlyMatched} resolved, ${notApplicable} had no qualifier to expand, ${stillUnresolved} still unresolved)

## Needs manual review (first 30 of ${needsReview.length})
${needsReview.slice(0, 30).map((r) => `- **${r.crs}** (${r.name}): ${r.reason}`).join('\n')}

Full CRS lists per tier and the complete review list are in wikipedia-coverage-report.json.
`;
  writeFileSync(REPORT_MD_PATH, md);

  console.log(`\n=== Done ===`);
  console.log(`Of 22: ${newlyMatched} newly matched, ${stillUnresolved} still unresolved, ${notApplicable} not applicable (no qualifier to expand)`);
  console.log(`Updated tiers: no-article=${report.tierCounts['no-article']}, stub=${report.tierCounts.stub}, substantive=${report.tierCounts.substantive}`);
  console.log(`Updated match rate: ${report.matchRate.autoMatched}/${report.totalStations} auto-matched, ${report.matchRate.needsManualReview} flagged for review`);

  console.log(`\n=== Before/after for these 22 ===`);
  for (const b of before) {
    const a = after.find((x) => x.crs === b.crs);
    console.log(`${b.crs} (${b.name}): ${b.status}/${b.tier}  →  ${a.status}/${a.tier}${a.matchedTitle ? ` ("${a.matchedTitle}")` : ''}${a.note ? ` [${a.note}]` : ''}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

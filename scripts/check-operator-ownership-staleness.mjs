#!/usr/bin/env node
/**
 * scripts/check-operator-ownership-staleness.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Read-only review-queue report for operators-content.json's ownership_status
 * / ownership_parent fields (see scratchpad/ownership-status-investigation.md
 * Section 4). Never writes anything — same posture as
 * check-heritage-wikidata-match.mjs and check-color-separation.mjs, and the
 * same "a list to look at, not something the script fixes itself" spirit as
 * build-line-segments.mjs's UNMAPPED HERITAGE report.
 *
 * Ownership status goes stale on a real-world political/commercial calendar
 * that has nothing to do with this repo's own release cadence — unlike most
 * of this file's other fields, it cannot be safely assumed still-true just
 * because nothing here changed it. Two independent checks, because they
 * catch two different failure modes:
 *
 *   1. PASSED FUTURE-TRANSFER DATES. An announced transfer (e.g. "GW
 *      nationalises 13 Dec 2026") whose date has now passed. Does NOT assume
 *      the transfer happened on schedule — governments slip dates — only
 *      flags "go check whether this happened and update the record".
 *   2. STALE VERIFICATION. An entry whose `source.checked_at` is older than
 *      the threshold, regardless of whether it has any future_transfer at
 *      all. This catches what check 1 structurally cannot: a QUIET change
 *      with no announced date (e.g. a parent group quietly selling its
 *      stake in an open-access operator) — the only way to catch that is
 *      periodic re-verification against a primary source, not anything this
 *      data file can tell you about itself.
 *
 * Both checks resolve `ownership_parent` pointers first, so a sub-brand's
 * staleness is attributed to the record that actually needs fixing (e.g.
 * SN/TL/GX/GN's shared staleness is reported once, against GTR — not
 * skipped because the sub-brands don't carry their own ownership_status).
 *
 * Exit code is always 0 — this is a report, not a guard. There is no write
 * for it to protect (unlike the read-merge-preserve guards elsewhere in
 * this repo, which exist specifically to stop a destructive overwrite).
 *
 * Usage:
 *   node scripts/check-operator-ownership-staleness.mjs
 *   node scripts/check-operator-ownership-staleness.mjs --stale-days=90
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONTENT_PATH = path.join(ROOT, 'operators-content.json');

const DEFAULT_STALE_DAYS = 180;

function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso + 'T00:00:00Z').getTime();
  const to = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((to - from) / 86400000);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Resolves ownership_parent one level (never chains — same rule the
// population script enforces at write time) so a sub-brand's checks run
// against the record that actually owns the fact.
function resolve(content, key) {
  const entry = content[key];
  if (!entry) return null;
  if (entry.ownership_status) return { via: key, os: entry.ownership_status };
  if (entry.ownership_parent) {
    const parent = content[entry.ownership_parent];
    if (parent && parent.ownership_status) return { via: entry.ownership_parent, os: parent.ownership_status };
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const staleDaysArg = args.find((a) => a.startsWith('--stale-days='));
  const staleDays = staleDaysArg ? parseInt(staleDaysArg.slice('--stale-days='.length), 10) : DEFAULT_STALE_DAYS;

  const content = JSON.parse(readFileSync(CONTENT_PATH, 'utf8'));
  const keys = Object.keys(content).filter((k) => k !== '_notes');
  const today = todayIso();

  const overdue = [];
  const stale = [];
  const missing = [];
  const seenSources = new Set(); // avoid reporting the same underlying GTR-style record 4 times

  for (const key of keys) {
    const resolved = resolve(content, key);
    if (!resolved) { missing.push(key); continue; }
    const { via, os } = resolved;
    if (seenSources.has(via)) continue; // already reported this shared record via an earlier sub-brand
    seenSources.add(via);

    if (os.future_transfer && os.future_transfer.date) {
      const overdueDays = daysBetween(os.future_transfer.date, today);
      if (overdueDays >= 0) {
        overdue.push({ key: via, toStatus: os.future_transfer.to_status, date: os.future_transfer.date, overdueDays, confirmed: !!os.future_transfer.confirmed });
      }
    }
    if (os.source && os.source.checked_at) {
      const age = daysBetween(os.source.checked_at, today);
      if (age >= staleDays) stale.push({ key: via, checkedAt: os.source.checked_at, ageDays: age });
    } else {
      missing.push(via + ' (has ownership_status but no source.checked_at)');
    }
  }

  console.log(`Operator ownership staleness check — ${keys.length} entries, ${seenSources.size} distinct ownership record(s), run ${today}\n`);

  console.log(`1. Passed future-transfer dates (${overdue.length}):`);
  if (!overdue.length) console.log('   none — clean');
  overdue.forEach((o) => console.log(`   ${o.key}: announced transfer to "${o.toStatus}" on ${o.date} is ${o.overdueDays} day(s) past due${o.confirmed ? '' : ' (was only an estimate, not a confirmed date)'} — verify and update.`));

  console.log(`\n2. Stale verification, >${staleDays} days since last checked (${stale.length}):`);
  if (!stale.length) console.log('   none — clean');
  stale.sort((a, b) => b.ageDays - a.ageDays).forEach((s) => console.log(`   ${s.key}: last checked ${s.checkedAt}, ${s.ageDays} days ago — due for re-verification.`));

  console.log(`\n3. Entries with no resolvable ownership data (${missing.length}):`);
  if (!missing.length) console.log('   none — clean');
  missing.forEach((m) => console.log(`   ${m}`));

  console.log(`\nDone. This is a report, not a guard — exiting 0 regardless of findings.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

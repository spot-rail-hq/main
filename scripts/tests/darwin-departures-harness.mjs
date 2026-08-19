#!/usr/bin/env node
/**
 * Verifies normalizeBoard() (api/_lib/darwin-normalize.mjs) against the two
 * real GetDepBoardWithDetails payloads saved in fixtures/darwin-departures/
 * — no live API call, no server, no key required.
 *
 * Unlike the other *-harness.mjs files in this directory, this one does not
 * slice source text out of a page — api/_lib/darwin-normalize.mjs is
 * already a plain, real ES module, so it's imported directly. That means
 * this harness tests the exact code api/darwin-departures.js runs in
 * production, not a copy.
 *
 *   node scripts/tests/darwin-departures-harness.mjs             # run assertions
 *   node scripts/tests/darwin-departures-harness.mjs <fixture.json>  # dump
 *     the normalised shape for that fixture to stdout instead — this is the
 *     "verify the shape offline" path, e.g.:
 *     node scripts/tests/darwin-departures-harness.mjs fixtures/darwin-departures/lst-board.json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeBoard } from '../../api/_lib/darwin-normalize.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const FIXTURES = {
  bhm: path.join(REPO_ROOT, 'fixtures/darwin-departures/bhm-board.json'),
  lst: path.join(REPO_ROOT, 'fixtures/darwin-departures/lst-board.json'),
};

const dumpArg = process.argv[2];
if (dumpArg) {
  const raw = JSON.parse(readFileSync(path.resolve(dumpArg), 'utf8'));
  console.log(JSON.stringify(normalizeBoard(raw), null, 2));
  process.exit(0);
}

const VALID_STATUSES = new Set(['on-time', 'delayed', 'delayed-no-estimate', 'cancelled', 'no-report', 'unknown']);

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) {
    pass++;
    console.log('PASS: ' + label);
  } else {
    fail++;
    console.log('FAIL: ' + label);
  }
}

for (const [name, fixturePath] of Object.entries(FIXTURES)) {
  console.log('\n── ' + name + ' (' + fixturePath + ') ──');
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const rawCount = Array.isArray(raw.trainServices) ? raw.trainServices.length : 0;

  let board;
  check(name + ': normalizeBoard() does not throw', (() => {
    try { board = normalizeBoard(raw); return true; } catch (e) { console.log('  threw:', e); return false; }
  })());
  if (!board) continue;

  check(name + ': services array length matches raw trainServices length', board.services.length === rawCount);
  check(name + ': crs/locationName/generatedAt passed through', !!board.crs && !!board.locationName && !!board.generatedAt);
  check(name + ': platformAvailable is a real boolean', typeof board.platformAvailable === 'boolean');

  let allStatusesValid = true;
  let noneCoachCountIsNull = true;
  let loadingGateHonoured = true;
  let noZeroAsAbsentSentinel = true;
  let etdNeverDropped = true;

  for (const s of board.services) {
    if (!VALID_STATUSES.has(s.status)) allStatusesValid = false;
    if (s.coachCountSource === 'none' && s.coachCount !== null) noneCoachCountIsNull = false;
    if (s.coachCount === 0) noZeroAsAbsentSentinel = false; // 0 must never appear as a value — null is the only "absent" signal
    if (s.formation) {
      for (const c of s.formation.coaches) {
        if (!c.loadingSpecified && c.loadingPercent !== null) loadingGateHonoured = false;
        if (c.loadingSpecified && c.loadingPercent === null) loadingGateHonoured = false; // every live loadingSpecified:true coach had a real number
      }
    }
    if (s.status === 'unknown' || VALID_STATUSES.has(s.status)) {
      // presence check only — an unrecognised raw etd must still resolve to
      // *some* named status, never throw and never be silently omitted
    } else {
      etdNeverDropped = false;
    }
  }

  check(name + ': every service resolves to one of the 6 named statuses (never dropped/unknown-crash)', allStatusesValid && etdNeverDropped);
  check(name + ': coachCountSource "none" always pairs with coachCount === null', noneCoachCountIsNull);
  check(name + ': coachCount is never 0 (0 is a real Darwin value elsewhere, never reused as "absent")', noZeroAsAbsentSentinel);
  check(name + ': loadingPercent is non-null iff loadingSpecified is true', loadingGateHonoured);

  // nrccMessages sanitiser
  const rawMessages = Array.isArray(raw.nrccMessages) ? raw.nrccMessages : [];
  if (rawMessages.length) {
    const allSafe = board.nrccMessages.every((m) => !/<(?!\/?(a|p)\b)[a-zA-Z]/i.test(m.html) && !/href="(?!https:\/\/(www\.)?nationalrail\.co\.uk)/i.test(m.html));
    check(name + ': nrccMessages contains only allowlisted tags/hosts', allSafe);
    const keptALink = board.nrccMessages.some((m) => /<a href="https:\/\/(www\.)?nationalrail\.co\.uk/i.test(m.html));
    check(name + ': the live nationalrail.co.uk link survived sanitisation', keptALink);
  } else {
    console.log('  (no nrccMessages in this fixture — sanitiser checks skipped)');
  }
}

console.log('\n' + '═'.repeat(70));
console.log(pass + '/' + (pass + fail) + ' checks passed');
if (fail > 0) process.exit(1);

#!/usr/bin/env node
/**
 * verify-operator-coverage.mjs — does the segment graph actually carry each
 * operator's real-world network, or just a plausible-looking km total?
 *
 * WHY THIS EXISTS. Every other check on the line-segment pipeline is an
 * aggregate: segment counts, track kilometres, operator counts in tilestats.
 * All of them can look healthy while a whole operator is silently missing or
 * folded into the wrong key — a canonicalisation entry that stops matching
 * moves its track to another operator without changing a single total. This
 * harness asks a different question: pick places where a named operator
 * demonstrably runs trains, and check the graph agrees.
 *
 * HOW IT WORKS. Each probe is a coordinate on that operator's route. A probe
 * passes if any segment within TOLERANCE_M of the point carries the operator's
 * key. Failures are reported as either "parent/other key" (track is present but
 * attributed elsewhere — a canonicalisation problem) or "absent" (no track at
 * all — an extraction problem). The distinction is the whole point: they have
 * completely different causes and fixes.
 *
 * TOLERANCE_M = 700. Probes are station coordinates but segments are track
 * geometry, and a station node sits beside the running line, not on it — large
 * termini put the two several hundred metres apart. 700 m clears that without
 * being loose enough to catch a genuinely different line: parallel routes in
 * the areas probed here are further apart than that.
 *
 * SCOPE — DELIBERATELY FIXED AT 40 PROBES ACROSS 4 OPERATORS. This is a
 * regression tripwire for four cases that were investigated and understood, not
 * a coverage metric for the network. Do not add operators to make the number
 * look better; a probe nobody has verified against reality by hand is worse
 * than no probe, because it will eventually fail and nobody will know whether
 * the graph or the probe is wrong. If a NEW operator needs covering, verify it
 * by hand first, then add it with the same care.
 *
 * Usage: node scripts/verify-operator-coverage.mjs   (exit 1 on any failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const TOLERANCE_M = 700;

/**
 * Operators whose track is legitimately carried under a PARENT key in OSM, so
 * a probe naming the sub-brand passes when the parent is what the graph holds.
 *
 * Southern is the live case. Most of the Southern/Thameslink/Great Northern/
 * Gatwick Express network is tagged in OSM at the Govia Thameslink Railway
 * parent level rather than per sub-brand, so the graph has no per-brand
 * Southern network to find. That is an accepted upstream state, not a bug in
 * this pipeline — see CLAUDE.md's operator-line-colors section and the
 * "operator coverage gaps" entry in LINE-COLORING-RUNBOOK.md. Splitting them
 * back out needs route-name matching, shaped like splitTflLine(); until then a
 * GTR hit IS the correct answer for a Southern probe, and this map records that
 * so the pass is explicit rather than accidental.
 */
const PARENT_OK = {
  SN: { parents: ['GTR'], note: 'Southern is tagged at the GTR parent level in OSM; no per-brand split yet' },
};

/**
 * Probes that are KNOWN to fail against reality, with the reason understood.
 * They stay in the list because they are real network — silently deleting them
 * would hide the gap — but they do not fail the run, so the harness has a green
 * baseline and a red result always means something NEW broke.
 *
 * Merseyrail's Kirkby branch: the graph holds no ME-keyed track within
 * tolerance of Kirkby. Merseyrail terminates there on a platform shared with
 * Northern's Wigan service, and the approach is tagged for the Northern route
 * rather than carrying a Merseyrail relation. Recorded as a finding, not fixed
 * — see the "operator coverage gaps" section of LINE-COLORING-RUNBOOK.md.
 */
const KNOWN_GAPS = new Set(['ME/Kirkby']);

const PROBES = {
  SN: {
    label: 'Southern',
    points: [
      ['Brighton Main Line — Victoria', [-0.1441, 51.4952]],
      ['Brighton Main Line — East Croydon', [-0.0928, 51.3758]],
      ['Brighton Main Line — Gatwick', [-0.1614, 51.1565]],
      ['Brighton Main Line — Haywards Heath', [-0.1063, 51.0055]],
      ['Brighton Main Line — Brighton', [-0.1410, 50.8290]],
      ['Sutton', [-0.1917, 51.3595]],
      ['Epsom', [-0.2686, 51.3340]],
      ['Horsham', [-0.3244, 51.0640]],
      ['Littlehampton', [-0.5407, 50.8082]],
      ['Bognor Regis', [-0.6733, 50.7856]],
      ['Chichester', [-0.7794, 50.8306]],
      ['Portsmouth Harbour', [-1.1097, 50.7967]],
      ['Seaford', [0.1024, 50.7706]],
      ['Caterham', [-0.0817, 51.2822]],
      ['Tattenham Corner', [-0.2385, 51.3084]],
      ['Oxted', [-0.0044, 51.2570]],
      ['Eastbourne', [0.2810, 50.7686]],
      ['Southampton Central', [-1.4136, 50.9077]],
    ],
  },
  ME: {
    label: 'Merseyrail',
    points: [
      ['Liverpool Central', [-2.9796, 53.4045]],
      ['Southport', [-3.0056, 53.6459]],
      ['Ormskirk', [-2.8862, 53.5686]],
      ['Kirkby', [-2.8908, 53.4818]],
      ['New Brighton', [-3.0490, 53.4386]],
      ['West Kirby', [-3.1830, 53.3733]],
      ['Chester', [-2.8797, 53.1969]],
      ['Ellesmere Port', [-2.8968, 53.2830]],
      ['Hunts Cross', [-2.8534, 53.3585]],
    ],
  },
  CC: {
    label: 'c2c',
    points: [
      ['Fenchurch Street', [-0.0784, 51.5115]],
      ['Barking', [0.0810, 51.5396]],
      ['Upminster', [0.2510, 51.5590]],
      ['Basildon', [0.4560, 51.5720]],
      ['Southend Central', [0.7110, 51.5375]],
      ['Shoeburyness', [0.7960, 51.5310]],
      ['Grays', [0.3230, 51.4760]],
      ['Tilbury Town', [0.3580, 51.4640]],
    ],
  },
  IL: {
    label: 'Island Line',
    points: [
      ['Ryde Pier Head', [-1.1590, 50.7400]],
      ['Ryde Esplanade', [-1.1600, 50.7330]],
      ['Brading', [-1.1440, 50.6810]],
      ['Sandown', [-1.1560, 50.6540]],
      ['Shanklin', [-1.1780, 50.6330]],
    ],
  },
};

// Planar approximation — same reasoning as dedupe-line-segments.mjs, fine for
// a "is this point near that line" test at this scale.
const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * Math.cos((a[1] * Math.PI) / 180) * 111320, (a[1] - b[1]) * 111320);

function operatorsNear(segments, pt) {
  const out = new Set();
  for (const s of segments) {
    for (const c of s.coords) {
      if (metres(c, pt) < TOLERANCE_M) {
        for (const o of s.operators || []) out.add(o);
        break;
      }
    }
  }
  return out;
}

const { segments } = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
console.log(`Loaded ${segments.length} segments from ${SEG_PATH}`);
console.log(`Tolerance ${TOLERANCE_M} m · ${Object.values(PROBES).reduce((a, p) => a + p.points.length, 0)} probes\n`);

let failures = 0;
for (const [key, { label, points }] of Object.entries(PROBES)) {
  console.log('='.repeat(88));
  console.log(`${label} (${key})`);
  console.log('='.repeat(88));
  let own = 0, viaParent = 0, wrong = 0, absent = 0, known = 0;
  for (const [name, pt] of points) {
    const near = operatorsNear(segments, pt);
    let verdict;
    if (near.has(key)) { own++; verdict = `PASS  ${key}`; }
    else if (PARENT_OK[key]?.parents.some((p) => near.has(p))) {
      viaParent++;
      verdict = `PASS  via parent ${PARENT_OK[key].parents.filter((p) => near.has(p)).join(',')}`;
    } else if (KNOWN_GAPS.has(`${key}/${name}`)) {
      known++;
      verdict = `KNOWN GAP  ${near.size ? `other keys: ${[...near].slice(0, 3).join(',')}` : 'no track within tolerance'}`;
    } else if (near.size) { wrong++; failures++; verdict = `FAIL  other keys: ${[...near].slice(0, 4).join(',')}`; }
    else { absent++; failures++; verdict = 'FAIL  no track within tolerance'; }
    console.log('  ' + name.padEnd(38) + verdict);
  }
  const parts = [`${own} own key`];
  if (viaParent) parts.push(`${viaParent} via parent`);
  if (known) parts.push(`${known} known gap`);
  if (wrong) parts.push(`${wrong} wrong key`);
  if (absent) parts.push(`${absent} absent`);
  console.log(`  → ${parts.join(', ')} of ${points.length}`);
  if (viaParent && PARENT_OK[key]) console.log(`     note: ${PARENT_OK[key].note}`);
  console.log('');
}

if (failures) {
  console.error(`${failures} probe(s) failed. A "wrong key" result points at the canonicalisation map (scripts/build-operator-inventory.mjs); "no track" points at extraction or the live-railway filter in build-line-segments.mjs.`);
  process.exit(1);
}
console.log('All probes passed (known gaps excepted).');

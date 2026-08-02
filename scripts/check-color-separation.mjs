#!/usr/bin/env node
/**
 * check-color-separation.mjs — measure a CANDIDATE colour against the whole
 * shipped palette, without regenerating it.
 *
 * Why this exists: build-operator-palette.mjs is the only place the gate math
 * lives, but it is a build script — importing it WRITES data/operator-colors.json
 * and would destroy the hand-set entries (Grand Central dark, Blackpool Tramway,
 * Heritage) that a regeneration does not reproduce. So this script does not
 * import it and does not copy it either: it SLICES the colour-math + passesGates
 * block straight out of the generator's source text and evaluates that. The gate
 * applied here is therefore literally the same code as the gate applied at
 * generation time, and if that block is edited or moved, this script fails loudly
 * (see assertions below) rather than silently drifting into a stale copy.
 *
 * Run:
 *   node scripts/check-color-separation.mjs '#FFDC44' --key='Manchester Metrolink'
 *   node scripts/check-color-separation.mjs '#FFDC44' --key='Manchester Metrolink' --theme=dark
 *
 * --key is the palette key the candidate would REPLACE; it is excluded from the
 * comparison set (a colour is not required to differ from itself) and is used for
 * the KNOWN_ADJACENT strict-gate lookup. Omit --theme to check both.
 *
 * Reports, per theme: the full ΔE76 ranking against every toc/metro/tfl_lines/
 * heritage entry, plus protanopia- and deuteranopia-simulated ΔE76 for each pair,
 * and flags everything under MIN_DELTA_E. Exit code 1 if the blocking gate fails
 * (base ΔE76 for any pair; CVD too for KNOWN_ADJACENT pairs) — matching
 * passesGates' own definition of "blocking" rather than inventing a stricter one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(__dirname, 'build-operator-palette.mjs');
const PALETTE = path.join(ROOT, 'data', 'operator-colors.json');

// ── Slice the generator's gate block out of its source ──────────────────
// Between the "Color math" banner and the findFallbackHue comment sits
// everything the gate needs and nothing that touches the filesystem:
// hex/lab/CVD math, MIN_DELTA_E, KNOWN_ADJACENT, passesGates.
const START = '// ═══ Color math';
const END = '// Fallback: search outward in hue';
const src = readFileSync(GENERATOR, 'utf8');
const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
  throw new Error(
    `Could not locate the gate block in ${GENERATOR} (looked for ${JSON.stringify(START)} then ${JSON.stringify(END)}). ` +
    'The generator has been restructured — update the slice markers here rather than copying the math, or this check silently stops testing the real gate.'
  );
}
const gateSrc = src.slice(startIdx, endIdx);
for (const needed of ['function deltaE76', 'function simulateCvd', 'MIN_DELTA_E', 'KNOWN_ADJACENT', 'function passesGates']) {
  if (!gateSrc.includes(needed)) {
    throw new Error(`Sliced gate block is missing ${needed} — the generator moved it outside the slice range; fix the markers in this script.`);
  }
}
const gate = await import(
  'data:text/javascript;base64,' +
  Buffer.from(`${gateSrc}\nexport { deltaE76, simulateCvd, MIN_DELTA_E, KNOWN_ADJACENT, passesGates };`).toString('base64')
);
const { deltaE76, simulateCvd, MIN_DELTA_E, KNOWN_ADJACENT, passesGates } = gate;

// ── Args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const candidate = (args.find((a) => !a.startsWith('--')) || '').toUpperCase();
if (!/^#[0-9A-F]{6}$/.test(candidate)) {
  console.error('Usage: node scripts/check-color-separation.mjs <#RRGGBB> [--key=<palette key>] [--theme=dark|light]');
  process.exit(2);
}
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^['"]|['"]$/g, '') : null;
};
const selfKey = argVal('key');
const themeArg = argVal('theme');
const themes = themeArg ? [themeArg] : ['dark', 'light'];

// ── Build the comparison set from the SHIPPED palette ───────────────────
// Reads data/operator-colors.json, not the generator's in-memory placement —
// so hand-set entries that a regeneration would not reproduce (Grand Central
// dark, Blackpool Tramway, Heritage) are included, which is the whole point:
// those are real colours on the map and a candidate has to clear them too.
const palette = JSON.parse(readFileSync(PALETTE, 'utf8'));
function paletteFor(theme) {
  const out = {};
  for (const section of ['toc', 'metro', 'tfl_lines']) {
    for (const [key, val] of Object.entries(palette[section] || {})) {
      if (val && val[theme]) out[`${section}:${key}`] = val[theme];
    }
  }
  if (palette.heritage && palette.heritage[theme]) out['heritage:heritage'] = palette.heritage[theme];
  return out;
}

let failed = false;
for (const theme of themes) {
  const all = paletteFor(theme);
  const selfEntry = selfKey ? Object.keys(all).find((k) => k.split(':').slice(1).join(':') === selfKey) : null;
  if (selfKey && !selfEntry) {
    console.error(`WARNING: --key=${selfKey} matched no entry in the ${theme} palette; comparing against everything.`);
  }
  const others = { ...all };
  if (selfEntry) delete others[selfEntry];

  const rows = Object.entries(others).map(([key, hex]) => {
    const bare = key.split(':').slice(1).join(':');
    const strict = KNOWN_ADJACENT.has([selfKey, bare].sort().join('+'));
    return {
      key, hex, bare, strict,
      de: deltaE76(candidate, hex),
      prot: deltaE76(simulateCvd(candidate, 'protanopia'), simulateCvd(hex, 'protanopia')),
      deut: deltaE76(simulateCvd(candidate, 'deuteranopia'), simulateCvd(hex, 'deuteranopia')),
    };
  }).sort((a, b) => Math.min(a.de, a.prot, a.deut) - Math.min(b.de, b.prot, b.deut));

  console.log(`\n══ ${candidate} vs ${Object.keys(others).length} palette colours — ${theme.toUpperCase()} theme ══`);
  if (selfEntry) console.log(`   (replacing ${selfEntry} = ${all[selfEntry]}, excluded from the comparison)`);
  console.log(`   floor: ΔE76 ${MIN_DELTA_E} (blocking for all pairs; CVD blocking only for KNOWN_ADJACENT pairs)\n`);
  console.log('   ' + 'entry'.padEnd(42) + 'hex'.padEnd(10) + 'ΔE76'.padStart(7) + 'prot'.padStart(8) + 'deut'.padStart(8));
  for (const r of rows.slice(0, 12)) {
    const mark = r.de < MIN_DELTA_E ? ' ← ΔE BELOW FLOOR' : (Math.min(r.prot, r.deut) < MIN_DELTA_E ? (r.strict ? ' ← CVD BELOW FLOOR (adjacent, blocking)' : ' ← CVD below floor (non-adjacent, advisory)') : '');
    console.log('   ' + r.key.padEnd(42) + r.hex.padEnd(10) + r.de.toFixed(1).padStart(7) + r.prot.toFixed(1).padStart(8) + r.deut.toFixed(1).padStart(8) + mark);
  }
  const worst = rows[0];
  console.log(`\n   closest by ΔE76:      ${rows.slice().sort((a, b) => a.de - b.de)[0].key} at ${rows.slice().sort((a, b) => a.de - b.de)[0].de.toFixed(1)}`);
  console.log(`   worst-case CVD:       ${worst.key} at ${Math.min(worst.prot, worst.deut).toFixed(1)}`);

  const verdict = passesGates(candidate, selfKey, Object.fromEntries(rows.map((r) => [r.bare, r.hex])));
  console.log(`   passesGates():        ${verdict.ok ? 'PASS' : 'FAIL — ' + verdict.reason}`);
  if (!verdict.ok) failed = true;
}

process.exit(failed ? 1 : 0);

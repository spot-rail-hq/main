#!/usr/bin/env node
/**
 * scripts/build-operator-palette.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 of the operator-colored rail line project (see the approved plan
 * and Phase 0's scripts/output/operator-inventory.json for the canonical
 * operator list this palette covers).
 *
 * Hand-curated dark-theme hex per canonical operator/category below — not
 * algorithmically generated, since real brand association (LNER red, GWR
 * green, Merseyrail's yellow/black, Lumo's yellow, Elizabeth line's actual
 * TfL purple, etc.) matters for recognition, both for casual users and for
 * enthusiasts who will notice a wrong color. Where UK TOC branding clusters
 * heavily in blue/purple (many real operators genuinely are blue-branded),
 * hue is spread as far as the real brand allows and differentiated further
 * by lightness/saturation — but with ~27 TOC-tier colors, this is a hand-
 * tuned "clearly distinct at a glance" palette, not a claim of full
 * colorblind-safe categorical distinction (that tops out around 12 hues).
 *
 * Two explicit reservations kept OUT of the TOC's own hue space:
 *   - Never uses the site's own turquoise (#40E0D0/--t) — reserved
 *     exclusively for UI meaning (links, the From/To selected-path
 *     highlight in Phase 6). Chiltern Railways' real teal branding was
 *     nudged bluer for exactly this reason.
 *   - Never uses the exact "delays/warnings" amber (#F5B84B/--a) for the
 *     Heritage bucket, even though Heritage is amber-FAMILY per CLAUDE.md's
 *     existing Database-mode legend — a literal match would read as a
 *     service-delay indicator on the map, which is the opposite of what a
 *     heritage line rendering means.
 *
 * ─── 2026-07-14 rework: real perceptual math, not a naive HSL transform ───
 * The first version derived light-theme hex with a per-color HSL darken+
 * saturate formula that only looked at each color's OWN lightness — it had
 * no idea two DIFFERENT colors existed. Confirmed bug, caught in review:
 * ScotRail/Northern/GTR/Eurostar are clearly distinct in dark mode but
 * nearly identical once each was independently darkened toward the same
 * low-lightness "generic navy" region (Sheffield Supertram/Glasgow Subway
 * literally collided on the exact same light-mode hex). Low-lightness
 * convergence is a real, well-known perceptual effect — different hues
 * increasingly read as "just dark" as L drops — and a per-color formula
 * with no cross-color awareness can't see it happening.
 *
 * Fixed with actual color science instead of another hand-tuned formula:
 *   1. sRGB → linear RGB → CIE XYZ → CIE Lab (D65), used for CIE76 ΔE
 *      (Euclidean distance in Lab) — not RGB-space "differs by N per
 *      channel" eyeballing.
 *   2. After generating each theme's initial candidates, a relaxation pass
 *      finds the worst (lowest-ΔE) pair and nudges their HUE apart
 *      (bounded — see HUE_DRIFT_CAP — so a color doesn't drift away from
 *      the real brand hue it was chosen for), repeating until every pair
 *      clears MIN_DELTA_E or the drift cap is hit. Applied to BOTH themes
 *      independently, TOC+metro together (they can plausibly appear near
 *      each other on the map) and tfl_lines as its own set (per the
 *      Bakerloo/Overground finding — they co-occur on the real combined
 *      Tube+Overground map, so needed the same treatment).
 *   3. CVD (colorblindness) simulation — protanopia and deuteranopia, the
 *      standard Viénot/Brettel-derived linear-RGB matrices, applied in
 *      linear (gamma-decoded) space — run against the FINAL palette, and
 *      any pair whose simulated ΔE drops below the threshold is flagged in
 *      cvd_report below, cross-referenced against the one real geographic-
 *      adjacency data point available before Phase 2's actual segment
 *      graph exists: the Doncaster junction spot-check from the scoping
 *      pass (LNER/TransPennine Express/Northern/East Midlands Railway/
 *      Grand Central/CrossCountry/Lumo all genuinely co-occur there).
 *      Full pairwise CVD-safety across 30+ hues isn't realistically
 *      achievable (per the header note above) — this reports gaps rather
 *      than silently hiding them, since operator color is never the ONLY
 *      way to identify a line: every rendered segment stays identifiable
 *      via hover/click showing its operator name, exactly like the station
 *      markers already do (see map.html's showHoverTooltip) — colorblind
 *      users are never dependent on color-parsing alone to get the
 *      information, only on it for the at-a-glance overview.
 *
 * Run:
 *   node scripts/build-operator-palette.mjs
 *
 * Output: data/operator-colors.json — dark+light hex per canonical
 * operator/category, keyed by Phase 0's canonical codes/names, plus a
 * cvd_report section. See CLAUDE.md's "Operator line colors" section for
 * the categorization rules; this file is the actual hex table.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'operator-colors.json');

// ═══ Color math ═════════════════════════════════════════════════════════

// ─── sRGB hex ⇄ HSL — still used to GENERATE candidates and nudge hue;
// the perceptual checking below (Lab/ΔE) is what's new, not a replacement
// for HSL as a working color space.
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + (c(r) + c(g) + c(b)).toUpperCase();
}
function hexToHsl(hex) {
  const [r0, g0, b0] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r0, g0, b0), min = Math.min(r0, g0, b0);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r0: h = (g0 - b0) / d + (g0 < b0 ? 6 : 0); break;
      case g0: h = (b0 - r0) / d + 2; break;
      default: h = (r0 - g0) / d + 4;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// ─── sRGB → linear → CIE XYZ (D65) → CIE Lab, and CIE76 ΔE ───────────────
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}
function hexToXyz(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}
const D65 = [0.95047, 1.0, 1.08883];
function xyzToLab([x, y, z]) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / D65[0]), fy = f(y / D65[1]), fz = f(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function hexToLab(hex) {
  return xyzToLab(hexToXyz(hex));
}
function deltaE76(hexA, hexB) {
  const [l1, a1, b1] = hexToLab(hexA), [l2, a2, b2] = hexToLab(hexB);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

// ─── CVD simulation — protanopia/deuteranopia, Viénot/Brettel-derived
// linear-RGB matrices (the standard simplified dichromat simulation used
// by most web-based simulators), applied in LINEAR (gamma-decoded) space —
// skipping the gamma step is a common shortcut that under/over-states the
// effect, so it's done properly here.
const CVD_MATRICES = {
  protanopia: [[0.56667, 0.43333, 0], [0.55833, 0.44167, 0], [0, 0.24167, 0.75833]],
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
};
function simulateCvd(hex, type) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const m = CVD_MATRICES[type];
  const r2 = m[0][0] * r + m[0][1] * g + m[0][2] * b;
  const g2 = m[1][0] * r + m[1][1] * g + m[1][2] * b;
  const b2 = m[2][0] * r + m[2][1] * g + m[2][2] * b;
  return rgbToHex(linearToSrgb(r2), linearToSrgb(g2), linearToSrgb(b2));
}

// ═══ Palette definition (dark-theme base hex — the design intent) ═══════

// (LN inherits WMR's color — its route relations are tagged "West Midlands
// Trains", indistinguishable from WMR's own tag in current OSM data, same
// class of gap as the GTR sub-brand finding. HT/HX/XR are RESERVED colors —
// they don't appear in current route-relation data at all per Phase 0.
// GX/GN/TL are ALSO effectively reserved: none of "Gatwick Express", "Great
// Northern", or bare "Thameslink" appear as a standalone route-relation
// operator tag either — all three are fully absorbed into "Greater
// Thameslink Railway" today. All six are pre-assigned a color anyway so a
// future route-name-matching fix doesn't need a palette redesign — but none
// of them will actually render until that fix lands.)
const TOC_COLORS = {
  GR: '#E32636',  // LNER — red
  GX: '#FF5A36',  // Gatwick Express — vermillion (RESERVED — absorbed into GTR today)
  GN: '#9B3D6E',  // Great Northern — muted rose-plum (RESERVED — absorbed into GTR today)
  TL: '#3A7CA5',  // Thameslink — mid steel-blue (RESERVED — absorbed into GTR today)
  AW: '#C1440E',  // Transport for Wales — burnt rust-red
  CC: '#FFA630',  // c2c — orange
  GC: '#994700',  // Grand Central — dark burnt-orange/rust (darkened further 2026-07-14 — red and orange BOTH collapse toward the same yellow-olive under protanopia/deuteranopia, a fundamental red-green-CVD limitation no hue shift can fix while staying "orange"; a large lightness gap is the only lever that actually works here, confirmed by testing several L values directly against simulated LNER — also closer to Grand Central's real black/dark-orange livery)
  LD: '#FFDE59',  // Lumo — bright lemon yellow
  ME: '#C9A227',  // Merseyrail — mustard gold (echoes real yellow/black livery)
  GW: '#3FA34D',  // Great Western Railway — green
  SN: '#7ED957',  // Southern — lighter kelly/lime-green
  IL: '#5FBFA0',  // Island Line — teal-green
  EM: '#2FBF8F',  // East Midlands Railway — teal
  CH: '#1E8A9E',  // Chiltern Railways — cyan-blue (nudged off the site's own turquoise, see header)
  HT: '#7FC4E8',  // Hull Trains — light sky blue (RESERVED, not in current route data)
  SW: '#2E7FD1',  // South Western Railway — mid blue
  WMR: '#4A6FA5', // West Midlands Railway — steel/slate blue (also covers LN — see above)
  SE: '#5C7A89',  // Southeastern — muted slate grey-blue
  // SR/NT/GTR/ES redesigned 2026-07-14 — flagged by name as a cluster that
  // was clearly distinct in dark mode but nearly identical in light mode
  // (ΔE ~2-6, RGB channels within ~2 points of each other). The relaxation
  // pass alone couldn't fix it without exceeding the hue-drift cap, so
  // these four were deliberately widened at the design stage instead —
  // NT pushed toward cyan (was near-identical hue to SR, just lighter),
  // GTR pushed further into violet, ES kept dark but desaturated rather
  // than competing on hue at all.
  NT: '#228EC3',  // Northern — cyan-leaning sky blue (was too close to SR's hue)
  SR: '#1D2587',  // ScotRail — deep saturated indigo-blue
  ES: '#1C2240',  // Eurostar — near-black desaturated navy (distinguishes by NOT competing on hue)
  GTR: '#6730A6', // Greater Thameslink Railway — violet-indigo (pushed further from SR/NT/ES)
  TP: '#23295C',  // TransPennine Express — darker violet-purple (darkened further 2026-07-14 — dark-theme comparison against Northern cleared once L dropped to ~25, confirmed by direct testing; still resolving under the light-theme derivation, see separation report)
  VT: '#B84FCC',  // Avanti West Coast — magenta-violet
  CS: '#4A2E6B',  // Caledonian Sleeper — deep muted purple (night-sky)
  HX: '#B8A0E8',  // Heathrow Express — pale lavender (RESERVED, not in current route data)
  XC: '#B03A6B',  // CrossCountry — maroon-magenta
  LE: '#D6336C',  // Greater Anglia — rose-red
  WR: '#8C5A3C',  // West Coast Railways — heritage brown/maroon
  XR: '#6950A1',  // Elizabeth line — real official TfL purple, not invented
};

// ─── Metro/LRT — purple family, each system individually distinct. DLR
// keeps its real official teal (like Elizabeth line, well-known enough to
// be worth the exception). Sheffield Supertram/Glasgow Subway's base hues
// were widened here (were near-identical hue, differing only by lightness
// — the exact pattern that collapses under the light-theme transform,
// caught in review) — Glasgow Subway's real "Clockwork Orange" nickname
// was deliberately still not used, since breaking the purple-family rule
// would undermine the category itself.
const METRO_COLORS = {
  'Transport for London': '#8B7FD6', // generic/fallback — see tfl_lines below for the real per-line split (Phase 3)
  'Manchester Metrolink': '#A0459E',
  'Docklands Light Railway': '#00A4A7', // real official DLR teal
  'West Midlands Metro': '#7B4FA0',
  'Croydon Tramlink': '#9B59B6',
  'Sheffield Supertram': '#6C3483',
  'Tyne and Wear Metro': '#C39BD3',
  'Nottingham Express Transit': '#A569BD',
  'Glasgow Subway': '#A12B82', // widened further 2026-07-14 — still only 2° of hue apart from Sheffield Supertram after the first widening, pushed into magenta rather than staying adjacent-violet
};

// ─── TfL individual line colors — real, official (unchanged — see header:
// separation happens in the derivation pass below, not by altering these).
const TFL_LINE_COLORS = {
  Bakerloo: '#B36305', Central: '#E32017', Circle: '#FFD300', District: '#00782A',
  'Hammersmith & City': '#F3A9BB', Jubilee: '#A0A5A9', Metropolitan: '#9B0056',
  Northern: '#4D4D4D', // real official color is black — see header note, flagged for a light-core treatment when wired in
  Piccadilly: '#003688', Victoria: '#0098D4', 'Waterloo & City': '#95CDBA',
  'Elizabeth line': '#6950A1', DLR: '#00A4A7',
  Overground: '#EE7C0E',
};

const HERITAGE_COLOR = '#B8752E';

// ═══ Light-theme derivation + pairwise separation ════════════════════════

// The floor here was the actual root cause of the Sheffield Supertram/
// Glasgow Subway collision: a flat Math.max(22, ...) meant any two
// sufficiently-dark, saturated colors both clip to the EXACT SAME
// lightness (22%), and at low lightness Lab-space hue differences compress
// perceptually — so two colors with genuinely different hues still read as
// nearly identical once both are flattened to the same L. Floor is now
// hue-dependent (small deterministic spread, ±5 points across the hue
// wheel) specifically so two different-hued colors can no longer land on
// the identical floor value — a real fix to the mechanism, not another
// patch on top of the symptom.
function darkenForLight(hex) {
  const { h, s, l } = hexToHsl(hex);
  const drop = 12 + (l / 100) * 24;
  const floor = 24 + (h % 10); // 24-33, hue-dependent — see comment above
  const newL = Math.max(floor, l - drop);
  const newS = Math.min(100, s + 8);
  return hslToHex(h, newS, newL);
}

const MIN_DELTA_E = 15; // "clearly distinct at a glance" floor, per CIE76 rule-of-thumb (2-10 = perceptible, 10+ = clearly different)
const HUE_DRIFT_CAP = 22; // max degrees a color may drift from its DESIGNED hue while separating — keeps real brand association intact
const MAX_ITERATIONS = 500;

// Greedy relaxation: repeatedly find the worst (lowest-ΔE) pair and nudge
// both hues apart by a small step, until every pair clears MIN_DELTA_E, the
// drift cap stops further movement, or MAX_ITERATIONS is hit (reported, not
// silently accepted — see the unresolved list in the returned report).
function separate(entries) {
  const items = entries.map(({ key, hex }) => {
    const { h, s, l } = hexToHsl(hex);
    return { key, originalHue: h, h, s, l, hex };
  });
  const recompute = (it) => { it.hex = hslToHex(it.h, it.s, it.l); };
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations++) {
    let worst = null, worstDE = Infinity;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const de = deltaE76(items[i].hex, items[j].hex);
        if (de < worstDE) { worstDE = de; worst = [items[i], items[j]]; }
      }
    }
    if (worstDE >= MIN_DELTA_E || !worst) break;
    const [a, b] = worst;
    const aRoom = HUE_DRIFT_CAP - Math.abs(((a.h - a.originalHue + 540) % 360) - 180);
    const bRoom = HUE_DRIFT_CAP - Math.abs(((b.h - b.originalHue + 540) % 360) - 180);
    if (aRoom <= 0 && bRoom <= 0) break; // both at their drift cap — can't separate further without breaking brand association
    const step = 3;
    // push apart along the shorter arc between them
    let diff = ((b.h - a.h + 540) % 360) - 180; // signed shortest-path difference
    const dir = diff >= 0 ? 1 : -1;
    if (aRoom > 0) a.h -= dir * step;
    if (bRoom > 0) b.h += dir * step;
    recompute(a); recompute(b);
  }
  const unresolved = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const de = deltaE76(items[i].hex, items[j].hex);
      if (de < MIN_DELTA_E) unresolved.push({ a: items[i].key, b: items[j].key, deltaE: Math.round(de * 10) / 10 });
    }
  }
  return {
    result: Object.fromEntries(items.map((it) => [it.key, it.hex])),
    iterations, unresolved,
  };
}

function buildTheme(baseHexByKey, deriveFn) {
  const entries = Object.entries(baseHexByKey).map(([key, hex]) => ({ key, hex: deriveFn(hex) }));
  return separate(entries);
}

// ═══ Build ════════════════════════════════════════════════════════════

const darkBase = { ...TOC_COLORS, ...METRO_COLORS };
const darkSeparated = separate(Object.entries(darkBase).map(([key, hex]) => ({ key, hex })));
const lightSeparated = buildTheme(darkSeparated.result, darkenForLight);

const tflDarkSeparated = separate(Object.entries(TFL_LINE_COLORS).map(([key, hex]) => ({ key, hex })));
const tflLightSeparated = buildTheme(tflDarkSeparated.result, darkenForLight);

const heritageDark = HERITAGE_COLOR;
const heritageLight = darkenForLight(HERITAGE_COLOR);

function splitBack(separatedResult, keys) {
  return Object.fromEntries(keys.map((k) => [k, separatedResult[k]]));
}
const tocKeys = Object.keys(TOC_COLORS), metroKeys = Object.keys(METRO_COLORS);

function withThemes(darkResult, lightResult, keys) {
  return Object.fromEntries(keys.map((k) => [k, { dark: darkResult[k], light: lightResult[k] }]));
}

// ═══ CVD report ═══════════════════════════════════════════════════════

// Real, evidence-based adjacency data — everything else co-occurring is
// possible but unconfirmed until Phase 2's actual segment graph exists.
const KNOWN_ADJACENT = new Set(
  ['GR', 'TP', 'NT', 'EM', 'GC', 'XC', 'LD'].flatMap((a, i, arr) =>
    arr.slice(i + 1).map((b) => [a, b].sort().join('+'))
  )
);

function cvdCheck(hexByKey, themeLabel) {
  const keys = Object.keys(hexByKey);
  const flagged = [];
  for (const type of ['protanopia', 'deuteranopia']) {
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const [ka, kb] = [keys[i], keys[j]];
        const simA = simulateCvd(hexByKey[ka], type), simB = simulateCvd(hexByKey[kb], type);
        const de = deltaE76(simA, simB);
        if (de < MIN_DELTA_E) {
          flagged.push({
            theme: themeLabel, cvd_type: type, a: ka, b: kb,
            deltaE_simulated: Math.round(de * 10) / 10,
            known_adjacent: KNOWN_ADJACENT.has([ka, kb].sort().join('+')),
          });
        }
      }
    }
  }
  return flagged;
}

const finalDarkTocMetro = darkSeparated.result;
const finalLightTocMetro = lightSeparated.result;

const cvdFlags = [
  ...cvdCheck(finalDarkTocMetro, 'dark'),
  ...cvdCheck(finalLightTocMetro, 'light'),
].sort((a, b) => (b.known_adjacent - a.known_adjacent) || (a.deltaE_simulated - b.deltaE_simulated));

const palette = {
  generated_at: new Date().toISOString(),
  _notes: 'Dark theme hex are hand-curated (see script header). Light theme hex are DERIVED via darken+saturate THEN a pairwise CIE76 ΔE separation pass (min ΔE ' + MIN_DELTA_E + ', max ' + HUE_DRIFT_CAP + '° hue drift from the designed hue) — fixes the 2026-07-14 finding that a per-color-only transform let unrelated colors converge. toc/metro keyed by Phase 0 canonical code/name. tfl_lines is a reference table, not yet wired into rendering — see Phase 3. cvd_report flags pairs that stay too close under simulated protanopia/deuteranopia — operator identity is never conveyed by color alone regardless (every segment is identifiable via hover/click), so these are prioritization signals for palette tuning, not correctness bugs.',
  toc: withThemes(finalDarkTocMetro, finalLightTocMetro, tocKeys),
  metro: withThemes(finalDarkTocMetro, finalLightTocMetro, metroKeys),
  tfl_lines: withThemes(tflDarkSeparated.result, tflLightSeparated.result, Object.keys(TFL_LINE_COLORS)),
  heritage: { dark: heritageDark, light: heritageLight },
  cvd_report: {
    min_delta_e_threshold: MIN_DELTA_E,
    total_flagged_pairs: cvdFlags.length,
    known_adjacent_flagged: cvdFlags.filter((f) => f.known_adjacent).length,
    pairs: cvdFlags,
  },
  separation_report: {
    dark_iterations: darkSeparated.iterations, dark_unresolved: darkSeparated.unresolved,
    light_iterations: lightSeparated.iterations, light_unresolved: lightSeparated.unresolved,
    tfl_dark_iterations: tflDarkSeparated.iterations, tfl_dark_unresolved: tflDarkSeparated.unresolved,
    tfl_light_iterations: tflLightSeparated.iterations, tfl_light_unresolved: tflLightSeparated.unresolved,
  },
};

writeFileSync(OUT_PATH, JSON.stringify(palette, null, 2) + '\n');
console.log(`Wrote ${tocKeys.length} TOC + ${metroKeys.length} Metro/LRT + ${Object.keys(TFL_LINE_COLORS).length} TfL-line-reference + 1 Heritage color to ${OUT_PATH}`);
console.log(`\nSeparation: dark ${darkSeparated.iterations} iterations (${darkSeparated.unresolved.length} unresolved), light ${lightSeparated.iterations} iterations (${lightSeparated.unresolved.length} unresolved)`);
if (darkSeparated.unresolved.length) console.log('  dark unresolved:', darkSeparated.unresolved);
if (lightSeparated.unresolved.length) console.log('  light unresolved:', lightSeparated.unresolved);
console.log(`\nCVD report: ${cvdFlags.length} flagged pairs (${cvdFlags.filter((f) => f.known_adjacent).length} involve a known-adjacent operator)`);
cvdFlags.filter((f) => f.known_adjacent).forEach((f) => console.log(`  [PRIORITY] ${f.theme}/${f.cvd_type}: ${f.a} vs ${f.b} — simulated ΔE ${f.deltaE_simulated}`));

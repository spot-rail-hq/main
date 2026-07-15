#!/usr/bin/env node
/**
 * scripts/build-operator-palette.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Phase 1 of the operator-colored rail line project (see the approved plan
 * and Phase 0's scripts/output/operator-inventory.json for the canonical
 * operator list this palette covers).
 *
 * ─── 2026-07-14, superseding rework: real corporate colors first ─────────
 * Earlier rounds this session generated the TOC palette algorithmically
 * (hand-picked "brand-inspired" hues, then Delta-E/CVD-separated). This
 * version replaces that: every TOC-tier operator's REAL_TOC_COLORS entry
 * below is researched (source cited per entry — Wikipedia's WikiProject UK
 * Railways colours list, Wikipedia route-diagram color templates, Brandfetch
 * live-site extraction, or a corroborated livery/rebrand description),
 * not invented. Priority order, per instruction:
 *   1. Distinguishability is non-negotiable — no two operators end up too
 *      close, especially ones that share track or appear near each other
 *      (KNOWN_ADJACENT below, from the Doncaster junction spot-check).
 *   2. Within that constraint, match real corporate colors as closely as
 *      possible.
 * Mechanically: operators are assigned in order of network coverage
 * (Phase 0's relation counts — bigger/more-visible operators get first
 * claim on their real color), each trying real PRIMARY color first, then
 * real SECONDARY/alternate shade if primary collides, then an algorithmic
 * hue-nudge fallback (flagged explicitly) only if neither real option
 * clears separation. "Collides" means: ΔE76 < 15 against ANY already-
 * placed color (the non-negotiable base rule), OR — for KNOWN_ADJACENT
 * pairs specifically — CVD-simulated ΔE76 < 15 under protanopia or
 * deuteranopia (extra certainty for operators that actually run near each
 * other; full CVD-safety across 30 real corporate hues isn't realistically
 * achievable, so non-adjacent CVD closeness is reported, not blocking).
 *
 * Two research gaps found no confident source despite extensive searching
 * (Wikipedia infobox/templates, Brandfetch, press/rebrand coverage,
 * official sites): Great Northern (GN) and bare Thameslink (TL — "navy
 * blue with a yellow stripe" is the only description found, no hex). Both
 * get a placeholder via the algorithmic fallback with confidence:'none' —
 * flagged in the report, not presented as researched.
 *
 * Dark/light theme direction is now consistent across the ENTIRE TOC/metro
 * palette, matching how tfl_lines already worked: the real (or best-
 * available) color anchors LIGHT theme (real liveries/logos/websites are
 * designed for pale/white backgrounds), and dark-theme is DERIVED by
 * lifting lightness for legibility against this map's dark basemap while
 * preserving true hue — not a separate hand-picked dark color.
 *
 * Metro/LRT and Heritage are OUT OF SCOPE for the corporate-color research
 * (the ask was specifically the ~30 TOC-tier operators) — they keep their
 * existing hand-picked designs, run through the same gate-check/fallback
 * mechanism against the new TOC placements so nothing newly collides.
 *
 * Two explicit reservations kept OUT of every operator's hue space:
 *   - Never uses the site's own turquoise (#40E0D0/--t) — reserved
 *     exclusively for UI meaning (links, the From/To selected-path
 *     highlight in Phase 6).
 *   - Never uses the exact "delays/warnings" amber (#F5B84B/--a) for the
 *     Heritage bucket — would read as a service-delay indicator.
 *
 * Run:
 *   node scripts/build-operator-palette.mjs
 *
 * Output: data/operator-colors.json — dark+light hex per canonical
 * operator/category, an assignment_report (method/source/confidence per
 * TOC operator), and a cvd_report. See CLAUDE.md's "Operator line colors"
 * section for the categorization rules; this file is the actual hex table.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'operator-colors.json');

// ═══ Color math ═════════════════════════════════════════════════════════
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

const MIN_DELTA_E = 15;

// ═══ Research table — REAL corporate colors, sourced ═════════════════════
// confidence: 'high' (multi-source or directly confirmed) / 'medium'
// (single reasonably-reliable source, not independently cross-verified) /
// 'low' (source exists but has real caveats) / 'none' (no confident source
// found — flagged for user input, NOT presented as researched).
const REAL_TOC_COLORS = {
  GR: { name: 'LNER', primary: '#CE0E2D', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'high' },
  GX: { name: 'Gatwick Express', primary: '#C8102E', primarySource: 'Brandfetch (gatwickexpress.com) — "Crimson"', secondary: '#E48897', secondarySource: 'Brandfetch (gatwickexpress.com) — "Deep Blush"', confidence: 'high' },
  GN: { name: 'Great Northern', primary: null, fallbackHint: '#6B3FA0', confidence: 'none', caveat: 'No confident exact hex found across Wikipedia infobox/templates (Template:GNR_colour is the HISTORIC 19th-century Great Northern Railway, a different entity, #00A550 green — not used), Brandfetch (no match for the correct domain), or press coverage. Historical sources and the 2020 GTR sub-brand rebrand consistently associate Great Northern with PURPLE though, so the placeholder below is anchored to that family (not a neutral grey) — still unconfirmed exact hex, still flagged for your input.' },
  TL: { name: 'Thameslink', primary: '#FF5AA4', primarySource: "Wikipedia Template:TL_color raw wikitext (action=raw) — {{#switch}} default case FF5AA4, described as encoding \"the colour of Greater Thameslink Railway Thameslink lines\"; cross-corroborated exactly by the separate WikiProject UK Railways colours list's \"Govia Thameslink Railway\" entry (also ff5aa4) found earlier — two independent Wikipedia sources agreeing", confidence: 'high' },
  AW: { name: 'Transport for Wales', primary: '#FF0000', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  CC: { name: 'c2c', primary: '#B7007C', primarySource: 'Wikipedia WikiProject UK Railways colours list, corroborated by c2c\'s own official site (UI element literally named "home-swap-magenta")', confidence: 'high' },
  GC: { name: 'Grand Central', primary: '#1D1D1B', primarySource: 'Wikipedia Template:GrandCentral_colour, corroborated by UK Transport Wiki (#2C3838, same near-black family) and the "all-black livery" description', confidence: 'high' },
  LD: { name: 'Lumo', primary: '#2B6EF5', primarySource: 'Wikipedia WikiProject UK Railways colours list, corroborated by search results describing "Lumo\'s signature blue"', confidence: 'high' },
  GW: { name: 'Great Western Railway', primary: '#0A493E', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  SN: { name: 'Southern', primary: '#8CC63E', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  IL: { name: 'Island Line', primary: '#1E90FF', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  EM: { name: 'East Midlands Railway', primary: '#713563', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  CH: { name: 'Chiltern Railways', primary: '#00BFFF', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  HT: { name: 'Hull Trains', primary: '#DE005C', primarySource: 'Wikipedia Template:HT_color', confidence: 'high' },
  SW: { name: 'South Western Railway', primary: '#24398C', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  WMR: { name: 'West Midlands Railway', primary: '#FF8300', primarySource: 'Wikipedia WikiProject UK Railways colours list, corroborated by search ("orange and purple colour scheme", Birmingham landmarks lit orange for WMR branding)', confidence: 'high' },
  SE: { name: 'Southeastern', primary: '#389CFF', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  NT: { name: 'Northern', primary: '#0F0D78', primarySource: 'Wikipedia WikiProject UK Railways colours list, roughly corroborated by Brandfetch (northernrail.co.uk: "Port Gore" #262262, same dark-indigo family)', confidence: 'medium' },
  SR: { name: 'ScotRail', primary: '#1E467D', primarySource: 'Wikipedia WikiProject UK Railways colours list (Abellio-era)', confidence: 'medium', caveat: 'ScotRail was renationalised 1 April 2022 with a new livery described as "dark blue, grey doors, white Saltire" — same blue FAMILY as this Abellio-era value but the current exact hex was not independently confirmed.' },
  GTR: { name: 'Greater Thameslink Railway', primary: '#00A6E2', primarySource: 'Brandfetch (gtrailway.com) — "Cerulean"', secondary: '#BACFE2', secondarySource: 'Brandfetch (gtrailway.com) — "Periwinkle Gray"', confidence: 'medium', caveat: 'Reflects the confirmed 2020 "VCCP Blue" rebrand of Govia Thameslink Railway; whether the entity\'s 31 May 2026 renationalisation to Greater Thameslink Railway changed branding further was not confirmed.' },
  TP: { name: 'TransPennine Express', primary: '#09A4EC', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  VT: { name: 'Avanti West Coast', primary: '#004354', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  ME: { name: 'Merseyrail', primary: '#FFCE0F', primarySource: 'Brandfetch (merseyrail.org) — "Candlelight", corroborated by Wikipedia\'s "yellow letter M on a grey circle" logo description', secondary: '#313131', secondarySource: 'Brandfetch (merseyrail.org) — "Mine Shaft"', confidence: 'high' },
  CS: { name: 'Caledonian Sleeper', primary: '#1D2E35', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  HX: { name: 'Heathrow Express', primary: '#532E63', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  XR: { name: 'Elizabeth line', primary: '#6950A1', primarySource: 'Official TfL branding — already established this session, one of the world\'s most recognized transit colors', confidence: 'high' },
  XC: { name: 'CrossCountry', primary: '#660F21', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  LE: { name: 'Greater Anglia', primary: '#D70428', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
  WR: { name: 'West Coast Railways', primary: '#800000', primarySource: 'Livery description ("Royal Scotsman Claret" maroon) — standard "maroon" web hex used as the closest match; exact BS381 paint number not found', secondary: '#A11055', secondarySource: 'Brandfetch (westcoastrailways.co.uk) — "Jazzberry Jam"; this is the MARKETING WEBSITE\'s UI color, not confirmed to represent the actual train livery, so treated as lower-confidence than primary despite coming from a live-site source', confidence: 'low' },
  ES: { name: 'Eurostar', primary: '#0C326F', primarySource: 'Best-available anchor within the confirmed 2023 DesignStudio rebrand direction ("punchy blue and deep navy") — exact hex for the "punchy blue" was not found; Brandfetch returned an inconsistent mixed set including pink tones that contradict the confirmed rebrand story and were excluded as unreliable', confidence: 'low' },
  LN: { name: 'London Northwestern Railway', primary: '#00BF6F', primarySource: 'Wikipedia WikiProject UK Railways colours list', confidence: 'medium' },
};

// Phase 0 relation counts (scripts/output/operator-inventory.json) — bigger/
// more-visible operators get first claim on their real color. GN/TL show 0
// since neither appears as a standalone route-relation tag today (both
// absorbed into GTR) — placed last, which is fine since they have no real
// color to "claim" anyway.
const RELATION_COUNTS = {
  GTR: 111, ES: 16, GW: 70, LE: 31, AW: 60, XC: 15, CH: 22, IL: 6, WMR: 50,
  SW: 59, SN: 13, NT: 98, GR: 22, TP: 21, ME: 10, VT: 20, SR: 146, EM: 21,
  SE: 47, CS: 10, WR: 2, LD: 35, GC: 2, CC: 8, GX: 0, GN: 0, TL: 0, HT: 0, HX: 0, XR: 0,
};

// Real, evidence-based adjacency (Doncaster junction spot-check, scoping
// pass) — gets the STRICT gate (ΔE76 AND CVD-simulated ΔE76 both required).
// Everything else only needs the base ΔE76 gate; CVD is still checked and
// reported for all pairs, just not blocking for non-adjacent ones.
const KNOWN_ADJACENT = new Set(
  ['GR', 'TP', 'NT', 'EM', 'GC', 'XC', 'LD'].flatMap((a, i, arr) =>
    arr.slice(i + 1).map((b) => [a, b].sort().join('+'))
  )
);

function passesGates(candidateHex, key, placed) {
  for (const [otherKey, otherHex] of Object.entries(placed)) {
    const de = deltaE76(candidateHex, otherHex);
    if (de < MIN_DELTA_E) return { ok: false, reason: `ΔE76 ${de.toFixed(1)} vs ${otherKey}` };
    if (KNOWN_ADJACENT.has([key, otherKey].sort().join('+'))) {
      for (const type of ['protanopia', 'deuteranopia']) {
        const cvdDe = deltaE76(simulateCvd(candidateHex, type), simulateCvd(otherHex, type));
        if (cvdDe < MIN_DELTA_E) return { ok: false, reason: `CVD(${type}) ΔE76 ${cvdDe.toFixed(1)} vs known-adjacent ${otherKey}` };
      }
    }
  }
  return { ok: true };
}

// Fallback: search outward in hue from a base color (secondary if it
// exists, else primary, else a neutral placeholder for GN/TL) until a
// candidate clears passesGates. No brand to protect here — this only runs
// when both real options failed (or didn't exist), so the priority is
// finding ANY working color, not staying close to a hue that already
// didn't work.
function findFallbackHue(baseHex, key, placed, maxDrift = 60) {
  const { h: baseHue, s, l } = hexToHsl(baseHex);
  for (let step = 0; step <= maxDrift; step += 2) {
    for (const dir of step === 0 ? [1] : [1, -1]) {
      const candidateHex = hslToHex(baseHue + dir * step, Math.max(s, 55), l);
      if (passesGates(candidateHex, key, placed).ok) return { hex: candidateHex, drift: dir * step };
    }
  }
  return { hex: baseHex, drift: null }; // exhausted search — extremely unlikely across 30 colors / 360°
}

// ═══ Sequential real-color-first assignment (TOC) ════════════════════════

const tocOrder = Object.keys(REAL_TOC_COLORS).sort((a, b) => (RELATION_COUNTS[b] || 0) - (RELATION_COUNTS[a] || 0));
const placedLight = {};
const assignmentReport = [];

for (const key of tocOrder) {
  const entry = REAL_TOC_COLORS[key];
  let chosen = null, method = null, notes = [];

  if (entry.primary) {
    const gate = passesGates(entry.primary, key, placedLight);
    if (gate.ok) { chosen = entry.primary; method = 'primary'; }
    else notes.push(`primary rejected (${gate.reason})`);
  }
  if (!chosen && entry.secondary) {
    const gate = passesGates(entry.secondary, key, placedLight);
    if (gate.ok) { chosen = entry.secondary; method = 'secondary'; }
    else notes.push(`secondary rejected (${gate.reason})`);
  }
  if (!chosen) {
    // fallbackHint lets a no-research entry anchor its placeholder to a
    // known color FAMILY (e.g. GN/Great Northern → purple, per historical
    // sources and the 2020 GTR sub-brand rebrand) instead of a neutral
    // grey — still an unconfirmed placeholder, just not off-brand.
    const base = entry.secondary || entry.primary || entry.fallbackHint || '#8A8A8A';
    const fallback = findFallbackHue(base, key, placedLight);
    chosen = fallback.hex;
    method = entry.primary ? 'algorithmic_fallback' : 'algorithmic_fallback_no_research';
    const baseLabel = entry.secondary ? 'secondary' : (entry.primary ? 'primary' : (entry.fallbackHint ? 'family-hint placeholder (no research available)' : 'neutral placeholder (no research available)'));
    notes.push(`hue-drifted ${fallback.drift}° from ${baseLabel}`);
  }

  placedLight[key] = chosen;
  assignmentReport.push({
    code: key, name: entry.name, confidence: entry.confidence,
    primary: entry.primary || null, primarySource: entry.primarySource || null,
    secondary: entry.secondary || null, secondarySource: entry.secondarySource || null,
    caveat: entry.caveat || null,
    method, chosen, notes: notes.join('; ') || null,
  });
}

// ─── Metro/LRT — out of scope for corporate research, keeps its existing
// hand-picked design intent, but still gate-checked/nudged against the new
// TOC placements (and each other) so nothing newly collides.
const METRO_BASE = {
  'Transport for London': '#8B7FD6',
  'Manchester Metrolink': '#A0459E',
  'Docklands Light Railway': '#00A4A7',
  'West Midlands Metro': '#7B4FA0',
  'Croydon Tramlink': '#9B59B6',
  'Sheffield Supertram': '#6C3483',
  'Tyne and Wear Metro': '#C39BD3',
  'Nottingham Express Transit': '#A569BD',
  'Glasgow Subway': '#A12B82',
  // Blackpool Tramway — real modern livery (since the 2012 Flexity 2
  // fleet) genuinely is purple, confirmed via Wikipedia + independent web
  // search, but no confident EXACT hex found despite checking Wikipedia,
  // Brandfetch (blocked, 403), and Blackpool Transport's own live site/CSS
  // (no purple in their :root brand variables at all — website branding
  // and vehicle livery are evidently maintained separately). This value is
  // a placeholder anchored to the real family, not a guessed exact hex —
  // same treatment as Great Northern in the toc table.
  'Blackpool Tramway': '#991BA7',
  // Edinburgh Trams — a real hex WAS found (#B31B1B, "madder"/dark red,
  // sourced from Wikipedia's WikiProject UK Railways colours list, the
  // same source tier used successfully in Phase 1 — though tagged
  // "Temporary rail colour" there, a mild caveat). NOT used here: under
  // CVD simulation it collides with existing red-family TOCs (LNER-GR,
  // Greater Anglia-LE) at ΔE as low as ~4 — real risk of a metro system
  // reading as a TOC's line to a colorblind user, exactly what CLAUDE.md's
  // "metro = purple family, kept visually distinct from TOCs" rule exists
  // to prevent. Kept in the purple family instead, breaking from the real
  // livery — flagging this explicitly since every other color decision
  // this session prioritized real colors first; this is a deliberate,
  // evidence-based exception, not an oversight. Revisit if you'd rather
  // have livery authenticity over the categorical distinction.
  'Edinburgh Trams': '#E113EC',
};
function toVividLightTheme(hex) {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.min(100, Math.max(s, 72)), 38 + (l / 100) * 16);
}
for (const [key, baseHex] of Object.entries(METRO_BASE)) {
  const candidate = toVividLightTheme(baseHex);
  const gate = passesGates(candidate, key, placedLight);
  placedLight[key] = gate.ok ? candidate : findFallbackHue(candidate, key, placedLight).hex;
}

const HERITAGE_COLOR = '#B8752E';
const heritageLight = toVividLightTheme(HERITAGE_COLOR);

// ═══ Dark theme — derived from light (lift lightness, preserve hue) ══════
// Same direction as tfl_lines already used: the (real or best-available)
// color anchors LIGHT theme; dark is a lift for legibility against #07090C.
function toDarkThemeFromLight(hex) {
  const { h, s, l } = hexToHsl(hex);
  // TOC/metro light-theme values sit in a vivid mid-lightness band already
  // (~38-54), unlike tfl_lines' official colors which can be very dark
  // (Northern's true black) or very light (Circle's yellow) — so the lift
  // here is gentler, just enough to read clearly on the dark basemap.
  const lift = 6 + ((100 - l) / 100) * 14;
  const newL = Math.min(72, l + lift);
  return hslToHex(h, Math.min(100, s + 5), newL);
}
// Dark theme is DERIVED per-key from its own light-theme value, but that
// derivation was found to skip the known-adjacent CVD gate entirely (a
// real bug caught by the CVD report below flagging Lumo vs TransPennine
// Express in dark mode despite both having cleared light-theme assignment
// cleanly) — lifting lightness independently, with no cross-color
// awareness, can reintroduce exactly the kind of collision the light-theme
// gate was built to prevent. Fixed by running dark theme through the same
// incremental gate-check-and-nudge process, same priority order (bigger
// operators first), preferring to keep the direct lift (preserves the
// light-theme's real hue most faithfully) and only hue-drifting when a
// known-adjacent CVD collision actually appears in dark theme specifically.
const darkByKey = {};
for (const key of [...tocOrder, ...Object.keys(METRO_BASE)]) {
  const direct = toDarkThemeFromLight(placedLight[key]);
  const gate = passesGates(direct, key, darkByKey);
  darkByKey[key] = gate.ok ? direct : findFallbackHue(direct, key, darkByKey).hex;
}
const heritageDark = toDarkThemeFromLight(heritageLight);

// ═══ TfL individual line colors — unchanged from the prior round (already
// real-corporate-anchored, light=official/unmodified, dark=lift) ═════════
const TFL_LINE_COLORS = {
  Bakerloo: '#B36305', Central: '#E32017', Circle: '#FFD300', District: '#00782A',
  'Hammersmith & City': '#F3A9BB', Jubilee: '#A0A5A9', Metropolitan: '#9B0056',
  Northern: '#000000',
  Piccadilly: '#003688', Victoria: '#0098D4', 'Waterloo & City': '#95CDBA',
  'Elizabeth line': '#6950A1', DLR: '#00A4A7',
  Overground: '#EE7C0E',
  // 2026-07-15 (Phase 3 follow-up): the 6 real 2024-renamed London
  // Overground lines, previously missing — the generic 'Overground' entry
  // above is left in place (unused now that Phase 2/3's segment graph
  // splits every Overground relation to its real specific line, but
  // harmless to keep as a fallback).
  //
  // Two sources were checked, and they DISAGREED — worth recording why one
  // won. OSM's `colour` tag on the live route relations was internally
  // 100% consistent (every relation for a given line carries the same hex)
  // but gave Weaver = #9B0058, which is a near-exact duplicate of
  // Metropolitan's official #9B0056 (ΔE76 1.2 — i.e. visually identical)
  // AND doesn't match "maroon" (every independent verbal description of
  // Weaver's color) — #9B0058 reads as magenta/pink, not maroon. That
  // combination (accidentally matching a different Underground line almost
  // exactly, AND contradicting the line's own documented color family) is
  // a strong signal of an OSM tagging error, not a real TfL color choice.
  // Wikipedia's Module:Adjacent_stations/London_Overground — sourced from
  // "Pantone's own RGB values" per TfL's official standard, per its own
  // documentation — gives Weaver = #893B67, a genuine maroon, resolving
  // the collision. Used that source for all 6 instead (Liberty #606667,
  // Lioness #EF9600, Mildmay #2774AE, Suffragette #5BA763, Weaver #893B67,
  // Windrush #D22730) rather than mixing sources per-line.
  Liberty: '#606667', Lioness: '#EF9600', Mildmay: '#2774AE',
  Suffragette: '#5BA763', Weaver: '#893B67', Windrush: '#D22730',
};
function toDarkThemeFromOfficial(hex) {
  const { h, s, l } = hexToHsl(hex);
  const lift = 10 + ((100 - l) / 100) * 30;
  return hslToHex(h, Math.min(100, s + 5), Math.min(78, l + lift));
}
const tflDarkByKey = {};
for (const [key, hex] of Object.entries(TFL_LINE_COLORS)) tflDarkByKey[key] = toDarkThemeFromOfficial(hex);
const tflLightCloseCheck = [];
{
  const keys = Object.keys(TFL_LINE_COLORS);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const de = deltaE76(TFL_LINE_COLORS[keys[i]], TFL_LINE_COLORS[keys[j]]);
    if (de < MIN_DELTA_E) tflLightCloseCheck.push({ a: keys[i], b: keys[j], deltaE: Math.round(de * 10) / 10 });
  }
}

// 2026-07-15: the plain-ΔE check above (kept, unchanged) never ran a CVD
// simulation for tfl_lines at all — only the TOC/metro placement loop was
// CVD-gated. Per the explicit request accompanying the 6 new Overground
// colors, run the same protanopia/deuteranopia simulated-ΔE check used for
// TOC/metro against: each of the 6 new Overground lines vs. each of the 11
// existing Underground lines, and the 6 new lines against each other (81
// pairs total) — both light and dark theme.
const OVERGROUND_NEW = ['Liberty', 'Lioness', 'Mildmay', 'Suffragette', 'Weaver', 'Windrush'];
const UNDERGROUND_11 = ['Bakerloo', 'Central', 'Circle', 'District', 'Hammersmith & City', 'Jubilee', 'Metropolitan', 'Northern', 'Piccadilly', 'Victoria', 'Waterloo & City'];
function overgroundCvdCheck(hexByKey, themeLabel) {
  const flagged = [];
  const pairs = [];
  for (const a of OVERGROUND_NEW) for (const b of UNDERGROUND_11) pairs.push([a, b]);
  for (let i = 0; i < OVERGROUND_NEW.length; i++) for (let j = i + 1; j < OVERGROUND_NEW.length; j++) pairs.push([OVERGROUND_NEW[i], OVERGROUND_NEW[j]]);
  for (const [a, b] of pairs) {
    const plainDe = deltaE76(hexByKey[a], hexByKey[b]);
    if (plainDe < MIN_DELTA_E) flagged.push({ theme: themeLabel, cvd_type: 'none (plain ΔE76)', a, b, deltaE: Math.round(plainDe * 10) / 10 });
    for (const type of ['protanopia', 'deuteranopia']) {
      const de = deltaE76(simulateCvd(hexByKey[a], type), simulateCvd(hexByKey[b], type));
      if (de < MIN_DELTA_E) flagged.push({ theme: themeLabel, cvd_type: type, a, b, deltaE_simulated: Math.round(de * 10) / 10 });
    }
  }
  return flagged;
}
const overgroundCvdFlags = [...overgroundCvdCheck(TFL_LINE_COLORS, 'light'), ...overgroundCvdCheck(tflDarkByKey, 'dark')];

// ═══ CVD report (informational for non-adjacent pairs, was blocking for
// known-adjacent ones during assignment above) ════════════════════════════
function cvdCheck(hexByKey, themeLabel) {
  const keys = Object.keys(hexByKey);
  const flagged = [];
  for (const type of ['protanopia', 'deuteranopia']) {
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const [ka, kb] = [keys[i], keys[j]];
      const de = deltaE76(simulateCvd(hexByKey[ka], type), simulateCvd(hexByKey[kb], type));
      if (de < MIN_DELTA_E) {
        flagged.push({ theme: themeLabel, cvd_type: type, a: ka, b: kb, deltaE_simulated: Math.round(de * 10) / 10, known_adjacent: KNOWN_ADJACENT.has([ka, kb].sort().join('+')) });
      }
    }
  }
  return flagged;
}
const cvdFlags = [...cvdCheck(placedLight, 'light'), ...cvdCheck(darkByKey, 'dark')]
  .sort((a, b) => (b.known_adjacent - a.known_adjacent) || (a.deltaE_simulated - b.deltaE_simulated));

// ═══ Assemble output ══════════════════════════════════════════════════
const tocKeys = Object.keys(REAL_TOC_COLORS), metroKeys = Object.keys(METRO_BASE);
function withThemes(keys) {
  return Object.fromEntries(keys.map((k) => [k, { dark: darkByKey[k], light: placedLight[k] }]));
}

const palette = {
  generated_at: new Date().toISOString(),
  _notes: 'SUPERSEDES the earlier algorithmically-generated TOC palette. toc hex are now REAL corporate colors (see assignment_report for source/confidence per operator) — primary tried first, secondary/alternate brand shade if primary collides, algorithmic hue-nudge fallback (flagged) only if neither real option clears separation. Light theme is the anchor (real liveries/websites are designed for pale backgrounds); dark theme is derived by lifting lightness, preserving true hue. metro/heritage are out of scope for corporate research (not TOCs) and keep their prior hand-picked design, gate-checked against the new toc placements. tfl_lines unchanged from the prior round.',
  toc: withThemes(tocKeys),
  metro: withThemes(metroKeys),
  tfl_lines: Object.fromEntries(Object.keys(TFL_LINE_COLORS).map((k) => [k, { dark: tflDarkByKey[k], light: TFL_LINE_COLORS[k] }])),
  heritage: { dark: heritageDark, light: heritageLight },
  assignment_report: assignmentReport,
  cvd_report: {
    min_delta_e_threshold: MIN_DELTA_E,
    total_flagged_pairs: cvdFlags.length,
    known_adjacent_flagged: cvdFlags.filter((f) => f.known_adjacent).length,
    pairs: cvdFlags,
  },
  tfl_light_close_check: tflLightCloseCheck,
  overground_cvd_report: {
    min_delta_e_threshold: MIN_DELTA_E,
    total_flagged_pairs: overgroundCvdFlags.length,
    pairs: overgroundCvdFlags,
  },
};

writeFileSync(OUT_PATH, JSON.stringify(palette, null, 2) + '\n');

console.log(`Wrote ${tocKeys.length} TOC + ${metroKeys.length} Metro/LRT + ${Object.keys(TFL_LINE_COLORS).length} TfL-line-reference + 1 Heritage color to ${OUT_PATH}\n`);

console.log('=== 6 new Overground line colors ===');
for (const k of OVERGROUND_NEW) console.log(`  ${k}: light ${TFL_LINE_COLORS[k]} / dark ${tflDarkByKey[k]}`);
console.log(`CVD/ΔE check (6 new vs. 11 Underground lines + vs. each other, light+dark): ${overgroundCvdFlags.length} flagged pairs`);
if (overgroundCvdFlags.length) {
  for (const f of overgroundCvdFlags) console.log(`  [${f.theme}] ${f.a} vs ${f.b} — ${f.cvd_type}: ΔE ${f.deltaE_simulated ?? f.deltaE}`);
} else {
  console.log('  none — all 81 pairs (light+dark, plain ΔE + both CVD types) clear the ΔE76 >= 15 threshold.');
}
console.log('=== TOC assignment report ===');
for (const r of assignmentReport) {
  console.log(`  ${r.code.padEnd(4)} ${r.name.padEnd(26)} [${r.confidence.padEnd(6)}] ${r.method.padEnd(28)} ${r.chosen}${r.notes ? '  — ' + r.notes : ''}`);
}
const noneConfidence = assignmentReport.filter((r) => r.confidence === 'none');
if (noneConfidence.length) {
  console.log('\n=== FLAGGED — no confident real color found ===');
  noneConfidence.forEach((r) => console.log(`  ${r.code} ${r.name}: ${r.caveat}`));
}
const fallbacks = assignmentReport.filter((r) => r.method.startsWith('algorithmic_fallback'));
if (fallbacks.length) {
  console.log('\n=== Required algorithmic fallback (real color(s) collided or unavailable) ===');
  fallbacks.forEach((r) => console.log(`  ${r.code} ${r.name}: ${r.notes}`));
}
console.log(`\nCVD report: ${cvdFlags.length} flagged pairs (${cvdFlags.filter((f) => f.known_adjacent).length} known-adjacent — these were BLOCKING during assignment, so should be 0)`);
cvdFlags.filter((f) => f.known_adjacent).forEach((f) => console.log(`  [UNEXPECTED] ${f.theme}/${f.cvd_type}: ${f.a} vs ${f.b} — ΔE ${f.deltaE_simulated}`));

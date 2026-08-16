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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'operator-colors.json');

// ═══ Read-merge-preserve (2026-08-17) ═════════════════════════════════════
// This script used to only ever WRITE data/operator-colors.json, never read
// it — every run reconstructed every entry from scratch. That silently
// dropped hand-curated content that lives ONLY in the JSON: `_note` fields
// (the measurements/sourcing/reasoning behind a hand-set color, e.g.
// heritage's CVD-separation writeup), and — for GC, Manchester Metrolink,
// and Stansted Express (SX) specifically — the hand-set dark/light VALUES
// themselves, because this script's own generic derivation produces
// different (wrong) values for those three. Found live 2026-08-16: GC's
// dark and Metrolink's dark+light had already silently drifted out of sync
// with their own `_note`s at least once before this was caught.
//
// Fix has two parts:
//  1. COLOR_OVERRIDES below — hand-set hex VALUES, baked into the script
//     itself (same escape-hatch pattern as migrate-station-list.mjs's
//     MODE_OVERRIDES) so a from-scratch run with no prior JSON on disk
//     still produces the correct color, not just a regeneration. The
//     reasoning for each stays in that entry's `_note` in the JSON itself
//     — not duplicated into the script as a second copy of the same prose.
//  2. mergeEntry()/mergeCategory()/assertNothingLost() near the bottom —
//     generic read-merge-preserve for `_note` and any other non-generator-
//     owned field, plus a guard that THROWS if the final merged output is
//     about to ship without something the prior file had. Catches SX too:
//     it isn't in this script's operator list at all (never generated,
//     purely hand-added), so it needs pure passthrough rather than a
//     COLOR_OVERRIDES entry — the generic merge's "prior-only key" handling
//     covers that case without a per-operator special case.
const priorPalette = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : null;

// Hand-set colour overrides — GC's dark theme and Manchester Metrolink's
// whole entry bypass this script's generic derivation, which produces
// wrong values for both (see each entry's own `_note` in
// data/operator-colors.json for the full reasoning: an all-black livery
// can't be lifted into a dark basemap by lightness alone for GC; Metrolink
// uses one real brand yellow in both themes, not a derived light/dark
// pair). Keyed the same way each category already is — TOC code, metro
// name — matching MODE_OVERRIDES' keyed-by-identity shape.
const COLOR_OVERRIDES = {
  toc: {
    GC: { dark: '#B8AB7A' }, // light is correctly derived from REAL_TOC_COLORS.GC.primary — only dark needs the override
  },
  metro: {
    'Manchester Metrolink': { dark: '#FFDC44', light: '#FFDC44' },
  },
};

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
  // STALE ON PURPOSE — the shipped value is NOT what this seed produces.
  // data/operator-colors.json carries a hand-set #FFDC44 in BOTH themes (the
  // real Bee Network yellow, first-party-sourced), overriding the magenta this
  // seed derives. Same escape hatch as Grand Central's dark value: hand-set in
  // the JSON, not reproduced here, and a regeneration silently reverts it.
  // Read that entry's `_note` before regenerating — it records an UNRESOLVED
  // collision with Merseyrail, whose real brand colour is the same yellow.
  'Manchester Metrolink': '#A0459E',
  'Docklands Light Railway': '#00A4A7',
  'West Midlands Metro': '#7B4FA0',
  'Croydon Tramlink': '#9B59B6',
  'Sheffield Supertram': '#6C3483',
  'Tyne and Wear Metro': '#C39BD3',
  'Nottingham Express Transit': '#A569BD',
  'Glasgow Subway': '#A12B82',
  // Blackpool Tramway is NOT in this table — see the dedicated
  // BLACKPOOL_TRAMWAY_COLOR block right after this loop for why (it needs
  // to skip toVividLightTheme(), unlike every other metro entry).
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
// Manchester Metrolink's light override is applied LATER, alongside its dark
// override (search COLOR_OVERRIDES below) — NOT here. Overriding placedLight
// mid-sequence, before the darkByKey loop runs, was tried first and caused a
// real bug: the darkByKey loop's fallback search for keys processed AFTER
// Metrolink reads whatever is in `darkByKey` at that point for gate-checking
// (an "already placed" collision check), and an early light override changes
// what toDarkThemeFromLight() derives for Metrolink DURING the loop — a
// value nobody ever ships, since the real override replaces it afterward —
// which measurably changed OTHER metro entries' (Nottingham Express Transit,
// Edinburgh Trams) dark-theme fallback hue purely as a side effect, with
// nothing about their own colors having changed. Applying both overrides
// together, strictly after both loops complete (same point Blackpool
// Tramway and GC's dark override already use), means Manchester Metrolink
// never participates in the sequential placement AT ALL — consistent with
// every other hand-set entry in this file, and the only way to guarantee
// fixing one entry's color can't silently perturb an unrelated one's.

// ═══ Blackpool Tramway — deliberate exception to the vivid-lightness-band
// convention every other TOC/metro light-theme color follows ═══════════════
// 2026-07-15 follow-up: the original placeholder (#991BA7, run through the
// normal METRO_BASE loop above) collided with LNER (GR) at ΔE 4.6 under
// both CVD types in DARK theme — genuinely severe. Root-caused via a full
// search: toVividLightTheme() forces light-theme lightness into a narrow
// 38-54% band (same as every other TOC/metro entry) — and NO hue anywhere
// in the purple/violet range (255-335°) clears ΔE76>=15 against the full
// existing palette (every TOC + every other metro entry, both CVD types,
// both themes) within that band. Best achievable there is 9 remaining
// collisions, one as severe as ΔE 1.8 — not meaningfully better than the
// original problem. Widening the search to a DARKER, less-saturated purple
// (lightness ~20% instead of the usual 38-54%) DOES find a genuine
// zero-collision solution — #4D1A36 (light) / #932B64 (dark), hue 326°,
// still clearly reads as purple/magenta, just deeper and less vivid than
// the rest of the palette. Chosen over the alternative (a near-zero-
// collision option exists at hue ~240°, blue-violet, 1 remaining flag at
// ΔE 11.1) because that alternative is genuinely BLUE, not purple —
// defeats the point of the purple-family category rule entirely, whereas
// this one is a lightness/vividness compromise within a color that's
// still unambiguously purple. Flagging this as a real, deliberate
// departure from the vivid-theme convention — revisit if you'd rather
// accept a small residual CVD risk (any of the near-misses above) to keep
// this entry visually consistent with the rest of the palette's vividness.
const BLACKPOOL_TRAMWAY_LIGHT = '#4D1A36';
const BLACKPOOL_TRAMWAY_DARK = '#932B64';
{
  const gateLight = passesGates(BLACKPOOL_TRAMWAY_LIGHT, 'Blackpool Tramway', placedLight);
  if (!gateLight.ok) throw new Error(`Blackpool Tramway light candidate no longer clears gates (${gateLight.reason}) — palette must have changed since this was hand-verified; re-run the search in the Task 2 follow-up conversation, don't just ignore this.`);
  placedLight['Blackpool Tramway'] = BLACKPOOL_TRAMWAY_LIGHT;
}

// ── Heritage — hand-set constants, NOT derived (2026-07-27) ──────────────
// Was `toVividLightTheme('#B8752E')`, an amber. That amber's single worst
// pair in the entire palette was West Midlands Railway (#FFA342/#FF8300):
// measured ΔE2000 4.5 in dark theme, 11.1 in light. Replaced with a warm
// coral/salmon, which lifts WMR separation to 21.4 (dark) / 21.5 (light) and
// improves the worst-case separation against ANY other operator from 4.1 to
// 6.3 (dark) and 1.8 to 7.3 (light), under normal vision and under both
// protanopia and deuteranopia simulation.
//
// DERIVATION IS BYPASSED ON PURPOSE. toVividLightTheme() forces saturation
// >= 72 and lightness into 38-54, and toDarkThemeFromLight() lifts from
// there — that band cannot express a coral at all. Every seed hue in the
// coral range comes out of the pair as a vivid red (#C52115 / #EF3F32),
// which both misses the requested colour and measures WORSE than the amber
// it replaces (worst-case CVD separation 3.2). Same escape hatch Blackpool
// Tramway above already uses for the same class of reason — though note that
// heritage has never been run through passesGates() (it did not go through
// the placement search at all, before or after this change), so these two
// values are verified by the measurements recorded in
// data/operator-colors.json's heritage._note and nothing here will catch it
// if a future TOC placement lands on top of them. Change the pair together.
const HERITAGE_LIGHT = '#DE6454';
const HERITAGE_DARK = '#FC7B64';
const heritageLight = HERITAGE_LIGHT;

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
// Grand Central dark-theme override (see COLOR_OVERRIDES above). Verified
// against the CURRENT palette rather than trusted blindly — same pattern as
// Blackpool's re-verify block just below, and for the same reason: if this
// ever stops clearing, that's a real signal something upstream changed and
// needs a fresh look, not something to silently paper over.
{
  const gc = COLOR_OVERRIDES.toc.GC.dark;
  const gate = passesGates(gc, 'GC', darkByKey);
  if (!gate.ok) throw new Error(`Grand Central's hand-set dark value (${gc}) no longer clears gates (${gate.reason}) — the palette must have changed since this was verified (see toc.GC's _note in data/operator-colors.json); re-verify before trusting it, don't just ignore this.`);
  darkByKey.GC = gc;
}
// Manchester Metrolink — both theme values overridden together, here and
// only here (see the comment where the light-only version of this used to
// sit, right after the METRO_BASE light loop, for why applying it earlier
// is wrong). Both entries in darkByKey/placedLight already hold whatever
// the generic loops computed for this key — irrelevant, nothing downstream
// reads them again after this point, so overwriting both now is safe.
// Deliberately no passesGates() check: this entry's own `_note` documents
// that it fails the gate against Merseyrail (a real, known, unresolved
// brand collision, not a bug), so a throw-on-fail check would break every
// build.
darkByKey['Manchester Metrolink'] = COLOR_OVERRIDES.metro['Manchester Metrolink'].dark;
placedLight['Manchester Metrolink'] = COLOR_OVERRIDES.metro['Manchester Metrolink'].light;
// Blackpool Tramway again bypasses the generic derive-then-gate flow — its
// dark value was hand-verified together with its light value (see the
// BLACKPOOL_TRAMWAY_LIGHT/DARK block above), re-verify here rather than
// silently trust it's still exact after any upstream palette change.
{
  const rederived = toDarkThemeFromLight(BLACKPOOL_TRAMWAY_LIGHT);
  if (rederived !== BLACKPOOL_TRAMWAY_DARK) {
    throw new Error(`Blackpool Tramway dark value drifted from its hand-verified constant (expected ${BLACKPOOL_TRAMWAY_DARK}, toDarkThemeFromLight now produces ${rederived}) — toDarkThemeFromLight() must have changed since this was verified; investigate before trusting this color.`);
  }
  const gateDark = passesGates(BLACKPOOL_TRAMWAY_DARK, 'Blackpool Tramway', darkByKey);
  if (!gateDark.ok) throw new Error(`Blackpool Tramway dark candidate no longer clears gates (${gateDark.reason}) — re-run the search, don't just ignore this.`);
  darkByKey['Blackpool Tramway'] = BLACKPOOL_TRAMWAY_DARK;
}
// Hand-set, not lifted from light — see HERITAGE_LIGHT/HERITAGE_DARK above.
const heritageDark = HERITAGE_DARK;

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
const tocKeys = Object.keys(REAL_TOC_COLORS), metroKeys = [...Object.keys(METRO_BASE), 'Blackpool Tramway'];
function withThemes(keys) {
  return Object.fromEntries(keys.map((k) => [k, { dark: darkByKey[k], light: placedLight[k] }]));
}

// ═══ Read-merge-preserve: merge + guard ═══════════════════════════════════
// `dark`/`light` are this script's own output — always overwritten with
// whatever was just computed, that's the entire point of a regeneration.
// Anything else on an entry (in practice: `_note`) is NOT something this
// script produces, so it must come from the prior file instead of being
// silently dropped. Same inverted-allowlist principle as every other
// read-merge-preserve generator in this repo (CLAUDE.md's "Generator
// safety" section) — the allowlist here is deliberately just the two keys
// this script actually writes, not a naming convention, so it can't miss
// whatever a future hand-edit adds under some other field name.
const GENERATOR_OWNED_ENTRY_KEYS = new Set(['dark', 'light']);

function mergeEntry(freshEntry, priorEntry) {
  if (!priorEntry) return freshEntry;
  const merged = { ...freshEntry };
  for (const [k, v] of Object.entries(priorEntry)) {
    if (!GENERATOR_OWNED_ENTRY_KEYS.has(k)) merged[k] = v;
  }
  return merged;
}
// A category is a map of key -> entry (toc, metro, tfl_lines). Keys that
// exist ONLY in the prior file — Stansted Express (SX) today: not in this
// script's operator list at all, so `fresh` never produces an 'SX' key —
// are carried over wholesale rather than disappearing just because the
// generator didn't (re)produce that key this run.
function mergeCategory(freshCategory, priorCategory) {
  if (!priorCategory) return freshCategory;
  const merged = {};
  for (const [key, entry] of Object.entries(freshCategory)) merged[key] = mergeEntry(entry, priorCategory[key]);
  for (const [key, entry] of Object.entries(priorCategory)) if (!(key in merged)) merged[key] = entry;
  return merged;
}
// Independent re-check of the ACTUAL merged output against the prior file —
// deliberately not just trusting mergeEntry/mergeCategory did their job.
// Throws rather than silently shipping a regression if a non-generator-
// owned field is missing, or changed, from what the prior file had.
function assertNothingLostFromCategory(label, mergedCategory, priorCategory) {
  if (!priorCategory) return;
  for (const [key, priorEntry] of Object.entries(priorCategory)) {
    const mergedEntry = mergedCategory[key];
    if (!mergedEntry) throw new Error(`${label}.${key} existed in the prior data/operator-colors.json and is missing entirely from the merged output — read-merge-preserve failed, refusing to write.`);
    for (const [k, v] of Object.entries(priorEntry)) {
      if (GENERATOR_OWNED_ENTRY_KEYS.has(k)) continue;
      if (!(k in mergedEntry) || JSON.stringify(mergedEntry[k]) !== JSON.stringify(v)) {
        throw new Error(`${label}.${key}.${k} would be lost or changed by this write — a hand-curated field must survive a regeneration verbatim. Prior: ${JSON.stringify(v)}. About to write: ${JSON.stringify(mergedEntry[k])}. Refusing to write.`);
      }
    }
  }
}
function assertNothingLostFromEntry(label, mergedEntry, priorEntry) {
  if (!priorEntry) return;
  for (const [k, v] of Object.entries(priorEntry)) {
    if (GENERATOR_OWNED_ENTRY_KEYS.has(k)) continue;
    if (!(k in mergedEntry) || JSON.stringify(mergedEntry[k]) !== JSON.stringify(v)) {
      throw new Error(`${label}.${k} would be lost or changed by this write. Prior: ${JSON.stringify(v)}. About to write: ${JSON.stringify(mergedEntry[k])}. Refusing to write.`);
    }
  }
}

const freshToc = withThemes(tocKeys);
const freshMetro = withThemes(metroKeys);
const freshTflLines = Object.fromEntries(Object.keys(TFL_LINE_COLORS).map((k) => [k, { dark: tflDarkByKey[k], light: TFL_LINE_COLORS[k] }]));
const freshHeritage = { dark: heritageDark, light: heritageLight };

const mergedToc = mergeCategory(freshToc, priorPalette?.toc);
const mergedMetro = mergeCategory(freshMetro, priorPalette?.metro);
const mergedTflLines = mergeCategory(freshTflLines, priorPalette?.tfl_lines);
const mergedHeritage = mergeEntry(freshHeritage, priorPalette?.heritage);

assertNothingLostFromCategory('toc', mergedToc, priorPalette?.toc);
assertNothingLostFromCategory('metro', mergedMetro, priorPalette?.metro);
assertNothingLostFromCategory('tfl_lines', mergedTflLines, priorPalette?.tfl_lines);
assertNothingLostFromEntry('heritage', mergedHeritage, priorPalette?.heritage);

const palette = {
  generated_at: new Date().toISOString(),
  _notes: 'SUPERSEDES the earlier algorithmically-generated TOC palette. toc hex are now REAL corporate colors (see assignment_report for source/confidence per operator) — primary tried first, secondary/alternate brand shade if primary collides, algorithmic hue-nudge fallback (flagged) only if neither real option clears separation. Light theme is the anchor (real liveries/websites are designed for pale backgrounds); dark theme is derived by lifting lightness, preserving true hue. metro/heritage are out of scope for corporate research (not TOCs) and keep their prior hand-picked design, gate-checked against the new toc placements. tfl_lines unchanged from the prior round.',
  toc: mergedToc,
  metro: mergedMetro,
  tfl_lines: mergedTflLines,
  heritage: mergedHeritage,
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

#!/usr/bin/env node
/**
 * scripts/build-attribution.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Builds data/attribution.json — the machine-readable manifest of every
 * licence the map's data actually sits under, with the exact attribution
 * string each one requires and whether that attribution is MANDATORY or a
 * COURTESY. Phase 2B renders the sidebar attribution bar from this file
 * rather than hardcoding strings, and it seeds the eventual sources/about
 * page, so it has to be complete and accurate rather than approximately right.
 *
 *   node scripts/build-attribution.mjs
 *   node scripts/build-attribution.mjs --check-palette   (era-colour separation report)
 *
 * ─── WHY THIS IS PART-DERIVED, NOT HAND-WRITTEN ───────────────────────────
 * The OHM entries are counted from the REAL extract
 * (scripts/output/historical-lines-report.json's licence census) rather than
 * asserted, so the manifest cannot drift from what actually shipped: if a
 * future OHM refresh introduces a new per-element licence, the line build
 * fails the allow-list gate first, and this file's counts change second.
 * The non-OHM entries (OSM, Wikipedia, Wikidata, NaPTAN, base tiles) are
 * static facts about sources this repo already uses and are declared below.
 *
 * ─── MANDATORY vs COURTESY ────────────────────────────────────────────────
 * MANDATORY  the licence legally requires the credit. Removing it is a
 *            licence breach. ODbL (OSM), CC-BY (NLS), CC-BY-SA (Wikipedia),
 *            OGL (NaPTAN), and the base-tile provider's own terms.
 * COURTESY   the licence does NOT require it — CC0 waives attribution
 *            entirely (OHM, Wikidata) — but crediting is good practice and
 *            the project intends to. Marked separately so a future UI can
 *            collapse courtesy credits into an "about" page while keeping
 *            mandatory ones on the map itself, which is a real design
 *            constraint on a small floating attribution bar.
 *
 * ─── FIELD OWNERSHIP ──────────────────────────────────────────────────────
 * Sole writer of data/attribution.json. Reads
 * scripts/output/historical-lines-report.json and
 * scripts/output/historical-stations-report.json (for counts only) and
 * data/era-colors.json (for --check-palette). Writes nothing else.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LICENCE_ALLOW_LIST } from './lib/historical-era.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'attribution.json');
const LINES_REPORT = path.join(ROOT, 'scripts', 'output', 'historical-lines-report.json');
const STATIONS_REPORT = path.join(ROOT, 'scripts', 'output', 'historical-stations-report.json');
const ERA_COLORS = path.join(ROOT, 'data', 'era-colors.json');

// Static, non-OHM sources this repo already depends on. Declared here rather
// than derived because there is nothing to count — they are facts about the
// pipeline, not about a particular extract.
const STATIC_SOURCES = [
  {
    id: 'osm',
    source: 'OpenStreetMap',
    applies_to: [
      'data/line-segments.json (modern band, 1994+)',
      'tile-generation/operators.pmtiles',
      'tile-generation/gb-railways.pmtiles',
      'stations-content.json (OSM-derived structured fields)',
    ],
    licence_code: 'ODbL-1.0',
    licence_label: 'Open Database License 1.0',
    licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: 'MANDATORY',
    attribution_string: '© OpenStreetMap contributors',
    notes:
      'Share-alike. This is precisely why the historical layer is clipped with OHM\'s own CC0 ' +
      'boundary polygons rather than an OSM one — using an ODbL database to spatially filter ' +
      'CC0 data arguably produces a Derivative Database and would drag share-alike onto output ' +
      'that is otherwise unencumbered.',
  },
  {
    id: 'wikipedia',
    source: 'Wikipedia (English)',
    applies_to: [
      'scripts/output/historical-stations.geojson (station opening/closing years)',
      'data/big4-constituents.json (Railways Act 1921 constituent lists)',
      'stations-content.json / operators-content.json / routes-content.json (narrative fields)',
    ],
    licence_code: 'CC-BY-SA-4.0',
    licence_label: 'Creative Commons Attribution-ShareAlike 4.0',
    licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    attribution: 'MANDATORY',
    attribution_string: 'Station dates from Wikipedia (CC BY-SA 4.0)',
    notes:
      'The station dates are taken from CATEGORY MEMBERSHIP (the year is in the category name), ' +
      'not from article prose. Whether a bare year extracted from a category name is even ' +
      'copyrightable is doubtful — individual raw facts generally are not — but the credit is ' +
      'given regardless rather than relying on that argument. FLAGGED: ShareAlike could in ' +
      'principle be read as reaching derived datasets. Worth a human view before launch.',
  },
  {
    id: 'wikidata',
    source: 'Wikidata',
    applies_to: ['scripts/output/historical-stations.geojson (P625 coordinates)'],
    licence_code: 'CC0-1.0',
    licence_label: 'CC0 1.0 Universal (public domain dedication)',
    licence_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: 'COURTESY',
    attribution_string: 'Coordinates from Wikidata (CC0)',
    notes: 'CC0 waives attribution. Credited by choice.',
  },
  {
    id: 'naptan',
    source: 'NaPTAN (Department for Transport)',
    applies_to: ['station-list.json', 'authoritative "open now" flag on historical stations'],
    licence_code: 'OGL-3.0',
    licence_label: 'Open Government Licence v3.0',
    licence_url: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    attribution: 'MANDATORY',
    attribution_string: 'Contains public sector information licensed under the Open Government Licence v3.0',
    notes: 'OGL permits commercial use and requires the standard acknowledgement above.',
  },
  {
    id: 'stadia',
    source: 'Stadia Maps / Stamen / OpenMapTiles',
    applies_to: ['base map tiles (Alidade Smooth Dark)'],
    licence_code: 'proprietary-with-attribution',
    licence_label: 'Stadia Maps terms of service',
    licence_url: 'https://stadiamaps.com/attribution/',
    attribution: 'MANDATORY',
    attribution_string: '© Stadia Maps © Stamen Design © OpenMapTiles © OpenStreetMap contributors',
    notes: 'Required by the tile provider\'s terms independently of any data licence.',
  },
  {
    id: 'openrailwaymap',
    source: 'OpenRailwayMap',
    applies_to: ['ORM raster overlay'],
    licence_code: 'CC-BY-SA-2.0',
    licence_label: 'Creative Commons Attribution-ShareAlike 2.0',
    licence_url: 'https://creativecommons.org/licenses/by-sa/2.0/',
    attribution: 'MANDATORY',
    attribution_string: '© OpenRailwayMap contributors',
    notes: 'Already required by CLAUDE.md for the existing overlay.',
  },
];

// ─── Palette separation check ─────────────────────────────────────────────
// Verifies the era colours are mutually distinguishable and none strays into
// the reserved turquoise --t. Not a build step — a report, run on demand.
const RESERVED_TURQUOISE = '#40E0D0';

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function rgbToLab([r, g, b]) {
  let [x, y, z] = [r, g, b]
    .map((v) => v / 255)
    .map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const X = (x * 0.4124 + y * 0.3576 + z * 0.1805) / 0.95047;
  const Y = x * 0.2126 + y * 0.7152 + z * 0.0722;
  const Z = (x * 0.0193 + y * 0.1192 + z * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function deltaE(a, b) {
  const [l1, a1, b1] = rgbToLab(hexToRgb(a));
  const [l2, a2, b2] = rgbToLab(hexToRgb(b));
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}
function hueOf(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function checkPalette() {
  const era = JSON.parse(readFileSync(ERA_COLORS, 'utf8'));
  const swatches = [
    ['pre1923', era.pre1923.dark],
    ...Object.entries(era.big4.companies).map(([n, v]) => [n, v.dark]),
    ['big4/unknown', era.big4.unknown.dark],
    ['br', era.br.dark],
  ];
  console.log('Era palette separation (dark theme, CIE76 deltaE)');
  console.log('  deltaE >= 25 reads as clearly different at line width; < 15 is a risk.\n');
  let worst = { d: Infinity };
  for (let i = 0; i < swatches.length; i++) {
    for (let j = i + 1; j < swatches.length; j++) {
      const d = deltaE(swatches[i][1], swatches[j][1]);
      if (d < worst.d) worst = { d, a: swatches[i][0], b: swatches[j][0] };
      if (d < 25) console.log(`  ${d < 15 ? 'RISK' : 'note'}  ${d.toFixed(1).padStart(5)}  ${swatches[i][0]} vs ${swatches[j][0]}`);
    }
  }
  console.log(`\n  closest pair: ${worst.a} vs ${worst.b} — deltaE ${worst.d.toFixed(1)}`);
  console.log(`\nSeparation from reserved turquoise --t ${RESERVED_TURQUOISE} (hue ${hueOf(RESERVED_TURQUOISE).toFixed(0)}deg):`);
  for (const [name, hex] of swatches) {
    const dh = Math.abs(hueOf(hex) - hueOf(RESERVED_TURQUOISE));
    console.log(`  ${name.padEnd(38)} ${hex}  hue ${hueOf(hex).toFixed(0).padStart(3)}deg  Δhue ${Math.min(dh, 360 - dh).toFixed(0).padStart(3)}deg  ΔE ${deltaE(hex, RESERVED_TURQUOISE).toFixed(0)}`);
  }
  return { swatches: swatches.map(([n, h]) => ({ name: n, hex: h })), closest: worst };
}

function main() {
  if (process.argv.includes('--check-palette')) {
    checkPalette();
    return;
  }

  if (!existsSync(LINES_REPORT)) {
    throw new Error(
      `Missing ${path.relative(ROOT, LINES_REPORT)} — run scripts/build-historical-lines.mjs first. ` +
        `This manifest is derived from the real extract's licence census, not hand-written, so it ` +
        `cannot be built before the extract exists.`,
    );
  }
  const lines = JSON.parse(readFileSync(LINES_REPORT, 'utf8'));
  const stations = existsSync(STATIONS_REPORT) ? JSON.parse(readFileSync(STATIONS_REPORT, 'utf8')) : null;

  // Turn the raw census into manifest entries via the same allow-list the
  // extract gate uses, so the two can never disagree about what a licence
  // value means.
  const ohmEntries = [];
  for (const [rawValue, count] of Object.entries(lines.licence_census || {})) {
    const key = rawValue === '(none — OHM CC0 default)' ? '__default__' : rawValue;
    const entry = LICENCE_ALLOW_LIST[key];
    if (!entry) {
      throw new Error(
        `Licence census contains "${rawValue}" which is not on the allow-list. The extract should ` +
          `have refused it — do not build an attribution manifest around an unreviewed licence.`,
      );
    }
    ohmEntries.push({
      id: entry.code === 'CC0-1.0' ? 'ohm' : 'ohm-nls',
      source:
        entry.code === 'CC0-1.0'
          ? 'OpenHistoricalMap'
          : 'OpenHistoricalMap — National Library of Scotland tracings',
      applies_to: ['scripts/output/historical-lines.geojson (pre-1994 lines)'],
      licence_code: entry.code,
      licence_label: entry.label,
      licence_url:
        entry.code === 'CC0-1.0'
          ? 'https://creativecommons.org/publicdomain/zero/1.0/'
          : 'https://creativecommons.org/licenses/by/4.0/',
      attribution: entry.attribution_required ? 'MANDATORY' : 'COURTESY',
      attribution_string: entry.attribution_string,
      feature_count: count,
      raw_license_tag: rawValue === '(none — OHM CC0 default)' ? null : rawValue,
      notes:
        entry.code === 'CC0-1.0'
          ? 'OHM\'s default. CC0 waives attribution entirely; credited by choice. Confirmed from ' +
            'OHM\'s copyright policy 2026-07-25. FLAGGED: openhistoricalmap.org/copyright returns ' +
            'HTTP 403 to automated fetching, so the primary-source page has not been read directly ' +
            '— worth one human browser check before commercial launch.'
          : 'Per-element override of OHM\'s CC0 default, carried through to the tiles as a ' +
            'per-feature `license` property so these can be credited individually. ~14% of GB ' +
            'railway ways by count but only ~2% by length (short yard/station-throat detail, ' +
            'two-thirds of it in Scotland).',
    });
  }
  // Merge duplicate ids (both CC0 spellings collapse to one entry).
  const merged = new Map();
  for (const e of ohmEntries) {
    const prev = merged.get(e.id);
    if (prev) prev.feature_count += e.feature_count;
    else merged.set(e.id, e);
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    _notes:
      'Machine-readable licence/attribution manifest for srhq.uk map data. Built by ' +
      'scripts/build-attribution.mjs (sole writer). The OHM entries are DERIVED from the real ' +
      'extract\'s licence census so they cannot drift from what shipped; the rest are static ' +
      'facts about sources the repo already uses. Phase 2B must render the attribution bar FROM ' +
      'THIS FILE rather than hardcoding strings — that is the whole point of it existing. ' +
      '`attribution` is MANDATORY (the licence legally requires the credit) or COURTESY (the ' +
      'licence waives it — CC0 — but we credit anyway). A UI short on space may collapse ' +
      'COURTESY entries into an about/sources page; it may NOT collapse MANDATORY ones. ' +
      'Per-feature crediting is possible for the OHM/NLS split because every line feature ' +
      'carries its own `license` property all the way into the vector tiles.',
    ui_guidance: {
      map_bar_must_include: 'every entry where attribution === "MANDATORY" and the layer is visible',
      about_page_should_include: 'every entry regardless of MANDATORY/COURTESY',
      per_feature_credit:
        'line features carry a `license` property (CC0-1.0 | CC-BY-4.0); a feature-level popup ' +
        'can credit NLS only for the features that actually need it, rather than crediting NLS ' +
        'for the whole layer',
      open_decision:
        'Where the NLS credit sits — always-on in the bar, or only when an NLS feature is on ' +
        'screen / selected — is NOT decided here. Always-on is safe; conditional is tidier but ' +
        'needs the viewport test to be genuinely reliable, since a missed credit is a licence ' +
        'breach rather than a cosmetic slip.',
    },
    sources: [...merged.values(), ...STATIC_SOURCES],
    dataset_summary: {
      historical_lines: {
        features: lines.stats && lines.stats.emitted,
        by_licence: lines.stats && lines.stats.by_licence,
      },
      historical_stations: stations ? { features: stations.stats.emitted } : null,
    },
  };

  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`  ${manifest.sources.length} sources`);
  const mandatory = manifest.sources.filter((s) => s.attribution === 'MANDATORY');
  console.log(`  MANDATORY attribution: ${mandatory.length}`);
  for (const s of mandatory) console.log(`    ${s.source} — "${s.attribution_string}"`);
  const courtesy = manifest.sources.filter((s) => s.attribution === 'COURTESY');
  console.log(`  COURTESY attribution:  ${courtesy.length}`);
  for (const s of courtesy) console.log(`    ${s.source} — "${s.attribution_string}"`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

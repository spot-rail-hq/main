#!/usr/bin/env node
/**
 * scripts/scope-ohm-coverage.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * SCOPING / REPORT PASS ONLY. Writes nothing except its own report files —
 * does not touch stations-content.json, routes-content.json,
 * operators-content.json, data/*, or any map/tile asset. Same discipline as
 * scripts/scope-wikipedia-coverage.mjs, which this is modelled on.
 *
 * Re-runs the OpenHistoricalMap census behind HISTORICAL-SLIDER-FINDINGS.md
 * (Phase 1 + 1B) so the historical-slider feature's source data can be
 * re-measured on the quarterly refresh cycle without anyone reconstructing
 * the queries by hand. OHM is a live wiki: every number this prints is a
 * snapshot, and coverage moves — that drift is exactly what this script
 * exists to track.
 *
 * Run:
 *   node scripts/scope-ohm-coverage.mjs
 *
 * Optional env vars:
 *   GEOMETRY=1   also runs the LENGTH census (§4 below). This downloads full
 *                way geometry — ~21 MB, several minutes. Off by default;
 *                the count/tag queries answer most refresh questions on
 *                their own. Turn it on when you need km-by-era rather than
 *                feature counts.
 *   BBOX=1       use the legacy rectangular bbox instead of the GB polygon
 *                clip. Only for reproducing Phase 1's exact figures — the
 *                bbox includes the whole island of Ireland (~4.6% of
 *                features) and must NOT be used for real extracts. See
 *                GB_AREAS below.
 *
 * ─── WHAT THIS QUERIES (and what it deliberately does not) ────────────────
 * Endpoint is OHM's own Overpass instance, NOT the self-hosted OSM Overpass
 * that scripts/fetch-osm-facts.mjs and scripts/build-operator-inventory.mjs
 * use. OHM is a SEPARATE DATABASE from OSM: same software, same id ranges,
 * unrelated objects. OHM way 198168331 and OSM way 198168331 are different
 * features. Never join the two on id — see HISTORICAL-SLIDER-FINDINGS.md §5.
 *
 * ─── LICENCE (confirmed 2026-07-25, re-confirm on any major refresh) ──────
 * OHM data is CC0 public-domain dedicated — commercial use permitted, no
 * attribution legally required. NOT ODbL, unlike OSM. BUT individual
 * elements may carry their own `license=*` tag overriding that default, and
 * in GB 1,898 railway elements are tagged
 *   "CC-BY (NLS): Reproduced with the permission of the National Library of
 *   Scotland"
 * which DOES require attribution. Query §5 below re-checks the licence
 * distribution on every run precisely so a future non-commercial-licensed
 * element cannot enter the pipeline unnoticed. Treat a new value appearing
 * in that census as a blocker until reviewed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'scripts', 'output');
const REPORT_JSON_PATH = path.join(OUTPUT_DIR, 'ohm-coverage-report.json');
const REPORT_MD_PATH = path.join(OUTPUT_DIR, 'ohm-coverage-report.md');
const GEOMETRY_DUMP_PATH = path.join(OUTPUT_DIR, 'ohm-gb-railway-geom.json');

const OHM_OVERPASS = 'https://overpass-api.openhistoricalmap.org/api/interpreter';
const USER_AGENT =
  'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

const WANT_GEOMETRY = process.env.GEOMETRY === '1';
const USE_BBOX = process.env.BBOX === '1';

// ─── GB clip ──────────────────────────────────────────────────────────────
// OHM's OWN current England / Scotland / Wales admin_level=4 relations,
// used as the clip polygon. Chosen over the obvious alternatives on purpose:
//
//   - An OSM boundary relation is ODbL. Using an ODbL database to spatially
//     filter another dataset arguably produces a Derivative Database, which
//     would drag share-alike obligations onto output that is otherwise CC0.
//     Genuinely ambiguous, and not worth the argument when a CC0 source
//     exists — see HISTORICAL-SLIDER-FINDINGS.md §1B-5.
//   - OS Boundary-Line is OGL v3 (commercial use fine) but needs a download,
//     a reprojection from OSGB36, and an attribution line of its own.
//
// Using OHM's own boundaries keeps the whole pipeline inside one CC0
// database with nothing to reconcile. Overpass area id = relation id +
// 3600000000.
//
// These are the CURRENT (no end_date) relations. Deliberately fixed rather
// than time-varying: we want "the railway is inside GB as GB is drawn today"
// for every era, not a 1923 map clipped to 1923 borders — otherwise a line
// would blink in and out as historical borders moved under it. OHM also
// holds dated historical boundary relations if that decision is ever
// revisited.
//
// VERIFY THESE IDS on a refresh — OHM relations can be split/replaced, and a
// stale id silently returns zero features rather than erroring. The
// assertion in runCensus() below catches that.
const GB_AREAS = {
  England: 3602874395,
  Scotland: 3602874396,
  Wales: 3602697730,
};

// Legacy Phase 1 rectangle, kept only for reproducing that report's numbers.
// Includes the whole island of Ireland plus bits of the French/Belgian coast
// and the Channel Islands. NOT a valid extract boundary.
const LEGACY_BBOX = '49.86,-8.65,60.86,1.77';

// Builds the area-clip preamble + a filtered statement for each GB nation.
// Overpass has no "union of areas" filter, so the statement is repeated per
// area and unioned — that is the normal idiom, not a workaround.
function gbScoped(statement) {
  if (USE_BBOX) return `${statement}(${LEGACY_BBOX});`;
  const setup = Object.entries(GB_AREAS)
    .map(([name, id]) => `area(${id})->.${name.toLowerCase()};`)
    .join('\n');
  const body = Object.keys(GB_AREAS)
    .map((name) => `  ${statement}(area.${name.toLowerCase()});`)
    .join('\n');
  return `${setup}\n(\n${body}\n);`;
}

// railway=* values that are LINEAR TRACK, as opposed to station buildings,
// platforms, turntables, signal boxes and yards which also carry railway=*.
// Phase 1 found 201 of 13,655 GB ways were non-linear; excluding them is
// what makes "13,454 linear ways" comparable run to run.
const LINEAR_RAILWAY_RE =
  '^(rail|light_rail|narrow_gauge|tram|subway|monorail|funicular|miniature|preserved|disused|abandoned|razed|construction|proposed)$';

// ─── The census ───────────────────────────────────────────────────────────
// Each entry is one Overpass query. `count` queries return a single count
// element and are cheap (seconds); `tags` queries return every matching
// element's tags with no geometry (~3.5 MB for GB, tens of seconds).
const QUERIES = [
  {
    key: 'lines_total',
    kind: 'count',
    title: 'All railway ways',
    why: 'Denominator for every line percentage. Includes station buildings/platforms; see lines_tags for the linear-only split.',
    ql: () => gbScoped('way["railway"]'),
  },
  {
    key: 'lines_with_start_date',
    kind: 'count',
    title: 'Railway ways carrying start_date',
    why: 'Opening-date coverage. Phase 1: 86.7% of linear ways. A line with no start_date cannot be placed on the slider at all and is hidden per the locked decision.',
    ql: () => gbScoped(`way["railway"]["start_date"]`),
  },
  {
    key: 'lines_with_end_date',
    kind: 'count',
    title: 'Railway ways carrying end_date',
    why: 'Closure-date coverage — drives whether lines correctly DISAPPEAR as the slider advances. Phase 1: 42.1%.',
    ql: () => gbScoped(`way["railway"]["end_date"]`),
  },
  {
    key: 'lines_with_both_dates',
    kind: 'count',
    title: 'Railway ways carrying both start_date and end_date',
    why: 'Fully-bounded features — the ones that both appear and disappear correctly. Phase 1: 42.1%, i.e. end_date almost never appears without start_date.',
    ql: () => gbScoped(`way["railway"]["start_date"]["end_date"]`),
  },
  {
    key: 'lines_undated',
    kind: 'count',
    title: 'Railway ways with neither date',
    why: 'Hidden entirely per the locked decision. Phase 1: 1,784 linear ways, of which ~875 carry fixme:start_date (a mapper explicitly flagging the date as unknown, not an unexamined feature).',
    ql: () => gbScoped(`way["railway"][!"start_date"][!"end_date"]`),
  },
  {
    key: 'lines_with_operator',
    kind: 'count',
    title: 'Railway ways carrying operator',
    why: 'The company-attribution gap. Phase 1: ~7% in EVERY era band, and effectively zero for 1923-1994 (British Rail/British Railways appear once each in the whole GB extract; LNER and LMS zero times). Watch this number — a jump means OHM has gained era attribution and the big4/br bands could be reconsidered.',
    ql: () => gbScoped(`way["railway"]["operator"]`),
  },
  {
    key: 'lines_beeching_closures',
    kind: 'count',
    title: 'Railway ways with an end_date in 1963-1970',
    why: 'The 1963 snap-point sanity check. Phase 1: 2,662 ways / 7,427 km, against the 1963 Beeching report\'s 8,000 km target — this band is well covered for LINES (it is not, for stations).',
    ql: () => gbScoped(`way["railway"]["end_date"~"^(196[3-9]|1970)"]`),
  },
  {
    key: 'stations_total',
    kind: 'count',
    title: 'Station-like nodes and ways',
    why: 'The weak spot. Phase 1: 1,395 elements for ALL of GB history, against ~2,570 stations open today — under a fifth of the current network, never mind historical. This is why stations are sourced from Wikipedia+Wikidata instead, per HISTORICAL-SLIDER-FINDINGS.md §1B-2.',
    ql: () =>
      USE_BBOX
        ? `(\n  node["railway"~"^(station|halt|stop|tram_stop)$"](${LEGACY_BBOX});\n  way["railway"~"^(station|halt)$"](${LEGACY_BBOX});\n);`
        : [
            Object.entries(GB_AREAS)
              .map(([n, id]) => `area(${id})->.${n.toLowerCase()};`)
              .join('\n'),
            '(',
            Object.keys(GB_AREAS)
              .map(
                (n) =>
                  `  node["railway"~"^(station|halt|stop|tram_stop)$"](area.${n.toLowerCase()});\n  way["railway"~"^(station|halt)$"](area.${n.toLowerCase()});`,
              )
              .join('\n'),
            ');',
          ].join('\n'),
  },
  {
    key: 'stations_with_end_date',
    kind: 'count',
    title: 'Station elements carrying end_date',
    why: 'Beeching station closures. Phase 1: only 426 stations closed 1955-1975 against a real ~2,000-2,500 — roughly one sixth. Wikipedia year categories carry 3,378 for the same window.',
    ql: () =>
      USE_BBOX
        ? `node["railway"~"^(station|halt|stop|tram_stop)$"]["end_date"](${LEGACY_BBOX});`
        : gbScoped(`node["railway"~"^(station|halt|stop|tram_stop)$"]["end_date"]`),
  },
  {
    key: 'lines_tags',
    kind: 'tags',
    title: 'Full tag dump of every railway way (no geometry)',
    why: 'Powers the local analysis below: linear-vs-non-linear split, date-format survey, per-era band membership, operator/name coverage, and the licence census. ~3.5 MB.',
    ql: () => gbScoped('way["railway"]'),
  },
];

// The geometry query is separate and opt-in — it is the only expensive one.
const GEOMETRY_QUERY = {
  key: 'lines_geometry',
  title: 'Full geometry of every railway way',
  why: 'Needed only for LENGTH-based measures (km alive per era, NLS licence share by km). Phase 1 showed length is a far better coverage measure than feature count: 13,454 ways sounds thin next to OSM, but they carry 33,385 km, and the 1923 figure lands at ~83% of the known historical peak network.',
  ql: () => gbScoped('way["railway"]'),
};

async function overpass(ql, label) {
  const body = `[out:json][timeout:900];\n${ql}\n`;
  const started = Date.now();
  const res = await fetch(OHM_OVERPASS, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: body }).toString(),
  });
  if (!res.ok) throw new Error(`${label}: Overpass HTTP ${res.status}`);
  const json = await res.json();
  console.log(`  ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return json;
}

const YEAR_RE = /^-?(\d{4})/;
const yearOf = (v) => {
  if (!v) return null;
  const m = String(v).match(YEAR_RE);
  return m ? parseInt(m[1], 10) : null;
};

// Locked era bands. `modern` is deliberately open-ended and anchored to the
// CURRENT year at render time, not a hardcoded 2025 — see the schema section
// of HISTORICAL-SLIDER-FINDINGS.md.
const ERA_BANDS = [
  ['pre1923', 0, 1922],
  ['big4', 1923, 1947],
  ['br', 1948, 1993],
  ['modern', 1994, new Date().getUTCFullYear()],
];

function analyseTags(elements) {
  const linearRe = new RegExp(LINEAR_RAILWAY_RE);
  const linear = elements.filter(
    (e) => e.tags && linearRe.test(e.tags.railway) && e.tags.area !== 'yes',
  );
  const pct = (n) => +((100 * n) / linear.length).toFixed(1);

  const withStart = linear.filter((e) => e.tags.start_date);
  const withEnd = linear.filter((e) => e.tags.end_date);
  const both = linear.filter((e) => e.tags.start_date && e.tags.end_date);
  const neither = linear.filter((e) => !e.tags.start_date && !e.tags.end_date);

  // Date-format survey. Phase 1 found the values essentially clean — a
  // ^(\d{4}) prefix match is sufficient and no fuzzy date parser is needed.
  // A rise in OTHER here would change that conclusion.
  const formats = {};
  for (const e of linear) {
    for (const k of ['start_date', 'end_date']) {
      const v = e.tags[k];
      if (!v) continue;
      const f = /^\d{4}$/.test(v)
        ? 'YYYY'
        : /^\d{4}-\d{2}$/.test(v)
          ? 'YYYY-MM'
          : /^\d{4}-\d{2}-\d{2}$/.test(v)
            ? 'YYYY-MM-DD'
            : 'OTHER';
      formats[f] = (formats[f] || 0) + 1;
    }
  }

  const bands = {};
  for (const [name, from, to] of ERA_BANDS) {
    const alive = linear.filter((e) => {
      const s = yearOf(e.tags.start_date);
      const en = yearOf(e.tags.end_date);
      return s !== null && s <= to && (en === null || en >= from);
    });
    const companyNamed = alive.filter(
      (e) => e.tags.name && /\b(Railway|Railways|Railroad|Rly)\b/i.test(e.tags.name),
    );
    bands[name] = {
      alive: alive.length,
      with_operator: alive.filter((e) => e.tags.operator).length,
      with_name: alive.filter((e) => e.tags.name).length,
      with_company_like_name: companyNamed.length,
    };
  }

  // LICENCE CENSUS — the gate described in the header. Any value that is not
  // already known-good is surfaced loudly.
  const licences = {};
  for (const e of elements) {
    const l = e.tags && e.tags.license;
    if (l) licences[l] = (licences[l] || 0) + 1;
  }
  const KNOWN_OK = [
    'CC0',
    'CC-BY (NLS): Reproduced with the permission of the National Library of Scotland',
  ];
  const unexpectedLicences = Object.keys(licences).filter((l) => !KNOWN_OK.includes(l));

  return {
    all_railway_ways: elements.length,
    linear_ways: linear.length,
    date_coverage: {
      start_date: { n: withStart.length, pct: pct(withStart.length) },
      end_date: { n: withEnd.length, pct: pct(withEnd.length) },
      both: { n: both.length, pct: pct(both.length) },
      neither: { n: neither.length, pct: pct(neither.length) },
      only_end_date: { n: withEnd.length - both.length },
      fixme_start_date: linear.filter((e) => e.tags['fixme:start_date']).length,
    },
    date_formats: formats,
    era_bands: bands,
    licences,
    unexpected_licences: unexpectedLicences,
  };
}

function analyseGeometry(elements) {
  const linearRe = new RegExp(LINEAR_RAILWAY_RE);
  const linear = elements.filter(
    (e) => e.tags && linearRe.test(e.tags.railway) && e.tags.area !== 'yes' && e.geometry,
  );
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const hav = (a, b) => {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const s =
      Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const lengthKm = (g) => {
    let k = 0;
    for (let i = 1; i < g.length; i++) k += hav(g[i - 1], g[i]);
    return k;
  };

  const rows = linear.map((e) => ({
    km: lengthKm(e.geometry),
    start: yearOf(e.tags.start_date),
    end: yearOf(e.tags.end_date),
    nls: /NLS/.test(e.tags.license || ''),
  }));

  // Snap-points are the LABELLED STOPS on a continuous slider, not discrete
  // snapshots — these are sanity samples, not the render set. The final stop
  // is the current year, resolved at runtime rather than hardcoded.
  const snapPoints = [1825, 1845, 1880, 1923, 1963, 1994, new Date().getUTCFullYear()];
  const aliveAt = {};
  for (const y of snapPoints) {
    const alive = rows.filter((r) => r.start !== null && r.start <= y && (r.end === null || r.end >= y));
    aliveAt[y] = {
      ways: alive.length,
      km: Math.round(alive.reduce((a, r) => a + r.km, 0)),
      nls_km: Math.round(alive.filter((r) => r.nls).reduce((a, r) => a + r.km, 0)),
    };
  }

  return {
    total_km: Math.round(rows.reduce((a, r) => a + r.km, 0)),
    nls_km: Math.round(rows.filter((r) => r.nls).reduce((a, r) => a + r.km, 0)),
    undated_km: Math.round(rows.filter((r) => r.start === null).reduce((a, r) => a + r.km, 0)),
    alive_at: aliveAt,
  };
}

function toMarkdown(report) {
  const L = [];
  L.push('# OHM coverage census — historical map slider');
  L.push('');
  L.push(`Generated: ${report.generated_at}`);
  L.push(`Scope: ${report.scope}`);
  L.push(`OHM data timestamp: ${report.osm3s_timestamp || '(not reported)'}`);
  L.push('');
  L.push('Regenerate with `node scripts/scope-ohm-coverage.mjs`. Report only — writes nothing else.');
  L.push('');
  L.push('## Counts');
  L.push('');
  L.push('| Query | Result |');
  L.push('|---|---:|');
  for (const [k, v] of Object.entries(report.counts)) L.push(`| ${k} | ${v} |`);
  L.push('');
  if (report.tag_analysis) {
    const a = report.tag_analysis;
    L.push('## Lines — date coverage');
    L.push('');
    L.push(`Linear track ways: **${a.linear_ways}** (of ${a.all_railway_ways} railway ways).`);
    L.push('');
    L.push('| | ways | % of linear |');
    L.push('|---|---:|---:|');
    for (const [k, v] of Object.entries(a.date_coverage)) {
      if (typeof v === 'object') L.push(`| ${k} | ${v.n} | ${v.pct ?? ''} |`);
      else L.push(`| ${k} | ${v} | |`);
    }
    L.push('');
    L.push('## Lines — era bands');
    L.push('');
    L.push('| band | alive | with operator | with name | with company-like name |');
    L.push('|---|---:|---:|---:|---:|');
    for (const [k, v] of Object.entries(a.era_bands)) {
      L.push(`| ${k} | ${v.alive} | ${v.with_operator} | ${v.with_name} | ${v.with_company_like_name} |`);
    }
    L.push('');
    L.push('## Licence census');
    L.push('');
    for (const [k, v] of Object.entries(a.licences)) L.push(`- \`${k}\` — ${v} elements`);
    L.push('');
    if (a.unexpected_licences.length) {
      L.push('> **BLOCKER — unexpected licence value(s) present.** Review before any extract:');
      for (const l of a.unexpected_licences) L.push(`> - \`${l}\``);
    } else {
      L.push('No unexpected licence values — everything is CC0 or the known NLS CC-BY.');
    }
    L.push('');
  }
  if (report.geometry_analysis) {
    const g = report.geometry_analysis;
    L.push('## Lines — length by era');
    L.push('');
    L.push(`Total: **${g.total_km} km** (NLS CC-BY share: ${g.nls_km} km; undated, hidden: ${g.undated_km} km)`);
    L.push('');
    L.push('| snap-point | ways alive | km alive | of which NLS CC-BY |');
    L.push('|---:|---:|---:|---:|');
    for (const [y, v] of Object.entries(g.alive_at)) L.push(`| ${y} | ${v.ways} | ${v.km} | ${v.nls_km} |`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

async function runCensus() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`OHM coverage census — scope: ${USE_BBOX ? 'LEGACY BBOX (includes Ireland)' : 'GB polygon clip'}`);
  if (USE_BBOX) console.log('  WARNING: bbox mode includes the island of Ireland. Reproduction only.');

  const report = {
    generated_at: new Date().toISOString(),
    scope: USE_BBOX ? `legacy bbox ${LEGACY_BBOX}` : `GB clip via OHM areas ${JSON.stringify(GB_AREAS)}`,
    endpoint: OHM_OVERPASS,
    counts: {},
  };

  let tagElements = null;
  for (const q of QUERIES) {
    const json = await overpass(q.ql(), q.key);
    report.osm3s_timestamp = report.osm3s_timestamp || (json.osm3s && json.osm3s.timestamp_osm_base);
    if (q.kind === 'count') {
      const c = json.elements.find((e) => e.type === 'count');
      report.counts[q.key] = c ? Number(c.tags.total) : 0;
    } else {
      tagElements = json.elements;
      report.counts[q.key] = json.elements.length;
    }
  }

  // A stale/renamed boundary relation returns zero rather than erroring, so
  // fail loudly instead of writing a report full of confident zeroes.
  if (!USE_BBOX && report.counts.lines_total === 0) {
    throw new Error(
      'GB area clip returned 0 railway ways. The GB_AREAS relation ids are almost certainly stale — ' +
        're-check them on openhistoricalmap.org before trusting any output.',
    );
  }

  if (tagElements) report.tag_analysis = analyseTags(tagElements);

  if (WANT_GEOMETRY) {
    console.log('  GEOMETRY=1 — downloading full geometry (~21 MB, slow)...');
    const json = await overpass(`${GEOMETRY_QUERY.ql()}\nout geom;`, 'lines_geometry');
    writeFileSync(GEOMETRY_DUMP_PATH, JSON.stringify(json));
    report.geometry_analysis = analyseGeometry(json.elements);
    report.geometry_dump = path.relative(ROOT, GEOMETRY_DUMP_PATH);
  }

  writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(REPORT_MD_PATH, toMarkdown(report));
  console.log(`\nWrote ${path.relative(ROOT, REPORT_JSON_PATH)} and ${path.relative(ROOT, REPORT_MD_PATH)}`);

  const unexpected = report.tag_analysis && report.tag_analysis.unexpected_licences;
  if (unexpected && unexpected.length) {
    console.log('\n*** BLOCKER: unexpected license=* value(s) found in OHM data ***');
    for (const l of unexpected) console.log('   ', l);
    console.log('    Review these before using this extract — see this script\'s licence header.');
  }
}

// Note: `out count;` / `out tags;` are appended by each query's own QL above
// via the wrappers below rather than baked into gbScoped(), so the same
// scoped statement can be reused for counts, tags and geometry.
for (const q of QUERIES) {
  const base = q.ql;
  q.ql = () => `${base()}\nout ${q.kind === 'count' ? 'count' : 'tags'};`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCensus().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

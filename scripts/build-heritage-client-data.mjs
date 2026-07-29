#!/usr/bin/env node
/**
 * build-heritage-client-data.mjs — derive data/heritage-railways.json (the
 * client-side heritage lookup) from HERITAGE_META.
 *
 * WHY THIS EXISTS. The retiled operators.pmtiles carries `heritage_slug` and
 * `band` per segment, but NOT the display name — and PMTiles `tilestats` caps
 * its value list at 100 while there are 169 distinct slugs, so the tileset
 * cannot even enumerate the railways, let alone name them. map.html therefore
 * needs a client-readable slug -> {name, band, dot placement} lookup, and this
 * script generates it so HERITAGE_META stays the single source of truth for
 * slug/type/band and nothing can drift between the tiles and the client.
 *
 * PIPELINE STAGE. This reads scripts/lib/heritage-canonical.mjs (a hand-curated
 * constant) plus the segment graph for dot placement. The graph read is only
 * used to locate termini, so the pre/post-dedupe distinction documented in
 * CLAUDE.md's stage table does not change any output figure here — but run it
 * after dedupe anyway, for the same reason as everything else: one stage, one
 * set of numbers.
 *
 * DOT PLACEMENT is meant to be the railway's principal station or visitor
 * entrance — deliberately NOT the geometric midpoint, which for a branch line
 * lands in a field. Nothing in this repo records heritage station locations
 * (they are not National Rail, so they are absent from NaPTAN), so placement is
 * derived in three descending tiers of confidence and EVERY entry is written
 * with `placement_confirmed: false`. None of these are hand-verified; the field
 * exists so a reviewer can flip them one at a time.
 *
 *   naptan-200m      A National Rail station within 200m of the railway's
 *                    track. Often genuinely correct, because some heritage
 *                    termini ARE in NaPTAN as interchanges (Grosmont,
 *                    Porthmadog Harbour, Alton, Keighley). 34 railways
 *                    (32 by primary attribution, +2 recovered by keying on all
 *                    attributed railways rather than heritage_railways[0]).
 *   naptan-1km       Nearest National Rail station 200m-1km away. Weaker: this
 *                    may be a nearby town's station rather than the railway's
 *                    own, or an incidental crossing of a live line.
 *   terminus         No station within 1km. Falls back to the railway's own
 *                    TERMINUS (a track endpoint used by exactly one segment),
 *                    choosing whichever terminus is closest to any National
 *                    Rail station — that biases toward the settlement end of
 *                    the line, which is usually where the visitor entrance and
 *                    car park are. A terminus is not a midpoint, so this still
 *                    honours the placement rule, but it carries no station NAME
 *                    (principal_station stays null).
 *
 * Usage: node scripts/build-heritage-client-data.mjs [--report]
 *        --report prints the full candidate list for review.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HERITAGE_META, HERITAGE_CANONICAL } from './lib/heritage-canonical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const STATIONS_PATH = path.join(ROOT, 'station-list.json');
const OUT_PATH = path.join(ROOT, 'data', 'heritage-railways.json');

const NAPTAN_STRONG_M = 200;
const NAPTAN_WEAK_M = 1000;

// Planar approximation, same reasoning as dedupe-line-segments.mjs.
const metres = (a, b) =>
  Math.hypot((a[0] - b[0]) * Math.cos((a[1] * Math.PI) / 180) * 111320, (a[1] - b[1]) * 111320);

const segments = JSON.parse(readFileSync(SEG_PATH, 'utf8')).segments.filter((s) => s.heritage_slug);
const stations = JSON.parse(readFileSync(STATIONS_PATH, 'utf8')).filter((s) => s.lat != null && s.lon != null);

// Group by EVERY railway a segment is attributed to, not just heritage_railways[0].
// 47 segments carry more than one heritage railway (shared approach track), and
// 5 railways — Ludgershall Branch and Plym Valley among them — appear ONLY as a
// secondary. Keying on [0] alone silently left those 5 with no dot at all.
const segsByRailway = new Map();
for (const s of segments) {
  for (const key of s.heritage_railways) {
    if (!segsByRailway.has(key)) segsByRailway.set(key, []);
    segsByRailway.get(key).push(s);
  }
}

/**
 * flyTo zoom that frames the whole railway: aim for the line spanning ~60% of a
 * nominal 800px viewport, then clamp. Clamped at 16 because a 200m micro
 * railway would otherwise want z18, which is closer than the basemap has useful
 * detail for and reads as "lost"; clamped at 10 so a 43km trunk railway still
 * lands somewhere recognisable rather than a county view.
 */
function zoomForKm(km) {
  if (!km) return 15; // dot-only railway: no line to frame, go in close
  const targetMpp = (km * 1000) / (0.6 * 800);
  const z = Math.log2((156543.03392 * Math.cos((53 * Math.PI) / 180)) / targetMpp);
  return Math.max(10, Math.min(16, Math.round(z * 2) / 2));
}

/** Termini = endpoint nodes used by exactly one of this railway's segments. */
function termini(segs) {
  const count = new Map();
  const coordOf = new Map();
  for (const s of segs) {
    for (const idx of [0, s.nodes.length - 1]) {
      const n = String(s.nodes[idx]);
      count.set(n, (count.get(n) || 0) + 1);
      coordOf.set(n, s.coords[idx]);
    }
  }
  const ends = [...count.entries()].filter(([, c]) => c === 1).map(([n]) => coordOf.get(n));
  // A pure loop (no degree-1 node) has no terminus — fall back to any endpoint
  // so placement never returns nothing.
  return ends.length ? ends : [segs[0].coords[0]];
}

function nearestStation(pts) {
  let best = { distM: Infinity, station: null };
  for (const st of stations) {
    const sc = [st.lon, st.lat];
    for (const p of pts) {
      const d = metres(p, sc);
      if (d < best.distM) best = { distM: d, station: st };
    }
  }
  return best;
}

const out = {};
const rows = [];
for (const [name, meta] of Object.entries(HERITAGE_META)) {
  const segs = segsByRailway.get(name) || [];
  const noLine = !meta.km;

  // Sample the track for the proximity test — every 5th vertex is ample at
  // 200m/1km thresholds and keeps this from being O(coords x 2629).
  const trackPts = [];
  for (const s of segs) for (let i = 0; i < s.coords.length; i += 5) trackPts.push(s.coords[i]);

  let center = null, source = 'none', principal = null, distM = null;
  if (trackPts.length) {
    const near = nearestStation(trackPts);
    distM = Math.round(near.distM);
    if (near.distM <= NAPTAN_STRONG_M) {
      center = [round6(near.station.lon), round6(near.station.lat)];
      principal = near.station.name;
      source = 'naptan-200m';
    } else if (near.distM <= NAPTAN_WEAK_M) {
      center = [round6(near.station.lon), round6(near.station.lat)];
      principal = near.station.name;
      source = 'naptan-1km';
    } else {
      // Pick the terminus closest to any National Rail station — see the header
      // note on why that biases usefully toward the visitor entrance.
      const ends = termini(segs);
      let bestEnd = ends[0], bestD = Infinity;
      for (const e of ends) {
        const d = nearestStation([e]).distM;
        if (d < bestD) { bestD = d; bestEnd = e; }
      }
      center = [round6(bestEnd[0]), round6(bestEnd[1])];
      source = 'terminus';
    }
  }

  const entry = {
    name,
    type: meta.type,
    band: meta.band,
    km: meta.km,
    zoom: zoomForKm(meta.km),
    placement_source: source,
    placement_confirmed: false,
  };
  if (meta.secondary) entry.type_secondary = meta.secondary;
  if (center) entry.center = center;
  if (principal) entry.principal_station = principal;
  // Dot-only railways: no track was found for them, so there is no line for the
  // dot to hand over to and the dot must never fade. See map.html's
  // heritageDotOpacity() for the rendering side of this exemption.
  if (noLine) entry.no_line = true;
  // No track anywhere in the graph means no coordinate to derive — these need a
  // hand-supplied center before they can be drawn at all. map.html skips any
  // entry without one rather than guessing.
  if (!segs.length) { entry.not_in_graph = true; entry.needs_coordinates = true; }

  out[meta.slug] = entry;
  rows.push({ slug: meta.slug, name, band: meta.band, km: meta.km, source, principal, distM, noLine, inGraph: segs.length > 0 });
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

// Searchable variants: every raw OSM string that canonicalises to this railway,
// minus the canonical name itself. Sourced from HERITAGE_CANONICAL so search and
// the tiles agree on what counts as the same railway — one source of truth, per
// the same rule the colour table follows.
const variantsByCanonical = new Map();
for (const [variant, canonical] of Object.entries(HERITAGE_CANONICAL)) {
  if (variant === canonical) continue;
  if (!variantsByCanonical.has(canonical)) variantsByCanonical.set(canonical, new Set());
  variantsByCanonical.get(canonical).add(variant);
}
for (const [name, meta] of Object.entries(HERITAGE_META)) {
  const v = variantsByCanonical.get(name);
  if (v && v.size) out[meta.slug].aliases = [...v].sort();
}

// Flat, slug-keyed, _notes at top level — the same shape as data/regions.json,
// so loadJsonContent()'s existing _notes-stripping yields the lookup directly
// with no wrapper to unwrap on the client.
const payload = {
  _notes:
    'Client-side heritage railway lookup — display name, category, length band, dot placement and search aliases, keyed by the same heritage_slug that operators.pmtiles carries per segment. GENERATED by scripts/build-heritage-client-data.mjs from scripts/lib/heritage-canonical.mjs (HERITAGE_META + HERITAGE_CANONICAL); do not hand-edit except to confirm placements. placement_confirmed is false on every entry until a human verifies the dot sits on the railway\'s principal station or visitor entrance — placement_source records how the coordinate was guessed (naptan-200m strongest, then naptan-1km, then terminus). no_line marks railways with no measurable track, whose dot must never fade because there is no line to hand over to.',
  ...out,
};
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n');

const bySource = {};
for (const r of rows) bySource[r.source] = (bySource[r.source] || 0) + 1;
console.log(`Wrote ${Object.keys(out).length} railways to ${path.relative(ROOT, OUT_PATH)}`);
console.log('Placement sources:', JSON.stringify(bySource));
console.log(`Dot-only (no_line): ${rows.filter((r) => r.noLine).length} · not in graph: ${rows.filter((r) => !r.inGraph).length}`);
console.log('ALL placements are placement_confirmed:false — review required.');

if (process.argv.includes('--report')) {
  const order = { 'naptan-200m': 0, 'naptan-1km': 1, terminus: 2, none: 3 };
  rows.sort((a, b) => (order[a.source] - order[b.source]) || (a.distM ?? 1e9) - (b.distM ?? 1e9) || a.name.localeCompare(b.name));
  console.log('\n' + 'slug'.padEnd(42) + 'band'.padEnd(10) + 'km'.padEnd(8) + 'source'.padEnd(14) + 'dist'.padEnd(9) + 'candidate station');
  console.log('-'.repeat(140));
  for (const r of rows) {
    console.log(
      r.slug.padEnd(42) + r.band.padEnd(10) + String(r.km).padEnd(8) + r.source.padEnd(14) +
      (r.distM === null ? '—' : r.distM + 'm').padEnd(9) +
      (r.principal || (r.noLine ? '(dot-only, no track)' : '(unnamed terminus)'))
    );
  }
}

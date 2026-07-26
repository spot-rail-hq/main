/**
 * scripts/lib/historical-era.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Shared primitives for the historical map slider pipeline, extracted so
 * build-big4-lookup.mjs, build-historical-lines.mjs and
 * build-historical-stations.mjs cannot drift apart on the three things that
 * MUST agree between them: how a date string becomes a year, how a company
 * name is normalized for lookup, and which licences are allowed through the
 * extract. Same reasoning as scripts/lib/operator-classify.mjs — see that
 * file's header for the precedent.
 *
 * Full context for every decision encoded here: HISTORICAL-SLIDER-FINDINGS.md
 * (Phase 1, 1B and 2A).
 */

// ─── Era bands ────────────────────────────────────────────────────────────
// The four colour bands. `modern`'s upper bound is the CURRENT YEAR resolved
// at runtime, never a hardcoded literal — the slider's final labelled stop
// moves with the calendar.
//
// IMPORTANT: these bands are NOT stored per feature. Phase 1B measured that
// 94.5% of dated OHM lines span more than one band and 50% span all four, so
// a per-feature era_band would be wrong for almost every feature in the set.
// Band is a property of the SLIDER POSITION, computed globally at render
// time; these bounds exist here so the build scripts can flatten per-band
// company attribution into the co_* fields (see LINE_COMPANY_FIELDS below),
// not so anything can be stamped with a single band.
export const ERA_BANDS = [
  { key: 'pre1923', from: 0, to: 1922 },
  { key: 'big4', from: 1923, to: 1947 },
  { key: 'br', from: 1948, to: 1993 },
  { key: 'modern', from: 1994, to: null }, // null upper bound = current year
];

export function currentYear() {
  return new Date().getUTCFullYear();
}

export function eraBandForYear(year) {
  for (const b of ERA_BANDS) {
    const to = b.to === null ? currentYear() : b.to;
    if (year >= b.from && year <= to) return b.key;
  }
  return null;
}

// The four flattened, nullable per-band company fields carried on every line
// feature so a MapLibre paint expression can pick one with a plain property
// read instead of a range test. See build-historical-lines.mjs for how each
// is populated and why co_modern is null on OHM-sourced features.
export const LINE_COMPANY_FIELDS = ['co_pre1923', 'co_big4', 'co_br', 'co_modern'];

// The BR band is a single nationalised operator, so its company value is a
// constant rather than a lookup. This is why Phase 1's finding that "British
// Railways" appears exactly once in OHM's GB tags turned out not to matter.
export const BR_COMPANY_NAME = 'British Railways';

// ─── Date parsing ─────────────────────────────────────────────────────────
// Phase 1 surveyed 18,331 OHM date values and found them essentially clean:
// 69% YYYY-MM-DD, 22% YYYY, 4% YYYY-MM, and exactly ONE malformed value
// ("18341", a typo for 1834). A four-digit prefix match is therefore
// sufficient and no fuzzy date parser is warranted. Anything that does not
// start with a plausible 3-4 digit year returns null and the caller decides
// whether that means "hide" (lines) or "unknown" (stations).
const YEAR_PREFIX = /^-?(\d{3,4})(?!\d)/;

export function parseYear(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).trim().match(YEAR_PREFIX);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  // Sanity window: GB railways start in the 1560s (Wollaton wagonway) at the
  // absolute earliest, and a date beyond next year is a typo, not a plan.
  if (y < 1500 || y > currentYear() + 1) return null;
  return y;
}

// Distinguishes "we know the exact day" from "we know only the year". Both
// count as `exact` for slider purposes (the slider resolves to years), but
// the distinction is recorded so a future UI can phrase it honestly — see
// HISTORICAL-SLIDER-FINDINGS.md §1B-6 on why "exact" is an ambiguous word.
export function datePrecisionOf(value) {
  if (value === null || value === undefined || String(value).trim() === '') return 'unknown';
  return parseYear(value) === null ? 'unknown' : 'exact';
}

// ─── Company-name normalization ───────────────────────────────────────────
// Used on BOTH sides of the Big Four lookup — the constituent list parsed
// from the Railways Act 1921, and the raw `name` tag on an OHM way. Both
// sides must normalize identically or the match rate collapses silently.
//
// Handles the specific inconsistencies Phase 1 catalogued in real OHM data:
//   - "&" vs "and"       (Lanarkshire & Ayrshire vs Liverpool and Manchester)
//   - branch suffixes    ("North London Railway-Poplar Branch",
//                         "Lanarkshire & Ayrshire Railway - Irvine Branch")
//   - Wikipedia disambiguators ("South Eastern Railway (England)")
//   - punctuation/casing drift
export function normalizeCompanyName(name) {
  if (!name) return '';
  return String(name)
    .replace(/\s*\(.*?\)\s*/g, ' ') // drop wikipedia disambiguators
    .replace(/\s*[-–—]\s*[^-–—]*\b(branch|loop|curve|spur|extension|line|railway)\b\s*$/i, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A `name` tag that plausibly names a COMPANY rather than a route. Phase 1
// found 28.7% of linear ways carry one of these ("Liverpool and Manchester
// Railway") while a further 15.3% carry a modern route name ("Settle-Carlisle
// Line") — a different kind of string in the same field.
const COMPANY_NAME_RE = /\b(Railway|Railways|Railroad|Rly)\b/i;

export function looksLikeCompanyName(name) {
  return !!name && COMPANY_NAME_RE.test(name);
}

// ─── Licence allow-list ───────────────────────────────────────────────────
// OHM is CC0 by default, but its copyright policy lets contributors override
// that per element with a `license=*` tag, and in GB 1,898 railway elements
// do exactly that (National Library of Scotland tracings, CC-BY, attribution
// REQUIRED). Phase 1B's recommendation was that the extract must not merely
// detect an unexpected licence but REFUSE it — a future CC-BY-NC element
// would otherwise be absorbed invisibly into a commercially-monetised map.
//
// Keys are the literal `license=*` tag values as they appear in OHM. An
// element with no license tag inherits OHM's CC0 default.
export const LICENCE_ALLOW_LIST = {
  __default__: {
    code: 'CC0-1.0',
    label: 'CC0 1.0 Universal (public domain dedication)',
    attribution_required: false,
    attribution_string: '© OpenHistoricalMap contributors',
  },
  CC0: {
    code: 'CC0-1.0',
    label: 'CC0 1.0 Universal (public domain dedication)',
    attribution_required: false,
    attribution_string: '© OpenHistoricalMap contributors',
  },
  'CC-BY (NLS): Reproduced with the permission of the National Library of Scotland': {
    code: 'CC-BY-4.0',
    label: 'Creative Commons Attribution 4.0',
    attribution_required: true,
    attribution_string:
      'Reproduced with the permission of the National Library of Scotland',
  },
};

export class LicenceNotAllowedError extends Error {
  constructor(values) {
    super(
      `Unexpected license=* value(s) in the OHM extract — refusing to build.\n` +
        values.map((v) => `  - ${JSON.stringify(v)}`).join('\n') +
        `\n\nThis is the Phase 1B licence gate. A value not on the allow-list may be ` +
        `non-commercial or share-alike, which would be incompatible with this site. ` +
        `Review it, and if it is genuinely safe add it to LICENCE_ALLOW_LIST in ` +
        `scripts/lib/historical-era.mjs with its exact required attribution string.`,
    );
    this.name = 'LicenceNotAllowedError';
    this.values = values;
  }
}

// Returns the allow-list entry for an element, or throws if the element
// carries a licence nobody has reviewed. `licenseTag` is the raw tag value
// (or undefined/null when the element inherits the CC0 default).
export function resolveLicence(licenseTag) {
  const key = licenseTag === undefined || licenseTag === null || licenseTag === ''
    ? '__default__'
    : licenseTag;
  const entry = LICENCE_ALLOW_LIST[key];
  if (!entry) throw new LicenceNotAllowedError([licenseTag]);
  return entry;
}

// ─── GB clip ──────────────────────────────────────────────────────────────
// OHM's OWN current England / Scotland / Wales admin_level=4 relations,
// chosen over an OSM boundary (ODbL — using it to spatially filter CC0 data
// arguably creates a Derivative Database and drags share-alike onto the
// output) and over OS Boundary-Line (OGL v3, fine but needs a download, an
// OSGB36 reprojection and a second attribution line). Keeping the clip inside
// OHM means the whole line pipeline sits under one licence.
//
// These are the CURRENT (no end_date) polygons, deliberately fixed for all
// eras — clipping 1923 data to 1923 borders would make lines blink in and out
// as historical borders moved under them.
//
// Overpass area id = relation id + 3600000000. VERIFY on a refresh: a stale
// id returns ZERO features rather than erroring, so every caller must assert
// on a zero result.
export const GB_AREAS = {
  england: 3602874395,
  scotland: 3602874396,
  wales: 3602697730,
};

export const OHM_OVERPASS = 'https://overpass-api.openhistoricalmap.org/api/interpreter';
export const USER_AGENT =
  'SpotRailHQ-content-script/1.0 (+https://srhq.uk; static JSON build step, not a live API dependency)';

// railway=* values that are LINEAR TRACK, as opposed to the station
// buildings, platforms, turntables, signal boxes and yards that also carry a
// railway tag (201 of 13,655 GB ways in Phase 1).
export const LINEAR_RAILWAY_VALUES = new Set([
  'rail', 'light_rail', 'narrow_gauge', 'tram', 'subway', 'monorail',
  'funicular', 'miniature', 'preserved', 'disused', 'abandoned', 'razed',
  'construction', 'proposed',
]);

export function isLinearRailway(tags) {
  return !!tags && LINEAR_RAILWAY_VALUES.has(tags.railway) && tags.area !== 'yes';
}

// Builds the GB-clipped Overpass QL preamble + a per-nation union of the
// given statement. Overpass has no union-of-areas filter, so repeating the
// statement per area is the normal idiom.
export function gbScopedQuery(statement, outMode) {
  const setup = Object.entries(GB_AREAS)
    .map(([name, id]) => `area(${id})->.${name};`)
    .join('\n');
  const body = Object.keys(GB_AREAS)
    .map((name) => `  ${statement}(area.${name});`)
    .join('\n');
  return `${setup}\n(\n${body}\n);\nout ${outMode};`;
}

export async function overpass(ql, { timeout = 900 } = {}) {
  const res = await fetch(OHM_OVERPASS, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: `[out:json][timeout:${timeout}];\n${ql}\n` }).toString(),
  });
  if (!res.ok) throw new Error(`OHM Overpass HTTP ${res.status}`);
  return res.json();
}

// ─── GB point-in-polygon clip ─────────────────────────────────────────────
// The locked scope decision is "clip with a real boundary polygon, not a
// bbox". For LINES that happens server-side (Overpass `(area.…)` filters, see
// gbScopedQuery above). For STATIONS the candidates come from Wikipedia
// categories rather than Overpass, so the same clip has to be applied
// locally — hence a real ray-casting test against OHM's own boundary
// geometry, not a rectangle.
//
// Wikipedia's "…in Great Britain" categories are already meant to exclude
// Northern Ireland, but Phase 1B found they are not perfectly policed, so
// this is the enforcing filter rather than a formality.
//
// Boundary geometry is fetched once and cached by the caller; assembling it
// means chaining member ways into closed rings, since Overpass returns a
// relation's members as individual unordered (and sometimes reversed) ways.

export function assembleRings(relationElements) {
  const outer = [];
  const inner = [];
  for (const rel of relationElements) {
    const byRole = { outer: [], inner: [] };
    for (const m of rel.members || []) {
      if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
      // An empty role on a boundary relation means outer by convention.
      (m.role === 'inner' ? byRole.inner : byRole.outer).push(
        m.geometry.map((g) => [g.lon, g.lat]),
      );
    }
    for (const [role, segments] of Object.entries(byRole)) {
      for (const ring of chainSegments(segments)) {
        (role === 'inner' ? inner : outer).push(withBbox(ring));
      }
    }
  }
  return { outer, inner };
}

// Chains unordered, possibly-reversed line segments into closed rings by
// matching endpoints. Segments that never close are still returned — a
// coastline relation can legitimately be missing a member, and dropping an
// unclosed ring silently would quietly shrink the clip.
function chainSegments(segments) {
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const remaining = segments.map((s) => s.slice());
  const rings = [];
  while (remaining.length) {
    let ring = remaining.pop();
    let extended = true;
    while (extended) {
      extended = false;
      if (key(ring[0]) === key(ring[ring.length - 1])) break; // closed
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        const tail = key(ring[ring.length - 1]);
        if (key(seg[0]) === tail) {
          ring = ring.concat(seg.slice(1));
        } else if (key(seg[seg.length - 1]) === tail) {
          ring = ring.concat(seg.slice(0, -1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function withBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { ring, bbox: [minX, minY, maxX, maxY] };
}

function pointInRing(lon, lat, { ring, bbox }) {
  if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function makeGbContainsFn(boundaryElements) {
  const { outer, inner } = assembleRings(boundaryElements);
  if (!outer.length) {
    throw new Error(
      'GB boundary assembled to zero outer rings — the OHM boundary relations changed shape. ' +
        'Do not fall back to a bbox; fix the assembly first.',
    );
  }
  return function gbContains(lon, lat) {
    if (!outer.some((r) => pointInRing(lon, lat, r))) return false;
    return !inner.some((r) => pointInRing(lon, lat, r));
  };
}

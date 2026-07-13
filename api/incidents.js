/**
 * api/incidents.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Feeds the "Live news" urgent/disruption items on the map page.
 * Source: Rail Delivery Group / Rail Data Marketplace "Knowledgebase
 * Incidents" feed (RSPS5050 §10, schema v5.0) — returns XML, not JSON.
 *
 * GET /api/incidents
 * Returns: [{
 *   id, summary, toc, severity, timestamp, affectedCRS: [], link,
 *   operators: [],   // every affected operator's display name (or ref if
 *                     // name absent) — `toc` above is just operators[0],
 *                     // kept for backwards compatibility with existing UI
 *   regions: [],      // subset of ['north','midlands','south','wcml','ecml',
 *                     // 'gwr','heritage'] — see computeRegions() below
 *   routesAffected,   // free-text Affects.RoutesAffected, if present
 * }, ...]
 */

const INCIDENTS_URL = 'https://api1.raildata.org.uk/1010-knowlegebase-incidents-xml-feed1_0/incidents.xml';
const FETCH_TIMEOUT_MS = 8000;

// ─── Lightweight XML helpers (mirrors api/news.js's regex-based approach —
// this project has no npm dependencies, so no XML library is pulled in) ────

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Strips any raw markup that survives entity-decoding — the incident text is
// free-form editorial content from an external feed, and the frontend drops
// n.summary into innerHTML unescaped, so this is the only sanitisation point.
function stripTags(str) {
  return str.replace(/<[^>]*>/g, '');
}

// Free-text fields (Summary, Description) are wrapped in CDATA on the real
// feed. Without unwrapping first, stripTags' `<[^>]*>` greedily matches from
// `<![CDATA[` to the final `]]>` as if it were one tag — since the text
// inside rarely contains a literal `>` — and deletes the entire payload,
// leaving an empty string. This was silently discarding every non-cleared
// incident (Summary always came back '').
function unwrapCdata(str) {
  const m = str.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : str;
}

function cleanText(raw) {
  if (!raw) return '';
  return decodeEntities(stripTags(unwrapCdata(raw))).replace(/\s+/g, ' ').trim();
}

// Tag matching tolerates an optional namespace prefix (e.g. <ns2:PtIncident>)
// since it's unconfirmed whether the live feed namespaces its elements.
function extractTag(block, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function extractBlocks(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/(?:[\\w-]+:)?${tag}>`, 'gi');
  return xml.match(re) || [];
}

// ─── Incidents-specific mapping ────────────────────────────────────────────

// IncidentPriority's scale isn't documented in RSPS5050 (the Integer field has
// no description). The presence of a sibling `P0Summary` field strongly implies
// 0 is the highest-severity class (standard P0/P1/P2 incident-priority
// convention), so lower numbers are treated as more urgent here. Unplanned
// disruptions without a usable priority are treated as urgent by default.
// Verify this against real incidents after deploy — see deployment notes.
function computeSeverity(priorityRaw, plannedRaw) {
  const priority = priorityRaw !== '' && !isNaN(Number(priorityRaw)) ? Number(priorityRaw) : null;
  if (priority !== null) {
    if (priority <= 0) return 3;
    if (priority === 1) return 2;
    return 1;
  }
  const planned = /^true$/i.test(plannedRaw.trim());
  return planned ? 1 : 2;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London',
  }).format(d);
}

// Affects > Operators > AffectedOperator[] — first operator's brand name
// stands in for the frontend's `toc` field (there is no per-incident region
// field in this schema, only free-text RoutesAffected and TOC codes).
function extractOperatorName(block) {
  const affects = extractTag(block, 'Affects');
  if (!affects) return '';
  const operators = extractTag(affects, 'Operators');
  if (!operators) return '';
  const opBlocks = extractBlocks(operators, 'AffectedOperator');
  if (!opBlocks.length) return '';
  const name = cleanText(extractTag(opBlocks[0], 'OperatorName'));
  return name || cleanText(extractTag(opBlocks[0], 'OperatorRef'));
}

function extractLink(block) {
  const infoLinks = extractTag(block, 'InfoLinks');
  if (!infoLinks) return '';
  const linkBlocks = extractBlocks(infoLinks, 'InfoLink');
  if (!linkBlocks.length) return '';
  return cleanText(extractTag(linkBlocks[0], 'Uri'));
}

// Affects > Operators > AffectedOperator[] — every affected operator's
// display name (falling back to its 2-char ref if the name is absent), for
// region-tagging (below) and for the map page's station/route entity filter
// to cross-reference against stations-content.json / routes-content.json.
function extractAllOperators(block) {
  const affects = extractTag(block, 'Affects');
  if (!affects) return [];
  const operators = extractTag(affects, 'Operators');
  if (!operators) return [];
  return extractBlocks(operators, 'AffectedOperator').map((opBlock) => {
    const name = cleanText(extractTag(opBlock, 'OperatorName'));
    return name || cleanText(extractTag(opBlock, 'OperatorRef'));
  }).filter(Boolean);
}

// Affects > RoutesAffected — free text, e.g. "ScotRail between Milngavie /
// Helensburgh Central and Edinburgh". Used as a fallback signal when TOC
// mapping alone doesn't produce a region, and by the map page's route-entity
// filter as a secondary match against a route's name/stations.
function extractRoutesAffected(block) {
  const affects = extractTag(block, 'Affects');
  if (!affects) return '';
  return cleanText(extractTag(affects, 'RoutesAffected'));
}

// ─── TOC → region lookup (Task: geographic filter chips) ──────────────────
// Region categories are the map page's existing, fixed filter-chip set:
// north / midlands / south / wcml / ecml / gwr / heritage. These don't map
// cleanly onto how TOCs actually serve the network (a chip mixes broad
// geography with three specific named main lines), so most operators carry
// more than one tag, and — flagged explicitly, not silently guessed — some
// legitimate operators have NO matching tag because the chip set has no
// bucket for them:
//   - ScotRail / Caledonian Sleeper: Scotland has no chip of its own.
//     Caledonian Sleeper gets 'wcml' since it explicitly runs that route
//     overnight to London; ScotRail gets nothing.
//   - Transport for Wales: Wales has no chip of its own. Cross-border Marches
//     Line services (Birmingham/Manchester–Wales) justify a light 'midlands'
//     tag, but the core Wales network isn't represented by any chip.
//   - Heritage: the Knowledgebase Incidents feed covers National Rail TOCs,
//     not standalone heritage railways (they don't report incidents to NRE).
//     The one plausible match is West Coast Railway Company (charter/steam
//     operator, e.g. the Jacobite, which does run on the mainline network).
//     Expect this chip to stay empty or near-empty in real data.
// Matched by display NAME first (normalized, case/whitespace-insensitive —
// this is what the parser already prefers from the feed), with the 2-char
// ATOC/TOC code as a secondary fallback. Code accuracy for the less common
// operators below is not independently verified against a live sample —
// spot-check against real incident data if a code-only match ever misfires.
const TOC_REGION_TABLE = [
  { code: 'VT', names: ['Avanti West Coast'], regions: ['wcml', 'north', 'midlands', 'south'] },
  { code: 'GR', names: ['LNER', 'London North Eastern Railway'], regions: ['ecml', 'north', 'south'] },
  { code: 'XC', names: ['CrossCountry', 'Cross Country', 'Arriva CrossCountry'], regions: ['north', 'midlands', 'south'] },
  { code: 'EM', names: ['East Midlands Railway'], regions: ['midlands', 'south'] },
  { code: 'WM', names: ['West Midlands Railway'], regions: ['midlands'] },
  { code: 'LN', names: ['London Northwestern Railway'], regions: ['midlands', 'wcml', 'south'] },
  { code: 'GW', names: ['Great Western Railway', 'GWR'], regions: ['gwr', 'south'] },
  { code: 'SW', names: ['South Western Railway'], regions: ['south'] },
  { code: 'SE', names: ['Southeastern'], regions: ['south'] },
  { code: 'SN', names: ['Southern'], regions: ['south'] },
  { code: 'TL', names: ['Thameslink'], regions: ['south'] },
  { code: 'GX', names: ['Gatwick Express'], regions: ['south'] },
  { code: 'GN', names: ['Great Northern'], regions: ['south', 'ecml'] },
  { code: 'CC', names: ['c2c'], regions: ['south'] },
  { code: 'CH', names: ['Chiltern Railways'], regions: ['south', 'midlands'] },
  { code: 'LE', names: ['Greater Anglia'], regions: ['south'] },
  { code: 'NT', names: ['Northern'], regions: ['north'] },
  { code: 'TP', names: ['TransPennine Express'], regions: ['north', 'ecml'] },
  { code: 'ME', names: ['Merseyrail'], regions: ['north'] },
  { code: 'SR', names: ['ScotRail'], regions: [] }, // flagged above — no Scotland chip
  { code: 'CS', names: ['Caledonian Sleeper'], regions: ['wcml'] },
  { code: 'GC', names: ['Grand Central'], regions: ['ecml', 'north'] },
  { code: 'HT', names: ['Hull Trains'], regions: ['ecml', 'north'] },
  { code: 'LD', names: ['Lumo'], regions: ['ecml', 'north'] },
  { code: 'HX', names: ['Heathrow Express'], regions: ['south', 'gwr'] },
  { code: 'XR', names: ['Elizabeth line'], regions: ['south'] },
  { code: 'AW', names: ['Transport for Wales', 'Trafnidiaeth Cymru'], regions: ['midlands'] }, // flagged above — no Wales chip
  { code: 'IL', names: ['Island Line'], regions: ['south'] },
  { code: 'WR', names: ['West Coast Railway Company'], regions: ['heritage'] },
];

function normalizeOperatorKey(str) {
  return (str || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

const REGIONS_BY_NAME = new Map();
const REGIONS_BY_CODE = new Map();
TOC_REGION_TABLE.forEach((entry) => {
  entry.names.forEach((name) => REGIONS_BY_NAME.set(normalizeOperatorKey(name), entry.regions));
  if (entry.code) REGIONS_BY_CODE.set(entry.code.toUpperCase(), entry.regions);
});

// Fallback only — fires when TOC mapping produces nothing for this incident.
// Deliberately scoped to the three NAMED CORRIDORS the filter chips actually
// represent (WCML/ECML/GWR), not a general place-name gazetteer for
// north/midlands/south — that would be a much larger, much less reliable
// guess than what was asked for.
const CORRIDOR_KEYWORDS = [
  { regions: ['wcml'], keywords: ['west coast main line', 'west coast mainline'] },
  { regions: ['ecml'], keywords: ['east coast main line', 'east coast mainline'] },
  { regions: ['gwr'], keywords: ['great western main line', 'great western mainline', 'great western route'] },
];

function computeRegions(operatorNames, routesAffectedText) {
  const regions = new Set();
  operatorNames.forEach((raw) => {
    const key = normalizeOperatorKey(raw);
    const byName = REGIONS_BY_NAME.get(key);
    if (byName) {
      byName.forEach((r) => regions.add(r));
      return;
    }
    const byCode = REGIONS_BY_CODE.get((raw || '').toUpperCase());
    if (byCode) byCode.forEach((r) => regions.add(r));
  });

  if (regions.size === 0 && routesAffectedText) {
    const text = routesAffectedText.toLowerCase();
    CORRIDOR_KEYWORDS.forEach((entry) => {
      if (entry.keywords.some((kw) => text.indexOf(kw) !== -1)) {
        entry.regions.forEach((r) => regions.add(r));
      }
    });
  }

  return Array.from(regions);
}

function parseIncidents(xml) {
  const blocks = extractBlocks(xml, 'PtIncident');
  let clearedCount = 0;
  let emptySummaryCount = 0;
  const incidents = [];

  for (const block of blocks) {
    const clearedRaw = extractTag(block, 'ClearedIncident');
    if (/^true$/i.test(clearedRaw.trim())) {
      clearedCount += 1;
      continue;
    }

    const summary = cleanText(extractTag(block, 'Summary'));
    if (!summary) {
      emptySummaryCount += 1;
      continue;
    }

    const operators = extractAllOperators(block);
    const routesAffected = extractRoutesAffected(block);

    incidents.push({
      id: cleanText(extractTag(block, 'IncidentNumber')) || undefined,
      summary,
      toc: extractOperatorName(block) || undefined,
      severity: computeSeverity(extractTag(block, 'IncidentPriority'), extractTag(block, 'Planned')),
      timestamp: formatTimestamp(cleanText(extractTag(block, 'CreationTime'))),
      affectedCRS: [],
      link: extractLink(block) || undefined,
      operators,
      regions: computeRegions(operators, routesAffected),
      routesAffected: routesAffected || undefined,
    });
  }

  return { incidents, totalCount: blocks.length, clearedCount, emptySummaryCount };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  const apiKey = process.env.KNOWLEDGEBASE_API_KEY;
  if (!apiKey) {
    console.error('incidents: KNOWLEDGEBASE_API_KEY is not set');
    return res.status(200).json([]);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let xml;
  try {
    const upstream = await fetch(INCIDENTS_URL, {
      signal: controller.signal,
      // Confirmed quirk (per Rail Data Marketplace product reviews): the
      // upstream rejects requests without an explicit empty User-Agent.
      headers: { 'x-apikey': apiKey, 'User-Agent': '' },
    });
    if (!upstream.ok) {
      throw new Error(`HTTP ${upstream.status}`);
    }
    xml = await upstream.text();
  } catch (err) {
    console.error('incidents: fetch failed —', err && err.message);
    return res.status(200).json([]);
  } finally {
    clearTimeout(timer);
  }

  if (!/<(?:[\w-]+:)?Incidents\b/i.test(xml)) {
    console.error('incidents: response is not recognisable Incidents XML (possible auth/upstream error). First 300 chars:', xml.slice(0, 300));
    return res.status(200).json([]);
  }

  let result;
  try {
    result = parseIncidents(xml);
  } catch (err) {
    console.error('incidents: parse failed —', err && err.message);
    return res.status(200).json([]);
  }

  console.log(`incidents: ${result.incidents.length} active incident(s) (${result.totalCount} total, ${result.clearedCount} cleared, ${result.emptySummaryCount} excluded: empty summary)`);
  return res.status(200).json(result.incidents);
}

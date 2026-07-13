/**
 * api/incidents.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Feeds the "Live news" urgent/disruption items on the map page.
 * Source: Rail Delivery Group / Rail Data Marketplace "Knowledgebase
 * Incidents" feed (RSPS5050 §10, schema v5.0) — returns XML, not JSON.
 *
 * GET /api/incidents
 * Returns: [{
 *   id, summary, toc, severity, affectedCRS: [], link,
 *   timestamp,        // "HH:MM · D MMM YYYY" (Europe/London), e.g. "14:32 · 13 Jul 2026"
 *   operators: [],   // every affected operator's display name (or ref if
 *                     // name absent) — `toc` above is just operators[0],
 *                     // kept for backwards compatibility with existing UI
 *   regions: [],      // subset of ['north','midlands','south','scotland',
 *                     // 'wales','wcml','ecml','gwr','heritage'] — see
 *                     // computeRegions() below
 *   routesAffected,   // free-text Affects.RoutesAffected, if present
 * }, ...]
 *
 * severity>=2 ("Urgent"): Planned===false AND not long-range-future-dated
 * (ValidityPeriod's end more than ~2 days out) — see computeSeverity().
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

// PtIncident > ValidityPeriod[] (RSPS5050 §10.2.3.3, structure defined in
// §11.2.18 "Half Open Timestamp Range Structure") — a MANDATORY, repeatable
// field carrying each period's StartTime (mandatory) / EndTime (optional;
// per spec, an omitted EndTime means the period is open-ended, "until
// further notice"). This is the real, structured validity-period field the
// schema provides — confirmed present in RSPS5050 P-03-00 Rev A before
// writing any of the date logic below, so no free-text fallback against
// Summary was needed for this feed.
function extractValidityPeriods(block) {
  return extractBlocks(block, 'ValidityPeriod').map((vp) => ({
    startTime: cleanText(extractTag(vp, 'StartTime')),
    endTime: cleanText(extractTag(vp, 'EndTime')),
  }));
}

// The latest EndTime across all of an incident's ValidityPeriod entries
// (there can be more than one — Mult=Y). Returns null if every period is
// open-ended (no EndTime given anywhere), which is treated as "no known
// far-future end" rather than as long-range — an open-ended live fault
// ("until further notice") is a different thing from a dated closure
// months out, and shouldn't be penalized the same way.
function latestValidityEnd(validityPeriods) {
  let latest = null;
  validityPeriods.forEach((vp) => {
    if (!vp.endTime) return;
    const d = new Date(vp.endTime);
    if (isNaN(d.getTime())) return;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  });
  return latest;
}

const URGENT_MAX_FUTURE_MS = 2 * 24 * 60 * 60 * 1000; // ~2 days, per the "~1-2 days" instruction

// True when this incident's validity period is known to still run more than
// ~2 days from now — i.e. it's a long-scheduled closure/engineering project,
// not something that just started or is wrapping up imminently. This is
// what actually excludes an entry like "Station improvement work... from
// Monday 11 May to Sunday 11 October" from Urgent — Planned alone doesn't
// reliably do that (real data shows Planned===false, or the tag absent,
// even for some multi-month engineering notices).
function isLongRangeFutureDated(validityPeriods, now) {
  const end = latestValidityEnd(validityPeriods);
  if (!end) return false;
  return (end.getTime() - now.getTime()) > URGENT_MAX_FUTURE_MS;
}

// Urgent (severity>=2) now means: NOT a long-range-future-dated closure, AND
// Planned===false. IncidentPriority is kept as a first-class signal (it's
// what the schema names for exactly this) in case it's ever populated, but
// in ~900 live incidents checked in production it never was — every one
// fell through to this fallback, which is why the fallback's own logic is
// what actually matters here, not the priority branch above it.
function computeSeverity(priorityRaw, plannedRaw, validityPeriods, now) {
  const priority = priorityRaw !== '' && !isNaN(Number(priorityRaw)) ? Number(priorityRaw) : null;
  if (priority !== null) {
    if (priority <= 0) return 3;
    if (priority === 1) return 2;
    return 1;
  }
  const planned = /^true$/i.test((plannedRaw || '').trim());
  const longRangeFuture = isLongRangeFutureDated(validityPeriods, now);
  return (!planned && !longRangeFuture) ? 2 : 1;
}

// Now includes the date (not just time) — the Live Updates list routinely
// spans engineering notices months out, not just today, so a bare HH:MM was
// ambiguous about which day an item actually refers to.
function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London',
  }).format(d);
  const date = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London',
  }).format(d);
  return time + ' · ' + date;
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
// Region categories are the map page's filter-chip set: north / midlands /
// south / scotland / wales / wcml / ecml / gwr / heritage. scotland/wales
// were added after the first pass flagged that ScotRail and Transport for
// Wales had nowhere honest to go (ScotRail got no tag at all; TfW got a
// stretch-fit 'midlands' tag for its England-border services only) — see
// git history for that flagged state if useful context. With real chips now
// available: ScotRail is tagged 'scotland' outright. Transport for Wales is
// tagged 'wales' (replacing the midlands stretch-fit, per instruction —
// its genuine Marches-line crossover into Shrewsbury/Crewe/Manchester is
// real but secondary to its core network, so it's not carrying a midlands
// tag alongside). A handful of other operators with well-known, unambiguous
// Scotland or Wales service also picked up the matching tag in this pass
// (Avanti West Coast, LNER, CrossCountry, TransPennine Express and Lumo all
// terminate in Glasgow/Edinburgh/Aberdeen; Caledonian Sleeper's whole
// purpose is overnight London–Scotland so it keeps 'wcml' too; GWR's South
// Wales main line to Cardiff/Swansea is equally well-established). This is
// not an exhaustive re-audit of every operator's full network — only these
// clear, uncontroversial cases were added; anything more marginal was left
// alone rather than guessed at.
//
// The chip set still mixes broad geography with three named main lines, so
// most operators carry more than one tag. One category remains genuinely
// under-served: Heritage. The Knowledgebase Incidents feed covers National
// Rail TOCs, not standalone heritage railways (they don't report incidents
// to NRE) — the one plausible match is West Coast Railway Company
// (charter/steam operator, e.g. the Jacobite, which does run on the
// mainline network). Expect this chip to stay empty or near-empty in real
// data; that's a feed-coverage limit, not a mapping bug.
//
// Matched by display NAME first (normalized, case/whitespace-insensitive —
// this is what the parser already prefers from the feed), with the 2-char
// ATOC/TOC code as a secondary fallback. Code accuracy for the less common
// operators below is not independently verified against a live sample —
// spot-check against real incident data if a code-only match ever misfires.
const TOC_REGION_TABLE = [
  { code: 'VT', names: ['Avanti West Coast'], regions: ['wcml', 'north', 'midlands', 'south', 'scotland'] },
  { code: 'GR', names: ['LNER', 'London North Eastern Railway'], regions: ['ecml', 'north', 'south', 'scotland'] },
  { code: 'XC', names: ['CrossCountry', 'Cross Country', 'Arriva CrossCountry'], regions: ['north', 'midlands', 'south', 'scotland'] },
  { code: 'EM', names: ['East Midlands Railway'], regions: ['midlands', 'south'] },
  { code: 'WM', names: ['West Midlands Railway'], regions: ['midlands'] },
  { code: 'LN', names: ['London Northwestern Railway'], regions: ['midlands', 'wcml', 'south'] },
  { code: 'GW', names: ['Great Western Railway', 'GWR'], regions: ['gwr', 'south', 'wales'] },
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
  { code: 'TP', names: ['TransPennine Express'], regions: ['north', 'ecml', 'scotland'] },
  { code: 'ME', names: ['Merseyrail'], regions: ['north'] },
  { code: 'SR', names: ['ScotRail'], regions: ['scotland'] },
  { code: 'CS', names: ['Caledonian Sleeper'], regions: ['wcml', 'scotland'] },
  { code: 'GC', names: ['Grand Central'], regions: ['ecml', 'north'] },
  { code: 'HT', names: ['Hull Trains'], regions: ['ecml', 'north'] },
  { code: 'LD', names: ['Lumo'], regions: ['ecml', 'north', 'scotland'] },
  { code: 'HX', names: ['Heathrow Express'], regions: ['south', 'gwr'] },
  { code: 'XR', names: ['Elizabeth line'], regions: ['south'] },
  { code: 'AW', names: ['Transport for Wales', 'Trafnidiaeth Cymru'], regions: ['wales'] },
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

function parseIncidents(xml, now) {
  const blocks = extractBlocks(xml, 'PtIncident');
  let clearedCount = 0;
  let emptySummaryCount = 0;
  let noValidityEndCount = 0; // how many active incidents had no parseable ValidityPeriod EndTime at all
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
    const validityPeriods = extractValidityPeriods(block);
    if (!latestValidityEnd(validityPeriods)) noValidityEndCount += 1;

    incidents.push({
      id: cleanText(extractTag(block, 'IncidentNumber')) || undefined,
      summary,
      toc: extractOperatorName(block) || undefined,
      severity: computeSeverity(extractTag(block, 'IncidentPriority'), extractTag(block, 'Planned'), validityPeriods, now),
      timestamp: formatTimestamp(cleanText(extractTag(block, 'CreationTime'))),
      affectedCRS: [],
      link: extractLink(block) || undefined,
      operators,
      regions: computeRegions(operators, routesAffected),
      routesAffected: routesAffected || undefined,
    });
  }

  return { incidents, totalCount: blocks.length, clearedCount, emptySummaryCount, noValidityEndCount };
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
    result = parseIncidents(xml, new Date());
  } catch (err) {
    console.error('incidents: parse failed —', err && err.message);
    return res.status(200).json([]);
  }

  const urgentCount = result.incidents.filter((n) => n.severity >= 2).length;
  console.log(`incidents: ${result.incidents.length} active incident(s) (${result.totalCount} total, ${result.clearedCount} cleared, ${result.emptySummaryCount} excluded: empty summary) — ${urgentCount} urgent, ${result.noValidityEndCount} with no ValidityPeriod end date (open-ended)`);
  return res.status(200).json(result.incidents);
}

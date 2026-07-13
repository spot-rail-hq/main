/**
 * api/incidents.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Feeds the "Live news" urgent/disruption items on the map page.
 * Source: Rail Delivery Group / Rail Data Marketplace "Knowledgebase
 * Incidents" feed (RSPS5050 §10, schema v5.0) — returns XML, not JSON.
 *
 * GET /api/incidents
 * Returns: [{ id, summary, toc, severity, timestamp, affectedCRS: [], link }, ...]
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

// TEMP DEBUG — remove once the empty-summary root cause is confirmed fixed
// in production. Logs raw (pre-clean) field values for a sample of incidents
// that get excluded, so a bad assumption in the parser is visible in Vercel
// logs instead of guessed at.
const DEBUG_SAMPLE_LIMIT = 5;

function parseIncidents(xml) {
  const blocks = extractBlocks(xml, 'PtIncident');
  let clearedCount = 0;
  let emptySummaryCount = 0;
  let debugLogged = 0;
  const incidents = [];

  for (const block of blocks) {
    const clearedRaw = extractTag(block, 'ClearedIncident');
    if (/^true$/i.test(clearedRaw.trim())) {
      clearedCount += 1;
      continue;
    }

    const summaryRaw = extractTag(block, 'Summary');
    const summary = cleanText(summaryRaw);

    if (!summary) {
      emptySummaryCount += 1;
      if (debugLogged < DEBUG_SAMPLE_LIMIT) {
        debugLogged += 1;
        console.log('incidents: DEBUG excluded (empty summary after cleaning) —', JSON.stringify({
          incidentNumber: cleanText(extractTag(block, 'IncidentNumber')),
          clearedRaw,
          summaryTagFound: summaryRaw !== '',
          summaryRawSnippet: summaryRaw.slice(0, 200),
        }));
      }
      continue;
    }

    incidents.push({
      id: cleanText(extractTag(block, 'IncidentNumber')) || undefined,
      summary,
      toc: extractOperatorName(block) || undefined,
      severity: computeSeverity(extractTag(block, 'IncidentPriority'), extractTag(block, 'Planned')),
      timestamp: formatTimestamp(cleanText(extractTag(block, 'CreationTime'))),
      affectedCRS: [],
      link: extractLink(block) || undefined,
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

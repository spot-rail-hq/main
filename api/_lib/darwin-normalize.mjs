/**
 * api/_lib/darwin-normalize.mjs
 * ─────────────────────────────────────────────────────────────────
 * Normalises a raw Darwin LDBWS GetDepBoardWithDetails REST response (see
 * api/darwin-departures.js) into the stable internal shape departures.html
 * (and, later, map.html once it migrates off RTT) renders. Kept as its own
 * Node-importable module — rather than inlined in the serverless handler —
 * specifically so scripts/tests/darwin-departures-harness.mjs can run it
 * directly against a saved fixture with no live API call and no server.
 *
 * Shape decided against a real GetDepBoardWithDetails response for BHM and
 * LST (fixtures/darwin-departures/) — see that investigation for what was
 * and wasn't present live. Notably: Darwin's `platform` is a single flat
 * string with no confirmed/provisional tiers (unlike RTT's actual/forecast/
 * planned), so nothing here reconstructs that distinction.
 */

// ─── nrccMessages sanitiser ─────────────────────────────────────────────
// Board-level disruption notices come back as a short HTML fragment, e.g.
// '<p>No trains between&nbsp;X and&nbsp;Y. ... <a href="https://www.
// nationalrail.co.uk/service-disruptions/...">Status and Disruptions</a>.
// </p>' (both forms seen live). This is an unauthenticated third-party feed
// rendered as innerHTML, not plain text, so api/news.js's stripHtml() (a
// blanket tag-strip) is the wrong tool here — it would also kill the
// genuine nationalrail.co.uk link every live message carried. This is a
// small, explicit allowlist instead: only <p> and <a href> (host-checked)
// survive; everything else is dropped but its own text content is kept.
//
// Hostnames live in their own array, not the regex, so the allowlist can be
// widened without touching the parsing logic.
const ALLOWED_NRCC_HOSTS = ['nationalrail.co.uk'];

// Duplicated from api/news.js's decodeEntities() (same repo, same shape)
// rather than extracted into a shared module — matches this repo's existing
// per-file-standalone convention for /api functions (see the RTT token-
// exchange logic already duplicated between api/departures.js and
// api/map-departures.js). Used narrowly here: to decode a candidate href's
// entities (e.g. "&amp;" in a query string) before URL-parsing it for host
// validation — the ORIGINAL still-encoded attribute text is what actually
// gets re-emitted, never the decoded form, so this never re-introduces raw
// "&"/"<" into the output HTML.
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

function isAllowedNrccHref(rawHref) {
  let url;
  try {
    url = new URL(decodeEntities(rawHref));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return ALLOWED_NRCC_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
}

// Not a full HTML parser — a lightweight regex pass over a short, known-
// shape message fragment, same class of solution as api/news.js's own
// tag-handling. Only recognises double-quoted attributes (both live
// samples used them); anything it doesn't recognise as an allowed tag is
// dropped, never passed through unmodified.
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+\s*=\s*"[^"]*")*)\s*\/?>/g;

export function sanitizeNrccHtml(raw) {
  if (!raw) return '';
  let openAllowedAnchor = false;
  return raw.replace(TAG_RE, (match, closing, tag, attrs) => {
    const tagLower = tag.toLowerCase();
    if (tagLower === 'p') return closing ? '</p>' : '<p>';
    if (tagLower === 'a') {
      if (closing) {
        if (openAllowedAnchor) {
          openAllowedAnchor = false;
          return '</a>';
        }
        return ''; // closing tag with no corresponding kept opening tag
      }
      const hrefMatch = attrs.match(/\bhref\s*=\s*"([^"]*)"/i);
      if (hrefMatch && isAllowedNrccHref(hrefMatch[1])) {
        openAllowedAnchor = true;
        return '<a href="' + hrefMatch[1] + '" target="_blank" rel="noopener noreferrer">';
      }
      return ''; // disallowed/missing href — drop the tag, keep the link text
    }
    return ''; // any other tag — drop it, keep its text content
  });
}

// ─── status discriminator ───────────────────────────────────────────────
// Precedence order, first match wins. futureCancellation/futureDelay are
// deliberately NOT part of this chain — they describe a later calling
// point on this service's own route, not the state of the departure from
// this station — see resolveService() below, where they're passed through
// as their own separate booleans instead.
//
// 'delayed-no-estimate', 'no-report' and the plain-'Cancelled'-string branch
// were never observed live in either fixture — Darwin's documented schema
// defines them, so they're implemented as real, reachable states rather
// than silently folded into 'unknown', but they're untested against real
// upstream data.
const HHMM_RE = /^\d{1,2}:\d{2}$/;

export function resolveStatus(service) {
  if (service.isCancelled === true || service.filterLocationCancelled === true) {
    return { status: 'cancelled', estimatedTime: null };
  }
  const etd = service.etd;
  if (etd === 'On time') return { status: 'on-time', estimatedTime: null };
  if (typeof etd === 'string' && HHMM_RE.test(etd)) return { status: 'delayed', estimatedTime: etd };
  if (etd === 'Delayed') return { status: 'delayed-no-estimate', estimatedTime: null };
  if (etd === 'Cancelled') return { status: 'cancelled', estimatedTime: null };
  if (etd === 'No report') return { status: 'no-report', estimatedTime: null };
  return { status: 'unknown', estimatedTime: null };
}

// ─── coach count ─────────────────────────────────────────────────────────
// Two different, operator-dependent sources seen live, and they don't
// co-occur: some services carry a full formation.coaches[] array, others
// only a flat integer `length`, plenty carry neither. `0` is a real,
// distinguishable live value here (Darwin's own way of saying "unknown"),
// so it is never reused as an "absent" sentinel — absence is always `null`,
// never `0` and never invented.
function resolveCoachCount(service) {
  const coaches = service.formation && Array.isArray(service.formation.coaches) ? service.formation.coaches : null;
  if (coaches && coaches.length > 0) {
    return { coachCount: coaches.length, coachCountSource: 'formation' };
  }
  if (Number.isFinite(service.length) && service.length > 0) {
    return { coachCount: service.length, coachCountSource: 'length' };
  }
  return { coachCount: null, coachCountSource: 'none' };
}

// ─── per-coach loading ───────────────────────────────────────────────────
// loadingSpecified is the real gate live data uses: of 20 services fetched
// across BHM+LST, only 1 had ANY coach with loadingSpecified:true — treat
// "no loading data" as the common case, not the fallback.
function normalizeFormation(service) {
  const coaches = service.formation && Array.isArray(service.formation.coaches) ? service.formation.coaches : null;
  if (!coaches || !coaches.length) return null;
  return {
    coaches: coaches.map((c) => ({
      number: c.number != null ? String(c.number) : null,
      coachClass: c.coachClass || null,
      loadingSpecified: c.loadingSpecified === true,
      loadingPercent: c.loadingSpecified === true && Number.isFinite(c.loading) ? c.loading : null,
    })),
  };
}

function normalizeCallingPointGroup(group) {
  return {
    serviceType: group.serviceType || null,
    serviceChangeRequired: group.serviceChangeRequired === true,
    assocIsCancelled: group.assocIsCancelled === true,
    callingPoints: (Array.isArray(group.callingPoint) ? group.callingPoint : []).map((cp) => ({
      locationName: cp.locationName || null,
      crs: cp.crs || null,
      st: cp.st || null,
      et: cp.et || null,
      isCancelled: cp.isCancelled === true,
      length: Number.isFinite(cp.length) ? cp.length : null, // portion-working basis — not rendered yet
      detachFront: cp.detachFront === true,
      affectedByDiversion: cp.affectedByDiversion === true,
      rerouteDelay: Number.isFinite(cp.rerouteDelay) ? cp.rerouteDelay : null,
    })),
  };
}

export function normalizeService(service) {
  const { status, estimatedTime } = resolveStatus(service);
  const { coachCount, coachCountSource } = resolveCoachCount(service);
  const destArr = Array.isArray(service.destination) ? service.destination : [];
  const lastDest = destArr.length ? destArr[destArr.length - 1] : null;

  return {
    serviceId: service.serviceID || null,
    std: service.std || null,
    origin: (Array.isArray(service.origin) ? service.origin : []).map((o) => ({
      locationName: o.locationName || null,
      crs: o.crs || null,
    })),
    destination: (lastDest && lastDest.locationName) || null,
    // "via Stoke-on-Trent" etc. — present on some live destinations, absent
    // on most. Kept as its own field rather than folded into `destination`
    // so the existing collapsed-string field doesn't change shape.
    destinationVia: (lastDest && lastDest.via) || null,
    platform: service.platform || null,
    status,
    estimatedTime,
    operator: service.operator || null,
    operatorCode: service.operatorCode || null,
    isCancelled: service.isCancelled === true,
    futureCancellation: service.futureCancellation === true,
    futureDelay: service.futureDelay === true,
    isReverseFormation: service.isReverseFormation === true,
    detachFront: service.detachFront === true,
    delayReason: service.delayReason || null,
    // Real, confirmed live on cancelled services (e.g. cancelled-lds.json) —
    // same style/shape as delayReason, was previously dropped entirely.
    cancelReason: service.cancelReason || null,
    // Retail Service ID — real, confirmed live on both the board and
    // GetServiceDetails (see fixtures/darwin-departures/service-details-
    // via-rsid.json); not rendered anywhere yet, carried through as free data.
    rsid: service.rsid || null,
    coachCount,
    coachCountSource,
    formation: normalizeFormation(service),
    callingPointGroups: (Array.isArray(service.subsequentCallingPoints) ? service.subsequentCallingPoints : [])
      .map(normalizeCallingPointGroup),
  };
}

export function normalizeBoard(raw) {
  return {
    crs: raw.crs || null,
    locationName: raw.locationName || null,
    generatedAt: raw.generatedAt || null,
    platformAvailable: raw.platformAvailable === true,
    nrccMessages: (Array.isArray(raw.nrccMessages) ? raw.nrccMessages : [])
      .map((m) => ({ html: sanitizeNrccHtml(m && m.Value) }))
      .filter((m) => m.html),
    services: (Array.isArray(raw.trainServices) ? raw.trainServices : []).map(normalizeService),
  };
}

/**
 * api/resolve-address.mjs  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Pure proxy to the standalone CSA journey-search service running on the
 * VPS (srhq-journey-search, Coolify-managed), same shared-secret gate as
 * api/journey-search.mjs — see that file's own docstring for the fuller
 * explanation of this repo's "no logic, no reshaping" convention for
 * anything talking to that service. This file exists as a SEPARATE
 * endpoint rather than a new field on /journey-search's own request body,
 * because the two are genuinely different operations with different
 * response shapes: this one resolves free text to a station + last-mile
 * estimate, /journey-search runs a timetable search between two already-
 * known stations. Keeping them separate means /journey-search's existing
 * request/response contract is untouched by this feature — checked
 * directly, this file changes zero bytes of journey-search.mjs.
 *
 * .mjs, not .js — same reason as api/darwin-departures.mjs and
 * api/journey-search.mjs: this project deliberately has no "type": "module"
 * in package.json, so a plain .js file here would be bundled as CommonJS
 * by Vercel's Node builder.
 *
 * Requires JOURNEY_SEARCH_RESOLVE_URL (the upstream /resolve-address
 * endpoint, e.g. https://<subdomain>.srhq.uk/resolve-address — the same
 * host as JOURNEY_SEARCH_URL, different path, since it's the same
 * srhq-journey-search service) and JOURNEY_SEARCH_KEY (the SAME shared
 * secret journey-search.mjs already uses — this is the same internal
 * service behind the same gate, not a new credential) as Vercel env vars.
 * Neither is hardcoded here. The Mapbox token itself is never read, sent,
 * or exposed here or anywhere client-side — it lives only in the VPS's
 * own env file, read directly by service.py; see this feature's build
 * report (scratchpad/point-to-point-last-mile-build.md) for why that's a
 * different deployment target than the two env vars this file does read.
 *
 * POST /api/resolve-address
 * Body: {"query": "<free-text address or UK postcode>"}
 * Returns: whatever the upstream /resolve-address returns, unchanged —
 * on success, a resolved station plus a walking/cycling last-mile
 * estimate and an affiliate-banner data flag (never banner copy/markup;
 * that's departures.html's own concern, see planAffiliateBannerHtml()).
 */

export default async function handler(req, res) {
  // CORS, matching api/journey-search.mjs's own pattern exactly.
  const origin = req.headers.origin || '';
  const allowedOrigin =
    origin === 'https://srhq.uk' || origin.endsWith('.vercel.app')
      ? origin
      : 'https://srhq.uk';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const upstreamUrl = process.env.JOURNEY_SEARCH_RESOLVE_URL;
  const internalKey = process.env.JOURNEY_SEARCH_KEY;
  if (!upstreamUrl || !internalKey) {
    // Never guess at a URL/key — same distinct, documented shape as
    // journey-search.mjs's own upstream_unavailable.
    return res.status(503).json({ error: 'upstream_unavailable' });
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': internalKey,
      },
      body: JSON.stringify(req.body || {}),
    });

    const text = await upstream.text();

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(text);
  } catch (err) {
    console.error('resolve-address proxy error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }
}

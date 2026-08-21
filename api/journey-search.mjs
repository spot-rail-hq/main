/**
 * api/journey-search.mjs  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Pure proxy to the standalone CSA journey-search service running on the
 * VPS (srhq-journey-search, Coolify-managed, behind its own shared-secret
 * gate — see that repo's service.py). No logic, no reshaping: the request
 * body goes upstream unchanged, the upstream response comes back unchanged.
 *
 * .mjs, not .js — same reason as api/darwin-departures.mjs (see that file's
 * own note): this project deliberately has no "type": "module" in
 * package.json, so a plain .js file here would be bundled as CommonJS by
 * Vercel's Node builder. This file doesn't import an ESM-only local module
 * the way darwin-departures.mjs does, so the ERR_REQUIRE_ESM failure mode
 * doesn't apply here specifically — but .mjs is used anyway to stay
 * consistent with that documented convention rather than re-decide file
 * extension per function.
 *
 * Requires JOURNEY_SEARCH_URL (the upstream /journey-search endpoint, e.g.
 * https://<subdomain>.srhq.uk/journey-search) and JOURNEY_SEARCH_KEY (the
 * shared secret sent as X-Internal-Key) as Vercel env vars. Neither is
 * hardcoded here.
 *
 * POST /api/journey-search
 * Body: {"origin": "...", "destination": "...", "depart_after": "YYYY-MM-DD HH:MM"}
 * Returns: whatever the upstream /journey-search returns, unchanged.
 */

export default async function handler(req, res) {
  // CORS, matching api/spotlight.js's own pattern (the closest existing
  // POST-proxy precedent in this repo — darwin-departures.mjs is GET-only
  // and has no preflight to match).
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

  const upstreamUrl = process.env.JOURNEY_SEARCH_URL;
  const internalKey = process.env.JOURNEY_SEARCH_KEY;
  if (!upstreamUrl || !internalKey) {
    // Never guess at a URL/key — a distinct, documented shape, same pattern
    // as darwin-departures.mjs's own upstream_unavailable.
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
    console.error('journey-search proxy error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }
}

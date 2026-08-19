/**
 * api/darwin-departures.mjs  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Departures board via Darwin LDBWS REST on Rail Data Marketplace —
 * GetDepBoardWithDetails, product 1010-live-departure-board-dep1_2 (note:
 * the product name is plural, "board", the operation is singular,
 * "Board"). Calling points come back inline on this operation, so the
 * board never needs a per-service follow-up call.
 *
 * .mjs, not .js (renamed 2026-08-19): this file imports the ESM-only
 * api/_lib/darwin-normalize.mjs. As a .js file with no "type": "module" in
 * package.json (deliberately absent — see that file's own note on why),
 * Vercel's Node builder bundled this to CommonJS and the bundle's own
 * require() of a real .mjs file threw ERR_REQUIRE_ESM in production —
 * vercel dev didn't reproduce it, so this shipped and broke live. The .mjs
 * extension makes Vercel treat this file itself as ESM regardless of
 * package.json, matching the normaliser it imports. Vercel's filesystem
 * routing maps any api/<name>.{js,mjs,ts,...} to the same /api/<name> path,
 * so this is a zero-behaviour-change fix — confirmed against a locally
 * running `vercel dev`, not assumed.
 *
 * This is the departures.html data source going forward (see CLAUDE.md's
 * "planned" note on the RTT→Darwin move). It does NOT touch
 * api/departures.js or api/map-departures.js — both stay on RTT, live and
 * unmodified, until the map page migrates separately.
 *
 * GetServiceDetails (per-service journey progress, ?serviceId=) is
 * deliberately not implemented here yet — separate follow-up pass.
 *
 * GET /api/darwin-departures?crs=BHM
 * GET /api/darwin-departures?crs=BHM&to=PAD          (filterCrs/filterType=to)
 * GET /api/darwin-departures?crs=BHM&offset=30        (timeOffset)
 * GET /api/darwin-departures?crs=BHM&window=90         (timeWindow, capped at 120)
 * Returns: the normalizeBoard() shape — see api/_lib/darwin-normalize.mjs
 */

import { normalizeBoard } from './_lib/darwin-normalize.mjs';

const BOARD_URL_BASE = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails';

// Darwin's own hard ceiling for this product — confirmed live 2026-08-19:
// requesting numRows=30 *or* numRows=150 against both a quiet station (BHM)
// and one of the busiest London termini (LST) both returned exactly 25
// services, never more. 25 is therefore the real maximum this endpoint will
// ever hand back, not a guess at a "sensible" number — asking for more than
// this does nothing.
const NUM_ROWS = 25;
const MAX_TIME_WINDOW = 120;

function sanitizeCrs(raw) {
  return (raw || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const crs = sanitizeCrs(req.query.crs);
  if (!crs) {
    return res.status(400).json({ error: 'invalid_crs' });
  }

  const apiKey = process.env.DARWIN_LDBWS_KEY;
  if (!apiKey) {
    // Never throw, never return a partial board — a distinct, documented
    // shape the client renders as its own state (departures.html already
    // has renderKeyMissing() for exactly this).
    return res.status(503).json({ error: 'upstream_unavailable' });
  }

  const params = new URLSearchParams();
  params.set('numRows', String(NUM_ROWS));

  const to = sanitizeCrs(req.query.to);
  if (to) {
    params.set('filterCrs', to);
    params.set('filterType', 'to');
  }

  const offsetRaw = parseInt(req.query.offset, 10);
  if (Number.isFinite(offsetRaw)) {
    params.set('timeOffset', String(offsetRaw));
  }

  const windowRaw = parseInt(req.query.window, 10);
  if (Number.isFinite(windowRaw)) {
    params.set('timeWindow', String(Math.min(windowRaw, MAX_TIME_WINDOW)));
  }

  try {
    const upstream = await fetch(`${BOARD_URL_BASE}/${crs}?${params.toString()}`, {
      headers: { 'x-apikey': apiKey, 'Accept': 'application/json' },
    });

    const text = await upstream.text();

    if (upstream.status !== 200) {
      console.error(`Darwin board proxy: ${crs} -> ${upstream.status}: ${text.slice(0, 300)}`);
      return res.status(502).json({ error: 'upstream_error', status: upstream.status });
    }

    let raw;
    try {
      raw = JSON.parse(text);
    } catch (parseErr) {
      console.error('Darwin board proxy: JSON parse failed:', parseErr, text.slice(0, 300));
      return res.status(502).json({ error: 'upstream_error' });
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(200).json(normalizeBoard(raw));
  } catch (err) {
    console.error('Darwin board proxy error:', err);
    return res.status(502).json({ error: 'upstream_error' });
  }
}

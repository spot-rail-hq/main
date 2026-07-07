/**
 * api/config.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Returns public config the map page needs at runtime, so secrets
 * like the Stadia Maps key stay server-side instead of being baked
 * into client-side JS.
 *
 * GET /api/config
 * Returns: { stadiaKey }
 */

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://srhq.uk');
  res.json({
    stadiaKey: process.env.STADIA_API_KEY || '',
  });
}

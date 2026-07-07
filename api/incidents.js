/**
 * api/incidents.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Feeds the "Live news" urgent/disruption items on the map page.
 * Intended source: National Rail Knowledgebase incidents endpoint.
 *
 * TODO: wire up a real DARWIN_TOKEN and the Knowledgebase incidents
 * fetch/parse once credentials are provisioned. Until then this stub
 * returns an empty array so the frontend renders its empty state
 * instead of erroring.
 *
 * GET /api/incidents
 * Returns: [{ id, summary, region, toc, severity, timestamp, affectedCRS: [] }, ...]
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  const darwinToken = process.env.DARWIN_TOKEN;
  if (!darwinToken) {
    return res.status(200).json([]);
  }

  // TODO: fetch + parse the National Rail Knowledgebase incidents feed
  // using darwinToken, then map to { id, summary, region, toc, severity,
  // timestamp, affectedCRS } and return below.
  return res.status(200).json([]);
}

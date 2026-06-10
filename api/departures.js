/**
 * api/departures.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Proxies live departure board requests to the Realtime Trains (RTT)
 * NG API so the RTT bearer token never reaches the browser.
 *
 * GET /api/departures?station=MAN
 * Returns: the raw RTT JSON response
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');

  const token = process.env.RTT_API_KEY;
  if (!token) {
    return res.status(503).json({ error: 'RTT_KEY_MISSING' });
  }

  const stationRaw = (req.query.station || 'EUS').toString().toUpperCase();
  const station = stationRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'EUS';

  const url = `https://data.rtt.io/v1/gb/station/${station}/departures`;

  try {
    const upstream = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });
    console.log(`RTT response status for ${station}: ${upstream.status}`);
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('RTT proxy error:', err);
    return res.status(502).json({ error: 'Request failed' });
  }
}

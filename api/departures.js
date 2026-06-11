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
  res.setHeader('Cache-Control', 's-maxage=30');

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
        'Content-Type': 'application/json',
      },
    });

    const text = await upstream.text();
    console.log(`RTT departures: ${url} -> ${upstream.status}`);

    if (upstream.status !== 200) {
      return res.status(upstream.status).json({
        error: 'RTT_ERROR',
        status: upstream.status,
        body: text.slice(0, 500),
      });
    }

    const data = JSON.parse(text);
    return res.status(200).json(data);
  } catch (err) {
    console.error('RTT proxy error:', err);
    return res.status(502).json({ error: 'Request failed' });
  }
}

/**
 * api/departures.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Proxies live departure board requests to the Realtime Trains (RTT)
 * NG API so the RTT bearer token never reaches the browser.
 *
 * GET /api/departures?station=MAN
 * Returns: the raw RTT JSON response
 */

const RTT_BASE = 'https://data.rtt.io';

async function fetchRtt(url, token) {
  const upstream = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  const text = await upstream.text();
  console.log(`RTT request: ${url} -> ${upstream.status}`);
  console.log(`RTT response body (first 500 chars): ${text.slice(0, 500)}`);
  return { status: upstream.status, text };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=15');

  const token = process.env.RTT_API_KEY;
  if (!token) {
    return res.status(503).json({ error: 'RTT_KEY_MISSING' });
  }

  const stationRaw = (req.query.station || 'EUS').toString().toUpperCase();
  const station = stationRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'EUS';

  try {
    let result = await fetchRtt(`${RTT_BASE}/v1/gb/station/${station}/departures`, token);

    if (result.status !== 200) {
      result = await fetchRtt(`${RTT_BASE}/v1/gb/station/${station}`, token);
    }

    if (result.status !== 200) {
      return res.status(result.status).json({
        error: 'RTT_ERROR',
        status: result.status,
        body: result.text.slice(0, 500),
      });
    }

    let data;
    try {
      data = JSON.parse(result.text);
    } catch (e) {
      return res.status(502).json({
        error: 'RTT_ERROR',
        status: result.status,
        body: result.text.slice(0, 500),
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('RTT proxy error:', err);
    return res.status(502).json({ error: 'Request failed' });
  }
}

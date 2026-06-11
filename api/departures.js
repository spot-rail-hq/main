/**
 * api/departures.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Proxies live departure board requests to the Realtime Trains (RTT)
 * NG API so the RTT bearer token never reaches the browser.
 *
 * RTT NG API uses a two-step auth flow: the RTT_API_KEY is a refresh
 * token that's exchanged for a short-lived access token, which is
 * then used to call the departures endpoint.
 *
 * GET /api/departures?station=MAN
 * Returns: the raw RTT JSON response
 */

let cachedToken = null;
let tokenExpiry = null;

const TOKEN_BUFFER_MS = 60 * 1000;

async function getAccessToken(refreshToken) {
  if (cachedToken && tokenExpiry && tokenExpiry - Date.now() > TOKEN_BUFFER_MS) {
    return { accessToken: cachedToken };
  }

  const tokenResp = await fetch('https://data.rtt.io/api/get_access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${refreshToken}`,
      'Accept': 'application/json',
    },
  });

  const text = await tokenResp.text();
  console.log('Token exchange response:', tokenResp.status, text.substring(0, 200));

  if (tokenResp.status !== 200) {
    console.log('RTT error body:', text.substring(0, 500));
    return { error: tokenResp.status };
  }

  const tokenData = JSON.parse(text);
  cachedToken = tokenData.token;
  tokenExpiry = Date.parse(tokenData.validUntil);
  console.log('Token exchange success, validUntil:', tokenData.validUntil, 'entitlements:', JSON.stringify(tokenData.entitlements));

  return { accessToken: cachedToken };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  const refreshToken = process.env.RTT_API_KEY;
  if (!refreshToken) {
    return res.status(503).json({ error: 'RTT_KEY_MISSING' });
  }

  const stationRaw = (req.query.station || 'EUS').toString().toUpperCase();
  const station = stationRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'EUS';

  try {
    const tokenResult = await getAccessToken(refreshToken);
    if (tokenResult.error) {
      return res.status(tokenResult.error).json({ error: 'AUTH_FAILED', status: tokenResult.error });
    }

    const departureUrls = [
      `https://data.rtt.io/rtt/location?code=gb-nr:${station}`,
      `https://data.rtt.io/gb-nr/location?code=${station}`,
    ];

    let upstream, text, url;
    for (let i = 0; i < departureUrls.length; i++) {
      url = departureUrls[i];
      upstream = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${tokenResult.accessToken}`,
          'Accept': 'application/json',
        },
      });

      text = await upstream.text();
      console.log(`RTT departures: ${url} -> ${upstream.status}`);

      if (upstream.status === 200) break;

      console.log('RTT error body:', text.substring(0, 500));

      if (i === departureUrls.length - 1) {
        return res.status(upstream.status).json({
          error: 'RTT_ERROR',
          status: upstream.status,
          body: text.slice(0, 300),
        });
      }
    }

    const data = JSON.parse(text);
    return res.status(200).json(data);
  } catch (err) {
    console.error('RTT proxy error:', err);
    return res.status(502).json({ error: 'Request failed' });
  }
}

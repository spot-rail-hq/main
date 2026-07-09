/**
 * api/map-departures.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Powers the departure board on the map page (map.html). Was a proxy to
 * Huxley2, a free public Darwin proxy that needed no auth — switched to
 * the Realtime Trains (RTT) NG API after Huxley2's public instance started
 * failing every /departures/{crs} call with HTTP 500 (its own homepage
 * still loads, so this is that instance's Darwin backend/credentials
 * having lapsed, not a transient blip — confirmed against multiple
 * stations). RTT is the same backend api/departures.js already uses
 * successfully for departures.html, via the RTT_API_KEY env var already
 * configured — this file duplicates that token-exchange logic rather than
 * sharing a module, matching this repo's existing per-file-standalone
 * convention for /api functions (see api/news.js, api/departures.js).
 *
 * GET /api/map-departures?crs=BHM
 * GET /api/map-departures?crs=BHM&to=PAD  (RTT's filterTo — next
 *   departures from BHM that subsequently call at PAD, i.e. a from/to board)
 * Returns: [{ scheduledTime, destination, platform, status, etd }, ...]
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

  if (tokenResp.status !== 200) {
    return { error: tokenResp.status };
  }

  const tokenData = await tokenResp.json();
  cachedToken = tokenData.token;
  tokenExpiry = Date.parse(tokenData.validUntil);

  return { accessToken: cachedToken };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  const crsRaw = (req.query.crs || '').toString().toUpperCase();
  const crs = crsRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3);
  if (!crs) {
    return res.status(400).json([]);
  }
  const toRaw = (req.query.to || '').toString().toUpperCase();
  const to = toRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3);

  const refreshToken = process.env.RTT_API_KEY;
  if (!refreshToken) {
    return res.status(200).json([]);
  }

  try {
    const tokenResult = await getAccessToken(refreshToken);
    if (tokenResult.error) {
      return res.status(200).json([]);
    }

    const filterSuffix = to ? `&filterTo=${to}` : '';
    const departureUrls = [
      `https://data.rtt.io/rtt/location?code=gb-nr:${crs}${filterSuffix}`,
      `https://data.rtt.io/gb-nr/location?code=${crs}${filterSuffix}`,
    ];

    let upstream, data;
    for (let i = 0; i < departureUrls.length; i++) {
      upstream = await fetch(departureUrls[i], {
        headers: {
          'Authorization': `Bearer ${tokenResult.accessToken}`,
          'Accept': 'application/json',
        },
      });
      if (upstream.status === 200) {
        data = await upstream.json();
        break;
      }
      if (i === departureUrls.length - 1) {
        return res.status(200).json([]);
      }
    }

    // Same field extraction as departures.html's renderDepartures() (kept
    // in sync deliberately — same upstream shape, same station-board
    // semantics), just producing map.html's flatter row shape server-side
    // instead of departures.html's client-side table-row HTML.
    let services = Array.isArray(data.services) ? data.services : [];
    services = services.filter(s => s.temporalData && s.temporalData.departure).slice(0, 5);

    const departures = services.map(s => {
      const temporalData = s.temporalData || {};
      const dep = temporalData.departure || {};
      const destArr = s.destination || [];
      const lastDest = destArr.length ? destArr[destArr.length - 1] : null;
      const dest = (lastDest && lastDest.location && lastDest.location.description) || 'Unknown';
      const platformInfo = (s.locationMetadata && s.locationMetadata.platform) || {};
      const platform = platformInfo.actual || platformInfo.forecast || platformInfo.planned || '—';

      const cancelled = temporalData.displayAs === 'CANCELLED_CALL' || !!dep.isCancelled;
      let status = 'Scheduled';
      if (cancelled) {
        status = 'Cancelled';
      } else if (dep.realtimeForecast) {
        status = dep.realtimeForecast !== dep.scheduleAdvertised ? 'Delayed' : 'On time';
      }

      const scheduled = dep.scheduleAdvertised || '';
      const tIdx = scheduled.indexOf('T');
      const scheduledTime = tIdx === -1 ? '—' : scheduled.slice(tIdx + 1, tIdx + 6);

      return { scheduledTime, destination: dest, platform, status, etd: status };
    });

    return res.status(200).json(departures);
  } catch (err) {
    console.error('map-departures (RTT) proxy error:', err);
    return res.status(200).json([]);
  }
}

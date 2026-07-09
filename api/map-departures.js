/**
 * api/map-departures.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Powers the departure board on the map page (map.html). Separate from
 * api/departures.js (which uses ?station= against the RTT API for
 * departures.html) — this one takes a CRS code and proxies Huxley2,
 * a free public Darwin proxy that needs no auth for basic lookups.
 *
 * GET /api/map-departures?crs=BHM
 * GET /api/map-departures?crs=BHM&to=PAD  (Huxley2's FilterType.to — next
 *   departures from BHM whose board shows PAD, i.e. a from/to board)
 * Returns: [{ scheduledTime, destination, platform, status, etd }, ...]
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30');

  const crsRaw = (req.query.crs || '').toString().toUpperCase();
  const crs = crsRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3);
  if (!crs) {
    return res.status(400).json({ error: 'MISSING_CRS' });
  }
  const toRaw = (req.query.to || '').toString().toUpperCase();
  const to = toRaw.replace(/[^A-Z0-9]/g, '').slice(0, 3);

  try {
    const upstream = await fetch(
      to
        ? `https://huxley2.azurewebsites.net/departures/${crs}/to/${to}/5`
        : `https://huxley2.azurewebsites.net/departures/${crs}/5`
    );
    if (!upstream.ok) {
      return res.status(upstream.ok ? 200 : 502).json([]);
    }
    const data = await upstream.json();
    const services = Array.isArray(data.trainServices) ? data.trainServices : [];

    const departures = services.map(service => {
      const dest = service.destination && service.destination[0]
        ? service.destination[0].locationName
        : 'Unknown';
      const cancelled = !!service.isCancelled;
      const etd = service.etd || 'On time';
      let status = 'On time';
      if (cancelled) {
        status = 'Cancelled';
      } else if (etd && etd !== 'On time' && /^\d/.test(etd)) {
        status = etd;
      } else if (etd === 'Delayed') {
        status = 'Delayed';
      }
      return {
        scheduledTime: service.std || '',
        destination: dest,
        platform: service.platform || '—',
        status,
        etd,
      };
    });

    return res.status(200).json(departures);
  } catch (err) {
    console.error('map-departures proxy error:', err);
    return res.status(200).json([]);
  }
}

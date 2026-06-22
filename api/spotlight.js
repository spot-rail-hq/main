/**
 * api/spotlight.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Sits between srhq.uk and the Anthropic API so the API key is
 * never exposed in browser source code.
 *
 * POST /api/spotlight
 * Body:    { "className": "Class 390 Pendolino" }
 * Returns: { "text": "<raw JSON string from Claude>" }
 */

export default async function handler(req, res) {

  // ── CORS: allow production domain and Vercel preview URLs ───────
  const origin = req.headers.origin || '';
  const allowedOrigin =
    origin === 'https://srhq.uk' || origin.endsWith('.vercel.app')
      ? origin
      : 'https://srhq.uk';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // ── Input ────────────────────────────────────────────────────────
  const { className } = req.body || {};
  if (!className || typeof className !== 'string') {
    return res.status(400).json({ error: 'Missing className' });
  }
  // Sanitise: strip anything that isn't alphanumeric / spaces / hyphens
  const safe = className.replace(/[^a-zA-Z0-9 \-·\/]/g, '').slice(0, 60);

  // ── API key ──────────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is missing or empty in this environment');
    return res.status(500).json({ error: 'API key not configured' });
  }

  // ── Prompt ───────────────────────────────────────────────────────
  const prompt = `You are a UK railway expert writing for SpotRail HQ, a train enthusiast reference platform.

Write a Class Spotlight entry for: ${safe}

Reply with ONLY a valid JSON object — no markdown fences, no preamble, no trailing text:
{
  "classCode":  "e.g. Class 390",
  "shortName":  "e.g. Pendolino",
  "headline":   "A punchy 8–12 word sentence capturing what makes this class special",
  "intro":      "Two engaging, enthusiast-level sentences introducing the class.",
  "detail":     "One sentence of interesting historical or spotting context.",
  "traction":   "e.g. Electric · 25kV AC overhead",
  "topSpeed":   "e.g. 125 mph",
  "inService":  "e.g. 2002 →",
  "operators":  "e.g. Avanti West Coast",
  "status":     "e.g. In service",
  "tags":       ["tag1","tag2","tag3","tag4"]
}`;

  // ── Call Anthropic ───────────────────────────────────────────────
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',  // fast + cheap for this use case
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      console.error('Anthropic error:', upstream.status, err);
      return res.status(502).json({ error: 'Upstream error' });
    }

    const data      = await upstream.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return res.status(502).json({ error: 'No text in response' });

    // Return just the raw text; the browser parses the JSON
    return res.status(200).json({ text: textBlock.text });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: 'Request failed' });
  }
}

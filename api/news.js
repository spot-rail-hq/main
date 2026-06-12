/**
 * api/news.js  —  Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────────
 * Aggregates UK rail news from a handful of public RSS feeds,
 * parses them with lightweight regex (no XML library), and returns
 * a clean, sorted JSON array for news.html to render.
 *
 * GET /api/news
 * Returns: [{ title, link, source, pubDate, description, image }, ...]
 */

const FEEDS = [
  { url: 'https://www.railwaygazette.com/feed', source: 'Railway Gazette' },
  { url: 'https://railuk.com/feed', source: 'Rail UK' },
  { url: 'https://railadvent.co.uk/feed', source: 'RailAdvent' },
  { url: 'https://news.railbusinessdaily.com/feed', source: 'Rail Business Daily' },
  { url: 'https://www.networkrailmediacentre.co.uk/news.rss', source: 'Network Rail' },
  { url: 'https://www.railtechnologymagazine.com/feed', source: 'Rail Technology Magazine' },
];

const MAX_ITEMS = 30;
const DESCRIPTION_LIMIT = 180;

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Persists across warm invocations on the same Vercel instance (typically
// several minutes). Most page loads after the first return instantly from here
// rather than hitting all 6 RSS feeds. TTL matches s-maxage below.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let _cache = { items: null, builtAt: 0 };

// Per-feed fetch timeout — prevents one slow/hung feed stalling the response
const FEED_TIMEOUT_MS = 7000; // 7 seconds

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

function unwrapCdata(str) {
  const m = str.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] : str;
}

function cleanText(raw) {
  if (!raw) return '';
  return decodeEntities(stripHtml(unwrapCdata(raw))).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function extractLink(block) {
  // RSS 2.0: <link>https://example.com/article</link>
  let m = block.match(/<link(?:\s[^>]*)?>([^<]*)<\/link>/i);
  if (m && m[1].trim()) return decodeEntities(m[1].trim());
  // Atom: <link rel="alternate" href="https://example.com/article" />
  m = block.match(/<link[^>]*\shref=["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1].trim());
  return '';
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max).trim() + '…';
}

function extractImage(block) {
  // <media:content url="..." /> (optionally with type/medium attributes)
  let m = block.match(/<media:content[^>]*\surl=["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1].trim());

  // <enclosure url="..." type="image/..." /> — only use if type starts with "image"
  m = block.match(/<enclosure\b[^>]*>/i);
  if (m) {
    const tag = m[0];
    const urlMatch = tag.match(/\surl=["']([^"']+)["']/i);
    const typeMatch = tag.match(/\stype=["']([^"']+)["']/i);
    if (urlMatch && (!typeMatch || /^image/i.test(typeMatch[1]))) {
      return decodeEntities(urlMatch[1].trim());
    }
  }

  // <image>...</image> — either <image><url>...</url></image> or plain text
  const imageBlock = extractTag(block, 'image');
  if (imageBlock) {
    const urlMatch = imageBlock.match(/<url(?:\s[^>]*)?>([^<]*)<\/url>/i);
    if (urlMatch && urlMatch[1].trim()) return decodeEntities(urlMatch[1].trim());
    const text = cleanText(imageBlock);
    if (text) return text;
  }

  return null;
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi) || [];
  return blocks.map((block) => {
    const title = cleanText(extractTag(block, 'title'));
    const link = extractLink(block);
    const pubDateRaw =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated') ||
      extractTag(block, 'dc:date');
    const descRaw =
      extractTag(block, 'description') ||
      extractTag(block, 'content:encoded') ||
      extractTag(block, 'summary') ||
      extractTag(block, 'content');

    const date = pubDateRaw ? new Date(cleanText(pubDateRaw)) : null;
    const pubDate = date && !isNaN(date.getTime()) ? date.toISOString() : null;

    return {
      title,
      link,
      source,
      pubDate,
      description: truncate(cleanText(descRaw), DESCRIPTION_LIMIT),
      image: extractImage(block),
    };
  }).filter((item) => item.title && item.link);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Edge cache: serve cached response for 15 min, allow stale for 5 min while revalidating
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');

  // ── Serve from in-memory cache if still fresh ────────────────────────────
  const now = Date.now();
  if (_cache.items && (now - _cache.builtAt) < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(_cache.items);
  }

  // ── Fetch all feeds in parallel, each with an individual timeout ─────────
  const results = await Promise.allSettled(FEEDS.map(async (feed) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    try {
      const upstream = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpotRailHQ/1.0; +https://srhq.uk)' },
      });
      if (!upstream.ok) throw new Error(`${feed.source}: HTTP ${upstream.status}`);
      const xml = await upstream.text();
      return parseFeed(xml, feed.source);
    } finally {
      clearTimeout(timer);
    }
  }));

  let items = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items = items.concat(result.value);
    } else {
      console.error(`Feed failed (${FEEDS[i].source}):`, result.reason && result.reason.message);
    }
  });

  items.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  const sliced = items.slice(0, MAX_ITEMS);

  // ── Update in-memory cache (only if we got at least some items) ──────────
  // If all feeds failed, keep any stale cache rather than caching an empty set
  if (sliced.length > 0) {
    _cache = { items: sliced, builtAt: Date.now() };
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(sliced);
  }

  // ── All feeds failed — return stale cache if available, else 502 ─────────
  if (_cache.items) {
    res.setHeader('X-Cache', 'STALE');
    return res.status(200).json(_cache.items);
  }

  return res.status(502).json({ error: 'All RSS feeds unavailable', items: [] });
}

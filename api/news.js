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

const fetchWithTimeout = (url, ms = 5000, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

async function fetchFeed(feed) {
  const upstream = await fetchWithTimeout(feed.url, 5000, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SpotRailHQ/1.0; +https://srhq.uk)' },
  });
  if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
  const xml = await upstream.text();
  return parseFeed(xml, feed.source);
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
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  const results = await Promise.all(
    FEEDS.map(feed => fetchFeed(feed).catch(err => {
      console.error('Feed failed:', feed.source, err.message);
      return [];
    }))
  );

  let items = results.flat();

  items.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  return res.status(200).json(items.slice(0, MAX_ITEMS));
}

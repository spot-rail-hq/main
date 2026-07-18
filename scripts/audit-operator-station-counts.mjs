#!/usr/bin/env node
/**
 * scripts/audit-operator-station-counts.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Read-only audit — does not modify operators-content.json. For every
 * operator, fetches its wikipedia_title's raw infobox wikitext (balanced-
 * brace extraction, same technique used live 2026-07-19 for the GW/AW
 * fixes) and compares:
 *   - infobox `abbr=` against this operator's own internal key — a
 *     mismatch (or an abbr listing MULTIPLE keys, e.g. GTR's
 *     "abbr = GN, GX, SN, TL") means the Wikipedia article describes a
 *     BROADER or DIFFERENT entity than this specific operator, so its
 *     stationsop figure isn't a like-for-like comparison at all (the
 *     Greater Thameslink Railway / GN case, confirmed live 2026-07-19 —
 *     not a bug, a documented deliberate exception, see operators-
 *     content.json's own _notes).
 *   - infobox `stationsop=` against our own stations_operated (OSM-derived
 *     live count) — for informational comparison only, even when the abbr
 *     matches; some divergence here is the already-understood GW/AW-style
 *     "served vs managed" methodology difference, not necessarily a bug.
 *
 * Run:
 *   node scripts/audit-operator-station-counts.mjs
 *
 * Writes scripts/output/operator-station-count-audit.json.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OPERATORS_PATH = path.join(ROOT, 'operators-content.json');
const OUTPUT_PATH = path.join(__dirname, 'output', 'operator-station-count-audit.json');

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'SpotRailHQ-content-script/1.0 (+https://srhq.uk; audit script, not a live API dependency)';
const REQUEST_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractInfobox(wikitext) {
  const startIdx = wikitext.search(/\{\{Infobox/i);
  if (startIdx === -1) return null;
  let depth = 0;
  let i = startIdx;
  let end = -1;
  while (i < wikitext.length) {
    if (wikitext.slice(i, i + 2) === '{{') {
      depth++;
      i += 2;
      continue;
    }
    if (wikitext.slice(i, i + 2) === '}}') {
      depth--;
      i += 2;
      if (depth === 0) {
        end = i;
        break;
      }
      continue;
    }
    i++;
  }
  return end === -1 ? null : wikitext.slice(startIdx, end);
}

// Matches "|param = value", stopping at whichever comes FIRST: a newline, a
// <ref ...> citation tag, or a {{ template call (efn footnotes, {{nowrap}},
// etc all start here) — not just the next bare "|", which is unsafe: a
// citation or footnote template embeds its OWN pipe-delimited parameters
// inline right after the value with no newline first (e.g.
// "|abbr = WMR<ref>{{cite web | date=... | url=...}}</ref>"), so a plain
// "stop at next |" regex truncates mid-citation and returns garbage. Only
// good for single-line scalar params (abbr, stationsop) — NOT multi-line/
// templated params (franchise, regions, fleet), which still need the manual
// balanced-template handling already done for GW/AW/GN by hand.
function extractParam(infobox, param) {
  // (?:^|\n)\| not a bare \| — a bare pipe matches ANY "|" anywhere, including
  // one belonging to a totally unrelated NESTED template's own parameter
  // (confirmed live: Northern Trains' infobox has no top-level "abbr" param
  // at all, but its |length= field is {{convert|3180|km|mi|abbr=in}} — that
  // inner convert-template's own "abbr" (meaning "abbreviate the unit", km
  // vs kilometres) matched first and returned "in", nowhere close to the
  // real reporting-mark concept this script actually wants). Anchoring to
  // "start of line, then |" restricts matches to genuine top-level infobox
  // parameters. [ \t]* not \s* around "=" for the same blank-field reason as
  // before — \s also matches newlines.
  const re = new RegExp(`(?:^|\\n)\\|[ \\t]*${param}[ \\t]*=[ \\t]*`, 'i');
  const m = infobox.match(re);
  if (!m) return null;
  const rest = infobox.slice(m.index + m[0].length);
  const stop = rest.search(/\n|<ref\b|\{\{/);
  const raw = stop === -1 ? rest : rest.slice(0, stop);
  const trimmed = raw.trim();
  return trimmed || null;
}

async function fetchInfobox(title) {
  const url = `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&titles=${encodeURIComponent(title)}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const data = await res.json();
  const page = data.query && data.query.pages && Object.values(data.query.pages)[0];
  if (!page || page.missing !== undefined) return { error: 'page not found' };
  const rev = page.revisions && page.revisions[0];
  const wikitext = rev && rev.slots && rev.slots.main && rev.slots.main['*'];
  if (!wikitext) return { error: 'no wikitext' };
  const infobox = extractInfobox(wikitext);
  if (!infobox) return { error: 'no infobox template found on page' };
  return { infobox, resolvedTitle: page.title };
}

async function main() {
  const operators = JSON.parse(readFileSync(OPERATORS_PATH, 'utf8'));
  const keys = Object.keys(operators).filter((k) => k !== '_notes');
  const results = [];
  console.log(`Auditing ${keys.length} operators...`);
  for (const key of keys) {
    const entry = operators[key];
    if (!entry.wikipedia_title) {
      results.push({ key, name: entry.name, status: 'no-wikipedia-title' });
      console.log(`  ${key}: no wikipedia_title — skipped`);
      continue;
    }
    const { infobox, resolvedTitle, error } = await fetchInfobox(entry.wikipedia_title);
    await sleep(REQUEST_DELAY_MS);
    if (error) {
      results.push({ key, name: entry.name, wikipedia_title: entry.wikipedia_title, status: 'fetch-error', error });
      console.log(`  ${key}: ${error}`);
      continue;
    }
    // Different infobox template variants use different param names for the
    // same concept — confirmed live: Northern Trains' article uses
    // "Infobox rail" with `marks = NT`, not `abbr =` at all.
    const abbr = extractParam(infobox, 'abbr') || extractParam(infobox, 'marks');
    const stationsop = extractParam(infobox, 'stationsop');
    const abbrList = abbr ? abbr.split(/[,/]/).map((s) => s.replace(/\{\{efn.*$/i, '').trim()).filter(Boolean) : [];
    const scopeMatches = abbrList.length === 0 ? 'unknown' : abbrList.length === 1 && abbrList[0].toUpperCase() === key.toUpperCase() ? 'match' : abbrList.map((a) => a.toUpperCase()).includes(key.toUpperCase()) && abbrList.length > 1 ? 'shared-with-others' : 'mismatch-or-different-entity';
    results.push({
      key,
      name: entry.name,
      wikipedia_title: resolvedTitle,
      ourCount: entry.stations_operated || null,
      wikipediaStationsop: stationsop || null,
      infoboxAbbr: abbr,
      scopeMatches,
    });
    console.log(`  ${key}: abbr="${abbr}" scope=${scopeMatches} | ours=${entry.stations_operated || 'unset'} wiki stationsop=${stationsop || '(none)'}`);
  }
  writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nWritten to ${OUTPUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

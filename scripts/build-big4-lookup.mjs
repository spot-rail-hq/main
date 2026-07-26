#!/usr/bin/env node
/**
 * scripts/build-big4-lookup.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Builds data/big4-constituents.json — the constituent-company → Big Four
 * group lookup used to colour the 1923-1947 band of the historical map
 * slider. Deterministic, no AI: every entry is a wikilink parsed out of
 * Wikipedia wikitext, never an inferred or remembered association.
 *
 *   node scripts/build-big4-lookup.mjs
 *
 * ─── SOURCES (in precedence order) ────────────────────────────────────────
 * 1. "Railways Act 1921" § Groups — four wikitables, one per group, each
 *    split into "Constituent companies (amalgamated)" and "Subsidiary
 *    companies (absorbed)". This is the STATUTORY list: the Act's own First
 *    Schedule, so it is authoritative for who legally formed each group.
 * 2. "List of constituents of the {Great Western Railway, London Midland and
 *    Scottish Railway, London and North Eastern Railway, Southern Railway}"
 *    — deeper per-group articles covering companies absorbed BEFORE 1923 by
 *    a constituent. Lower precedence: where the two disagree, the Act wins.
 *
 * Source 2 is what takes the lookup from 120 entries to ~340 and the match
 * rate against real OHM line names from 15.4% to 34.5% (Phase 1B). Both
 * sources are parsed, and each entry records which one it came from so a
 * reviewer can tell a statutory fact from an editorial list.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────
 * No transitive successor-chain resolution. OHM names a line after the
 * company that BUILT it, and most of those were absorbed decades before
 * 1923 (Glasgow Paisley & Greenock → Caledonian in 1847 → LMS in 1923), so
 * a full chain would need built-by → absorbed-by → … → group. Phase 1B
 * tested Wikidata's successor properties (P7888/P1366/P156) as a way to
 * walk that chain and found them present on only 3 of 5 sampled companies —
 * it dead-ends unpredictably, which would produce a lookup that is confident
 * and wrong rather than incomplete and honest.
 *
 * This is why the locked decision for the big4 band is KNOWN-ONLY colouring:
 * colour what this lookup resolves, leave the rest neutral within the band,
 * and do NOT infer ownership from territory. A partly-neutral 24-year slice
 * is preferable to plausible-but-invented history.
 *
 * ─── FIELD OWNERSHIP ──────────────────────────────────────────────────────
 * Sole writer of data/big4-constituents.json. Reads nothing else in the repo.
 * Consumed by scripts/build-historical-lines.mjs, which must normalize names
 * with the SAME normalizeCompanyName() from scripts/lib/historical-era.mjs —
 * both sides of the match normalize identically or the rate silently drops.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeCompanyName, USER_AGENT } from './lib/historical-era.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'big4-constituents.json');

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

// Section heading in "Railways Act 1921" → the group's short code. The
// headings use the Act's own regional wording, not the trading names the
// companies actually adopted.
const ACT_SECTION_TO_GROUP = {
  'Southern Group': 'SR',
  'Western Group': 'GWR',
  'North Western, Midland, and West Scottish Group': 'LMS',
  'North Eastern, Eastern, and East Scottish Group': 'LNER',
};

const GROUP_NAMES = {
  GWR: 'Great Western Railway',
  LMS: 'London, Midland and Scottish Railway',
  LNER: 'London and North Eastern Railway',
  SR: 'Southern Railway',
};

const CONSTITUENT_LIST_ARTICLES = {
  'List of constituents of the Great Western Railway': 'GWR',
  'List of constituents of the London, Midland and Scottish Railway': 'LMS',
  'List of constituents of the London and North Eastern Railway': 'LNER',
  'List of constituents of the Southern Railway': 'SR',
};

async function fetchWikitext(title) {
  const url =
    `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main` +
    `&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status} for ${title}`);
  const data = await res.json();
  const page = Object.values(data.query.pages)[0];
  if (page.missing !== undefined) throw new Error(`Wikipedia page missing: ${title}`);
  return page.revisions[0].slots.main['*'];
}

// Pulls `* [[Target]]` / `* [[Target|label]]` bullet links out of a wikitext
// fragment. Only bulleted links count — a bare inline [[link]] in prose is
// commentary, not a list member.
function bulletLinks(fragment) {
  return [...fragment.matchAll(/^\s*\*+\s*\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/gm)].map((m) =>
    m[1].trim(),
  );
}

// The Act's group tables put constituents in the first column and
// subsidiaries in the second. The second column is wrapped in a
// <div style="column-count:N"> in every one of the four tables, which is a
// more reliable split point than counting pipe-delimited cells (the bullet
// lists themselves contain pipes inside wikilinks).
function parseActGroups(wikitext) {
  const out = {};
  const sections = wikitext.split(/^====\s*/m).slice(1);
  for (const section of sections) {
    const heading = section.split(/\s*====/)[0].trim();
    const group = ACT_SECTION_TO_GROUP[heading];
    if (!group) continue;
    const body = section.slice(section.indexOf('====') + 4);
    const tableStart = body.indexOf('{|');
    const tableEnd = body.indexOf('|}');
    if (tableStart === -1 || tableEnd === -1) {
      throw new Error(`No wikitable found under "${heading}" — article structure changed`);
    }
    const table = body.slice(tableStart, tableEnd);
    const divAt = table.indexOf('<div');
    if (divAt === -1) {
      throw new Error(
        `No <div column-count> split found in "${heading}" table — the constituent/subsidiary ` +
          `column split this parser relies on has changed; re-read the article before trusting output`,
      );
    }
    out[group] = {
      constituents: bulletLinks(table.slice(0, divAt)),
      subsidiaries: bulletLinks(table.slice(divAt)),
    };
  }
  const missing = Object.values(ACT_SECTION_TO_GROUP).filter((g) => !out[g]);
  if (missing.length) throw new Error(`Act parse found no table for: ${missing.join(', ')}`);
  return out;
}

// The "List of constituents of …" articles are prose + bullet lists with no
// consistent table structure across the four, so BULLETED railway-ish
// wikilinks are taken. Restricted to bullets on purpose: a first pass took
// every link in the article and pulled in navigation noise (Category: pages,
// the Act article itself, each group's own article) alongside real
// constituents. These are lower-precedence entries that only fill gaps the
// Act's schedule left empty.
const RAILWAY_TITLE_RE = /\b(Railway|Railways|Railroad|Rly)\b/i;

// Never treat these as constituents of anything: wiki namespaces, the Act
// itself, and the four groups' own articles (a "List of constituents of the
// LMS" article naturally links to the LMS, and to its fellow groups when
// describing joint lines).
const NOT_A_CONSTITUENT = new Set(
  [
    'Railways Act 1921',
    'Great Western Railway',
    'London, Midland and Scottish Railway',
    'London and North Eastern Railway',
    'Southern Railway',
    'Southern Railway (UK)',
    'London and North Eastern Railway (LNER)',
  ].map((t) => normalizeCompanyName(t)),
);

function parseConstituentList(wikitext) {
  const links = bulletLinks(wikitext);
  return [
    ...new Set(
      links.filter(
        (t) =>
          RAILWAY_TITLE_RE.test(t) &&
          !t.includes(':') && // Category:, File:, Wikipedia: …
          !NOT_A_CONSTITUENT.has(normalizeCompanyName(t)),
      ),
    ),
  ];
}

async function main() {
  console.log('Fetching Railways Act 1921 (statutory source)...');
  const actText = await fetchWikitext('Railways Act 1921');
  const actGroups = parseActGroups(actText);

  // company (normalized) -> { group, name, role, source }
  const companies = new Map();
  const addCompany = (rawName, group, role, source) => {
    const key = normalizeCompanyName(rawName);
    if (!key) return;
    const existing = companies.get(key);
    if (existing) {
      // Act entries outrank list-article entries; first Act entry wins over
      // a later one (no such collision observed, but record it if it happens).
      if (existing.source === 'railways_act_1921' && source !== 'railways_act_1921') return;
      if (existing.group !== group) {
        // A company claimed by two groups is almost always a genuine JOINT
        // railway — the Act left the joint lines (Midland & Great Northern,
        // Cheshire Lines, Somerset & Dorset, and ~20 others) outside the Big
        // Four, jointly operated by two successors. Attributing one to a
        // single group would be a factual error, not a rounding error, so
        // these are marked joint and DROPPED from the flat lookup: the line
        // builder leaves co_big4 null and they render neutral within the
        // band, consistent with the known-only rule.
        existing.joint = true;
        existing.groups = [...new Set([...(existing.groups || [existing.group]), group])].sort();
        return;
      }
      return;
    }
    companies.set(key, { name: rawName, group, role, source });
  };

  for (const [group, { constituents, subsidiaries }] of Object.entries(actGroups)) {
    for (const c of constituents) addCompany(c, group, 'constituent', 'railways_act_1921');
    for (const s of subsidiaries) addCompany(s, group, 'subsidiary', 'railways_act_1921');
  }
  const actCount = companies.size;
  console.log(`  Act schedule: ${actCount} companies`);
  for (const [g, v] of Object.entries(actGroups)) {
    console.log(`    ${g.padEnd(5)} constituents ${String(v.constituents.length).padStart(3)} | subsidiaries ${String(v.subsidiaries.length).padStart(3)}`);
  }

  console.log('Fetching per-group constituent lists (pre-1923 absorptions)...');
  for (const [title, group] of Object.entries(CONSTITUENT_LIST_ARTICLES)) {
    const text = await fetchWikitext(title);
    const found = parseConstituentList(text);
    for (const c of found) addCompany(c, group, 'absorbed', 'constituent_list_article');
    console.log(`  ${group.padEnd(5)} +${found.length} railway-ish links from "${title}"`);
  }

  const joint = [...companies.entries()].filter(([, v]) => v.joint);
  const byGroup = {};
  const lookup = {};
  for (const [key, v] of companies.entries()) {
    if (v.joint) continue; // see addCompany() — joint lines are never attributed to one group
    lookup[key] = v.group;
    byGroup[v.group] = (byGroup[v.group] || 0) + 1;
  }

  const output = {
    generated_at: new Date().toISOString(),
    _notes:
      'Constituent-company -> Big Four group lookup for the historical map slider\'s 1923-1947 ' +
      'band. Built by scripts/build-big4-lookup.mjs (sole writer) from Wikipedia wikitext — ' +
      'deterministic, no AI, every entry traceable to a parsed wikilink. KEYS ARE NORMALIZED: ' +
      'use normalizeCompanyName() from scripts/lib/historical-era.mjs on the lookup side too, or ' +
      'the match rate silently collapses. `role` distinguishes the Act\'s own statutory ' +
      'constituent/subsidiary categories from `absorbed` (a company taken over by a constituent ' +
      'BEFORE 1923, sourced from the lower-precedence per-group list articles). This lookup is ' +
      'intentionally NOT transitive: OHM names lines after the company that built them, and ' +
      'resolving those to a 1923 group needs a built-by -> absorbed-by -> group chain that ' +
      'Wikidata only supports for some companies (3 of 5 sampled in Phase 1B), so a chain-walk ' +
      'would be confidently wrong rather than honestly incomplete. Per the locked decision the ' +
      'big4 band is KNOWN-ONLY: colour what resolves here, leave everything else neutral, never ' +
      'infer ownership from territory.',
    groups: GROUP_NAMES,
    stats: {
      total_companies: companies.size,
      from_act_schedule: actCount,
      from_list_articles: companies.size - actCount,
      by_group: byGroup,
      joint_excluded: joint.length,
    },
    act_schedule: actGroups,
    // The flat map the line builder actually consumes.
    lookup,
    // Joint railways: real companies, deliberately NOT in `lookup`.
    joint_railways: Object.fromEntries(joint.map(([k, v]) => [k, { name: v.name, groups: v.groups }])),
    // Full records, for a human reviewing a specific attribution.
    companies: Object.fromEntries([...companies.entries()].map(([k, v]) => [k, v])),
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`  ${companies.size} companies (${actCount} statutory, ${companies.size - actCount} from list articles)`);
  console.log(`  by group: ${JSON.stringify(byGroup)}`);
  if (joint.length) {
    console.log(`\n  ${joint.length} joint railway/railways claimed by more than one group —`);
    console.log('  excluded from the lookup and left neutral in the band (see addCompany):');
    for (const [, v] of joint) console.log(`    ${v.name} — ${v.groups.join(' / ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

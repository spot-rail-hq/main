/**
 * scripts/lib/operator-classify.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Shared operator raw-string → bucket/canonical classification, extracted
 * from build-operator-inventory.mjs (Phase 0) so build-line-segments.mjs
 * (Phase 2) and any future script classify relations identically instead of
 * maintaining a second copy of this mapping that could drift out of sync.
 * build-operator-inventory.mjs re-exports these via its own module so its
 * existing `node scripts/build-operator-inventory.mjs` entry point and
 * output are unchanged — see that file's header for the full reasoning
 * behind each mapping decision (GTR fold, exclusions, etc.).
 */

export const CANONICAL_TOC = {
  // Direct names
  'West Midlands Railway': 'WMR', 'Avanti West Coast': 'VT', 'LNER': 'GR',
  'CrossCountry': 'XC', 'East Midlands Railway': 'EM',
  'London Northwestern Railway': 'LN', 'Great Western Railway': 'GW',
  'South Western Railway': 'SW', 'Southeastern': 'SE', 'Southern': 'SN',
  'Thameslink': 'TL', 'Gatwick Express': 'GX', 'Great Northern': 'GN',
  'c2c': 'CC', 'Chiltern Railways': 'CH', 'Greater Anglia': 'LE',
  'Northern': 'NT', 'TransPennine Express': 'TP', 'Merseyrail': 'ME',
  'ScotRail': 'SR', 'Caledonian Sleeper': 'CS', 'Grand Central': 'GC',
  'Hull Trains': 'HT', 'Lumo': 'LD', 'Heathrow Express': 'HX',
  'Elizabeth line': 'XR', 'Transport for Wales': 'AW', 'Island Line': 'IL',
  'West Coast Railways': 'WR', 'Eurostar': 'ES',
  // operators-content.json's existing `aliases`
  'London North Eastern Railway': 'GR', 'Virgin Trains East Coast': 'GR',
  'Cross Country': 'XC', 'Arriva CrossCountry': 'XC', 'East Midlands': 'EM',
  'GWR': 'GW', 'First Great Western': 'GW', 'Great Western Railways': 'GW',
  'South Eastern': 'SE', 'Southeastern Railway': 'SE',
  'Southern Railway': 'SN', 'Abellio Greater Anglia': 'LE',
  'Northern Rail': 'NT', 'Northern Trains': 'NT', 'Arriva Trains North': 'NT',
  'Arriva Rail North': 'NT', 'Transpennine Express': 'TP',
  // 2026-07-28 BUGFIX: this mapped to 'LD' (Lumo). GTS Rail Operations is the
  // ELIZABETH LINE's operator — the Go-Ahead / Tokyo Metro / Sumitomo joint
  // venture that took over the TfL concession from MTR in November 2024, which
  // operators-content.json's XR entry already records as its parent_company.
  // OSM tags 24 route relations `operator=GTS Rail Operations` and 11
  // `operator=Lumo`; folding the former into LD put the whole Elizabeth line —
  // Reading/Maidenhead through Paddington and the central core out to Shenfield
  // and Abbey Wood, ~442 km — onto Lumo, and left XR with no segments at all.
  // Reported as "selecting Lumo highlights a horizontal route across London".
  // The OSM data was correct throughout; only this line was wrong.
  //
  // The SHIPPED TILESET was corrected separately by a narrow in-place relabel of
  // line-segments.json (segment ids and geometry untouched), because a full
  // build-line-segments.mjs re-run rebuilds the graph from the current Overpass
  // extract and would shift ids/geometry — deferred to the October quarterly OSM
  // refresh, where that cost is absorbed anyway. THIS line therefore has no
  // effect until that next full rebuild; it is here so the relabel does not have
  // to be repeated.
  'GTS Rail Operations': 'XR', 'Island Line Trains': 'IL',
  'Eurostar International Ltd': 'ES',
  // Line-data-only variants — legal_entity/welsh_name strings and casing/
  // plural forms found live, none of them in station data's `aliases`
  'West Midlands Trains': 'WMR', 'Trafnidiaeth Cymru': 'AW',
  'Southeastern Railways': 'SE', // plural — new variant, not seen in station data
  // "Greater Thameslink Railway" is deliberately NOT mapped to SN/TL/GN/GX
  // here — see GTR_FOLD below.
  // Sub-brand strings the GTR fold used to swallow; see GTR_FOLD's note.
  'Thameslink Railway': 'TL',
  // Stansted Express (added 2026-08-05). A brand of state-owned Greater Anglia,
  // NOT a separate company — but it is separately branded, separately liveried
  // and separately ticketed, so it gets its own key for the same reason the GTR
  // sub-brands do. Confirmed 2026-08-05 against Wikipedia that it is still
  // "Stansted Express" and has NOT been renamed to "GBR Stansted Express".
  // Do not confuse with 'Stansted Transit', the airport people-mover, which is
  // in EXCLUDED and is not a TOC.
  'Stansted Express': 'SX',
};

// See build-operator-inventory.mjs's GTR_NOTE for the full 31 May 2026
// renationalization finding this encodes.
//
// NARROWED 2026-08-05 to the two genuine PARENT-ENTITY strings. It previously
// also held 'Southern Railway' and 'Thameslink Railway', which are SUB-BRAND
// strings — and because classify() tests this list FIRST, the fold caught them
// before CANONICAL_TOC could map them to SN/TL. That is why 8 GTR route
// relations looked unsplittable: their names carry no brand prefix, so the
// operator tag was the only signal, and the fold was swallowing it. It is also
// why SN already had segments while TL/GN/GX had none — the bare string
// 'Southern' was never in this list, so it alone escaped.
//
// The two remaining entries are correct and must stay: they are the company,
// not a brand, and their relations are split by NAME prefix instead (see
// split-subbrand-segments.mjs). A relation tagged with the parent and carrying
// no brand prefix legitimately stays GTR.
export const GTR_FOLD = ['Greater Thameslink Railway', 'Govia Thameslink Railway'];

export const CANONICAL_METRO = {
  'Transport for London': 'Transport for London',
  'Nexus': 'Tyne and Wear Metro',
  'Transport for Greater Manchester': 'Manchester Metrolink',
  'TfGM': 'Manchester Metrolink',
  'KeolisAmey Docklands Ltd': 'Docklands Light Railway',
  'Tram Operations Ltd': 'Croydon Tramlink',
  'South Yorkshire Future Trams': 'Sheffield Supertram',
  'Midland Metro Limited (WMCA)': 'West Midlands Metro',
  'Tramlink Nottingham': 'Nottingham Express Transit',
  'Glasgow Subway': 'Glasgow Subway',
};

// 2026-07-29: CANONICAL_HERITAGE is now a fallback only. The real heritage
// join is HERITAGE_CANONICAL in ./heritage-canonical.mjs — a variant->canonical
// MAP covering both operator and name strings, because 93% of heritage route
// relations carry no operator tag at all and an operator-only match found 10
// railways out of ~180. classifyTags() below applies the name fallback; this
// array is retained so the legacy single-string classify() keeps working for
// the inventory script's raw-string census.
export const CANONICAL_HERITAGE = [
  'Festiniog Railway Company', 'West Somerset Railway Plc',
  'Mid-Norfolk Railway', 'Gwili Railway Co. Ltd',
  'Ravenglass & Eskdale Railway', 'Scottish Railway Preservation Society',
  'Brechin Railway Preservation Society', 'Almond Valley Heritage Centre',
  'Barrow Hill Roundhouse Railway Museum',
  'Merseyside Tramway Preservation Society',
];

export const EXCLUDED = new Set([
  'London Midland', 'North TransPennine', 'National Express', '(none)',
  'Network Rail', 'M-Shed', 'British Postal Museum',
  'Brighton & Hove City Council', 'Midland and Great Northern Joint Railway',
  'TVR', 'Southampton & Dorchester Railway',
]);

export function classify(raw) {
  if (GTR_FOLD.includes(raw)) return { bucket: 'toc', canonical: 'Greater Thameslink Railway', code: 'GTR' };
  if (CANONICAL_TOC[raw]) return { bucket: 'toc', canonical: CANONICAL_TOC[raw], code: CANONICAL_TOC[raw] };
  if (CANONICAL_METRO[raw]) return { bucket: 'metro', canonical: CANONICAL_METRO[raw], code: null };
  if (CANONICAL_HERITAGE.includes(raw)) return { bucket: 'heritage', canonical: 'Heritage', code: null };
  if (EXCLUDED.has(raw)) return { bucket: 'excluded', canonical: null, code: null };
  return { bucket: 'unrecognized', canonical: null, code: null };
}

// Phase 3 (2026-07-15): the bare operator tag "Transport for London" covers
// all 137 London Underground + Overground route relations undifferentiated
// — but every one of those relations' own `name` tag DOES carry its real
// specific line ("Bakerloo line: Harrow & Wealdstone → Elephant & Castle"
// for Underground, "Windrush Line: Dalston Junction → West Croydon" for the
// 2024-renamed Overground lines) — confirmed empirically against a live
// query of all 137 relations: 100% matched this pattern, zero unparseable.
// classify() itself only ever sees the bare operator STRING (used by Phase
// 0's coarse per-string inventory, which has no per-relation tag access),
// so this is a separate, second-pass refinement applied only where a full
// relation (with its `name` tag) is available — see build-line-
// segments.mjs's use of it. Returns null (caller should keep the generic
// 'Transport for London' canonical, not silently drop the relation) if a
// name tag ever doesn't match this pattern — flag, don't guess.
export function splitTflLine(nameTag) {
  const m = (nameTag || '').match(/^(.*?)\s+[Ll]ine:/);
  return m ? m[1].trim() : null;
}

// Phase 3 follow-up (2026-07-15): recovers relations that classify() would
// otherwise EXCLUDE for a bad-tagging reason (operator="Network Rail", or no
// operator tag at all — raw becomes the literal '(none)' bucket) but which
// are actually real, currently-operating named passenger routes. This is
// deliberately a per-relation-ID table, NOT a rule like "any Network Rail-
// tagged relation is really a TOC" — that would be a blanket reclassification
// (explicitly ruled out) and wrong in general, since most '(none)'/Network
// Rail-tagged relations found in the same query ARE genuine noise: closed/
// historic lines (e.g. "Meon Valley Line", closed 1955), infrastructure
// loops/junctions (e.g. "Fast Tonbridge Loop"), freight-only track ("Toton
// High Level Goods Line"), airport people-movers that aren't TOCs (Stansted
// Transit, Luton DART), or genuinely unbuilt/not-yet-operating lines
// (Portishead — confirmed via live search still under construction, opening
// ~2028, correctly excluded for now). Every entry below was individually
// checked against real-world sources (not inferred from the OSM tag alone)
// before being added — see the operator field's comment for its evidence.
// Two relations found real current service but split across TWO operators
// with no single obviously-correct answer ("Nottingham to Leeds": Northern
// AND East Midlands Railway both run it; "East Coast Main Line"/"Chiltern
// Main Line": relations too small/generically-named to confidently pin to
// one operator) — deliberately NOT in this table, left excluded, flagged
// for manual review rather than guessed.
export const RELATION_ID_OVERRIDES = {
  // Bittern Line (Norwich–Sheringham) — tagged operator="Network Rail";
  // real current service is Greater Anglia (confirmed: greateranglia.co.uk
  // timetables cover this route under its own branded "Bittern Line" name).
  138808: { bucket: 'toc', canonical: 'LE', code: 'LE' },
  // Felixstowe Branch Line, both directions — tagged operator="Network
  // Rail"; confirmed via greateranglia.co.uk — Greater Anglia operates all
  // passenger services Ipswich–Felixstowe.
  127126: { bucket: 'toc', canonical: 'LE', code: 'LE' },
  9603160: { bucket: 'toc', canonical: 'LE', code: 'LE' },
  // Peterborough to Lincoln Line — no operator tag; confirmed via
  // eastmidlandsrailway.co.uk timetables — East Midlands Railway operates
  // this route (LNER also calls at Peterborough itself, but not this
  // specific Lincoln branch).
  222695: { bucket: 'toc', canonical: 'EM', code: 'EM' },
  // Paddington – Greenford shuttle — no operator tag; GWR-operated branch,
  // well-documented (network=National Rail tag present but no operator).
  455429: { bucket: 'toc', canonical: 'GW', code: 'GW' },
  // Heathrow Express, both directions — no operator tag, but the relation's
  // own `name` IS "Heathrow Express" — self-evident, HX is an existing TOC
  // code in this codebase already.
  917523: { bucket: 'toc', canonical: 'HX', code: 'HX' },
  9917743: { bucket: 'toc', canonical: 'HX', code: 'HX' },
  // Ashford–Ramsgate / Ramsgate–Ashford (three separately-tagged relations
  // for the same Kent route) — no operator tag; Southeastern territory,
  // confirmed by real-world knowledge of Kent Coast route ownership.
  2639526: { bucket: 'toc', canonical: 'SE', code: 'SE' },
  2639649: { bucket: 'toc', canonical: 'SE', code: 'SE' },
  6689732: { bucket: 'toc', canonical: 'SE', code: 'SE' },
  // Sittingbourne – Dover — no operator tag; Southeastern Kent Coast route.
  6628076: { bucket: 'toc', canonical: 'SE', code: 'SE' },
  // Bathgate – Edinburgh — no operator tag; ScotRail-operated (Bathgate/
  // Airdrie line).
  6382771: { bucket: 'toc', canonical: 'SR', code: 'SR' },
  // Birmingham to Peterborough Line — no operator tag; confirmed via
  // Wikipedia/crosscountrytrains.co.uk — "most passenger services are
  // provided by CrossCountry" (East Midlands Railway also runs a handful of
  // services on the Syston–Peterborough sub-section, but CrossCountry is
  // the primary/majority operator across the full route this relation
  // represents).
  3045857: { bucket: 'toc', canonical: 'XC', code: 'XC' },
  // Par to Newquay (Cornwall's "Atlantic Coast Line") — no operator tag;
  // well-known GWR branch.
  3822453: { bucket: 'toc', canonical: 'GW', code: 'GW' },
  // Headbolt Lane ↔ Wigan Wallgate, both directions — no operator tag;
  // confirmed via northernrailway.co.uk/merseyrail.org — this specific
  // (unelectrified, Wigan-direction) branch is Northern-operated; the
  // electrified Liverpool-direction service from the same station is a
  // SEPARATE relation and IS Merseyrail, not touched here.
  12660300: { bucket: 'toc', canonical: 'NT', code: 'NT' },
  12660354: { bucket: 'toc', canonical: 'NT', code: 'NT' },
  // "Newcastle and Carlisle Railway" — no operator tag; this is the
  // historic 1830s company name for what's now the Tyne Valley Line, a
  // large relation (366 track ways — full corridor length, not a stub),
  // current service is Northern-operated. Flagging the unusual historic-
  // name tagging as a caveat even though the promotion itself is high-
  // confidence.
  2588073: { bucket: 'toc', canonical: 'NT', code: 'NT' },

  // ─── Heritage/tram recovery pass (2026-07-15) ─────────────────────────
  // Same discipline: each checked individually against a real source
  // (official site / Wikipedia / steamheritage.co.uk-style listings) before
  // promotion, not a blanket "any preserved-sounding name" rule. Heritage
  // lines all get the shared bucket:'heritage' canonical:'Heritage' treatment
  // (matching every other heritage entry — CLAUDE.md's heritage bucket is
  // one shared color since preserved lines never physically overlap each
  // other). Real modern tram SYSTEMS (not preservation attractions) go to
  // 'metro' instead, each with its own canonical name, matching how
  // Manchester Metrolink/Glasgow Subway/etc. are already treated.

  // Welsh Highland Railway (Caernarfon–Porthmadog) — currently operating,
  // well-established (run by the same trust as Festiniog Railway, already
  // in the heritage bucket, but treated as its own entry here since the
  // heritage bucket doesn't distinguish by operator anyway).
  163449: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Epping Ongar Railway — confirmed currently operating (eorailway.co.uk,
  // regular running days plus event specials).
  165230: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Lakeside & Haverthwaite Railway — confirmed currently operating daily
  // in-season (lakesiderailway.co.uk, 2026 season 28 Mar–1 Nov).
  4254002: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Severn Valley Railway (Preserved) — one of the UK's best-established
  // heritage railways (Bridgnorth–Kidderminster), currently operating.
  11094285: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Steeple Grange Light Railway — confirmed currently operating (sglr.co.uk,
  // Sundays + bank holidays, end of March–September — normal heritage-
  // railway seasonal pattern, not a disqualifying "seasonal-only" case).
  11134330: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Lynton and Barnstaple Railway — confirmed currently operating a 1-mile
  // restored section (Woody Bay–Killington Lane), steam/diesel heritage
  // trains (lynton-rail.co.uk).
  12114293: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Crich Tramway (National Tramway Museum) — long-established heritage
  // tram museum with an operating demonstration line; classified heritage
  // (preservation/museum in nature), not metro (not a real commuter transit
  // system).
  13986644: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Great Orme Tramway, both sections — confirmed currently operating daily
  // (greatormetramway.co.uk, 2026 season). Britain's only cable-hauled
  // street tramway; historic/funicular tourist attraction in character,
  // classified heritage rather than metro for the same reason as Crich.
  575019: { bucket: 'heritage', canonical: 'Heritage', code: null },
  575020: { bucket: 'heritage', canonical: 'Heritage', code: null },
  // Seaton Tramway — confirmed currently operating (tram.co.uk, 2026
  // schedule runs Feb–Nov). Heritage narrow-gauge tram, same reasoning.
  163554: { bucket: 'heritage', canonical: 'Heritage', code: null },

  // Edinburgh Trams — a real, modern, fare-paying urban tram SYSTEM (not a
  // preservation attraction), operating since 2014 — classified metro,
  // matching Manchester Metrolink/Glasgow Subway's treatment. Includes the
  // Newhaven extension relation, confirmed opened 7 June 2023 (real and
  // operating, not a proposed/incomplete extension as initially guessed).
  2632877: { bucket: 'metro', canonical: 'Edinburgh Trams', code: null },
  4116776: { bucket: 'metro', canonical: 'Edinburgh Trams', code: null },
  11819309: { bucket: 'metro', canonical: 'Edinburgh Trams', code: null },
  // Blackpool Tramway (Blackpool–Fleetwood) — a real, modern, day-to-day
  // public transit tram system (modernized 2012), classified metro.
  7119569: { bucket: 'metro', canonical: 'Blackpool Tramway', code: null },
  10841330: { bucket: 'metro', canonical: 'Blackpool Tramway', code: null },
};

export function applyRelationOverride(relationId, cls) {
  const override = RELATION_ID_OVERRIDES[relationId];
  return override ? { ...override } : cls;
}

// ── Tag-object classification with name fallback (2026-07-29) ──────────────
// classify() takes a single operator STRING and is kept unchanged so
// build-operator-inventory.mjs's raw-string census still works. This wrapper is
// what build-line-segments.mjs uses instead.
//
// Why a fallback chain rather than a wider operator list: of the 72 heritage
// route relations in the extract, only 5 carry an operator tag. Bluebell,
// Swanage, Llangollen and Severn Valley all have `operator` absent, so no
// pattern match or widened array can reach them — the join has to fall back to
// the relation's own `name`, then `ref`. First non-empty wins.
import { HERITAGE_CANONICAL, HERITAGE_META } from './heritage-canonical.mjs';

// ── Narrow {name, operator} overrides, consulted BEFORE the normal chain ──
// Operator-first is correct in general — an operator tag is a stronger identity
// claim than a route name. This table exists only for known-bad upstream pairs
// where that general rule produces a demonstrably wrong merge.
//
// Butterley: 26 ways named "Midland Railway Centre" carry
// operator="Ecclesbourne Valley Railway". They are different railways ~10 km
// apart (Butterley vs Wirksworth). Without this override the operator wins and
// Butterley's 6.9 km is silently absorbed into Ecclesbourne's row.
//
// INTERACTION WITH THE GUARD: this override and heritageOverrideStatus() below
// are one mechanism, not two. The override only fires when the exact bad pair
// is present. If OSM corrects the operator upstream, the override stops
// matching, the name falls through to the normal chain and resolves Butterley
// correctly on its own — and the guard reports that the override is now dead
// so it can be removed. A corrected upstream therefore produces a WARNING and
// a correct result, never a silent re-merge.
export const HERITAGE_PAIR_OVERRIDES = [
  { name: 'Midland Railway Centre', operator: 'Ecclesbourne Valley Railway', canonical: 'Midland Railway–Butterley' },
];

export function classifyTags(tags = {}) {
  const operator = tags.operator || tags.brand || '';
  const name = tags.name || '';
  const ref = tags.ref || '';

  for (const o of HERITAGE_PAIR_OVERRIDES) {
    if (name === o.name && operator === o.operator) {
      const meta = HERITAGE_META[o.canonical] || {};
      return {
        bucket: 'heritage', canonical: 'Heritage', code: null,
        heritageRailway: o.canonical, heritageSlug: meta.slug || null,
        heritageType: meta.type || null, heritageTypeSecondary: meta.secondary || null,
        heritageBand: meta.band || null, matchedOn: 'pair-override',
      };
    }
  }

  // Heritage is checked FIRST and against every candidate string, because a
  // heritage way often carries a main-line-looking operator (Butterley's track
  // is tagged operator=Ecclesbourne Valley Railway — see the guard in
  // build-line-segments.mjs) while its NAME is the true identity.
  for (const candidate of [operator, name, ref]) {
    if (!candidate) continue;
    const canonical = HERITAGE_CANONICAL[candidate];
    if (canonical) {
      const meta = HERITAGE_META[canonical] || {};
      return {
        bucket: 'heritage',
        canonical: 'Heritage',          // operators stays the literal "Heritage"
        code: null,
        heritageRailway: canonical,
        heritageSlug: meta.slug || null,
        heritageType: meta.type || null,
        heritageTypeSecondary: meta.secondary || null,
        heritageBand: meta.band || null,
        matchedOn: candidate === operator ? 'operator' : candidate === name ? 'name' : 'ref',
      };
    }
  }
  // Non-heritage keeps the original single-string behaviour exactly.
  return classify(operator || '(none)');
}

// Returns the heritage strings present in `seen` that the map does not cover.
// The map is LOAD-BEARING — an unmapped railway is dropped with no error — so
// every build and every quarterly refresh must run this and report the result.
export function unmappedHeritageNames(seen) {
  return [...seen].filter((s) => s && !HERITAGE_CANONICAL[s]).sort();
}

// Reports whether each HERITAGE_PAIR_OVERRIDES entry still describes reality.
// Called once per build; returns human-readable lines for the caller to print.
// Warning, never throw — a corrected upstream must not break the build, it must
// be visible so the override can be retired.
export function heritageOverrideStatus(waysWithTags) {
  const out = [];
  for (const o of HERITAGE_PAIR_OVERRIDES) {
    const named = waysWithTags.filter((t) => (t.name || '') === o.name);
    const stillBad = named.filter((t) => (t.operator || '') === o.operator);
    if (named.length === 0) {
      out.push(`WARNING: no ways named "${o.name}" found — the ${o.canonical} pair-override is dead code. Remove it or re-derive the join.`);
    } else if (stillBad.length === 0) {
      out.push(`WARNING: OSM appears to have CORRECTED the "${o.name}" / operator="${o.operator}" mistag (${named.length} ways named, 0 still mistagged). The pair-override no longer fires; ${o.canonical} now resolves via the normal chain. REMOVE the override entry.`);
    } else if (stillBad.length < named.length) {
      out.push(`WARNING: "${o.name}" mistag PARTIALLY corrected — ${stillBad.length}/${named.length} ways still carry operator="${o.operator}". The override fires for some ways and not others; ${o.canonical} will be split. Re-check.`);
    } else {
      out.push(`  pair-override OK: "${o.name}" — ${stillBad.length}/${named.length} ways still mistagged as ${o.operator}, override active for ${o.canonical}.`);
    }
  }
  return out;
}

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
  'GTS Rail Operations': 'LD', 'Island Line Trains': 'IL',
  'Eurostar International Ltd': 'ES',
  // Line-data-only variants — legal_entity/welsh_name strings and casing/
  // plural forms found live, none of them in station data's `aliases`
  'West Midlands Trains': 'WMR', 'Trafnidiaeth Cymru': 'AW',
  'Southeastern Railways': 'SE', // plural — new variant, not seen in station data
  // "Greater Thameslink Railway" is deliberately NOT mapped to SN/TL/GN/GX
  // here — see GTR_FOLD below.
};

// See build-operator-inventory.mjs's GTR_NOTE for the full 31 May 2026
// renationalization finding this encodes.
export const GTR_FOLD = ['Greater Thameslink Railway', 'Southern Railway', 'Thameslink Railway', 'Govia Thameslink Railway'];

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
};

export function applyRelationOverride(relationId, cls) {
  const override = RELATION_ID_OVERRIDES[relationId];
  return override ? { ...override } : cls;
}

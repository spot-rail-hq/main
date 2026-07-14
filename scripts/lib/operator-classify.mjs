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

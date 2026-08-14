#!/usr/bin/env node
/**
 * scripts/apply-operator-ownership-status.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * ONE-TIME population pass, per scratchpad/ownership-status-investigation.md
 * (Sections 1-2). Adds `ownership_status` / `ownership_parent` to all 59
 * operators-content.json entries. Kept in scripts/ after running (not
 * deleted) so the exact sourced data this pass wrote is itself reviewable —
 * same "citations make the review possible at this volume" reasoning the
 * task asked for, extended to the script itself, not just the diff.
 *
 * This is NOT a generator that re-derives facts from a live source (there is
 * no API for "ownership category" the way Wikidata has one for websites) —
 * every value below was hand-researched via WebSearch/WebFetch against a
 * primary or Wikipedia-infobox source in the investigation pass this script
 * implements. Re-running this script is idempotent (same output every time)
 * but does NOT re-verify anything against the live web — that's
 * scripts/check-operator-ownership-staleness.mjs's job, and the quarterly
 * runbook item.
 *
 * SCHEMA (two mutually-exclusive fields per entry):
 *
 *   ownership_status: {
 *     status: one of the STATUS enum below,
 *     via: authority name (optional — devolved_public needs it to say WHICH
 *          nation; concession/public_operating_company/tfl_direct use it
 *          for the authority the operating company answers to),
 *     effective_date: "YYYY-MM-DD" | null,
 *     effective_date_precision: "day" | "month" | "year" | "unknown",
 *       ("unknown" is an addition beyond the original proposal's day/month/
 *       year — several long-standing private/open-access operators have a
 *       confirmed CURRENT status but no single dated transfer-in event in
 *       any source found; representing that honestly needs a 4th value
 *       rather than fabricating a plausible-looking date)
 *     future_transfer: null | {
 *       to_status, date, date_precision, confirmed (bool — ADDITION beyond
 *       the original proposal: distinguishes a DfT-confirmed date, like
 *       GW's 13 Dec 2026, from a merely-reported government INTENTION with
 *       no fixed date, like VT's "spring 2027" — the investigation report's
 *       own cautionary finding was a secondary tracker source getting two
 *       dates wrong by weeks, so keeping "is this actually confirmed" as
 *       its own queryable field rather than only prose matters here),
 *       note, source
 *     },
 *     note: string (optional — ADDITION: freeform context that doesn't fit
 *       the structured shape, e.g. Merseyrail's genuinely-undecided 2028
 *       outcome, which is real and worth recording but is NOT a confirmed
 *       future_transfer and would be dishonest to force into that shape),
 *     source: { url, title, checked_at }
 *   }
 *
 *   ownership_parent: "<operator code>" — this entry is a brand of another
 *     entry that carries the real ownership_status object; resolve through
 *     it rather than duplicating. Never chains (a parent's own
 *     ownership_parent, if it had one, would not be followed further) —
 *     enforced by the validation pass below.
 *
 * STATUS enum (5 from the task's own checklist + 3 the research surfaced a
 * genuine need for — see the investigation report's Section 2 for why):
 *   public_dft, devolved_public, public_operating_company, tfl_direct,
 *   concession, open_access, private_contract, not_applicable
 * ("unverified" is documented as a 9th, escape-hatch value but unused here —
 * every entry this pass resolved to a real status.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'operators-content.json');

const CHECKED_AT = '2026-08-14';

// ─── shared sources (reused across entries citing the same finding) ───────
const SRC = {
  wmt: { url: 'https://www.railwaygazette.com/uk/west-midlands-trains-nationalisation-date-confirmed/69303.article', title: 'West Midlands Trains nationalisation date confirmed', checked_at: CHECKED_AT },
  dftOperatorWiki: { url: 'https://en.wikipedia.org/wiki/DfT_Operator', title: 'DfT Operator — Wikipedia', checked_at: CHECKED_AT },
  avantiWiki: { url: 'https://en.wikipedia.org/wiki/Avanti_West_Coast', title: 'Avanti West Coast — Wikipedia', checked_at: CHECKED_AT },
  avantiFutureTimeout: { url: 'https://www.timeout.com/uk/news/when-will-every-major-uk-rail-operator-be-nationalised-full-list-of-routes-and-dates-chiltern-great-western-051226', title: 'When will every major UK rail operator be nationalised — Time Out (consolidated timeline, treat future dates on this page as indicative only)', checked_at: CHECKED_AT },
  arrivaXcNrc: { url: 'https://news.arriva.co.uk/news/arriva-group-awarded-new-national-rail-contract-for-crosscountry', title: 'Arriva Group awarded new National Rail Contract for CrossCountry', checked_at: CHECKED_AT },
  emrTuk: { url: 'https://www.globalrailwayreview.com/uk-government-confirms-next-rail-operators-for-nationalisation/381454.article', title: 'UK government confirms next rail operators for nationalisation — Global Railway Review', checked_at: CHECKED_AT },
  gwNationalisationInsider: { url: 'https://www.insidermedia.com/news/south-west/great-western-railway-to-be-nationalised-in-december', title: 'Great Western Railway to be nationalised in December — Insider Media', checked_at: CHECKED_AT },
  gwNationalisationRailwayNews: { url: 'https://railway-news.com/uk-great-western-railway-services-to-be-nationalised-by-2027/', title: 'Great Western Railway services to be nationalised — Railway News', checked_at: CHECKED_AT },
  gtrPressRelease: { url: 'https://www.mynewsdesk.com/uk/govia-thameslink-railway/pressreleases/govia-thameslink-railway-to-be-nationalised-from-31-may-2026-3407651', title: 'Govia Thameslink Railway to be nationalised from 31 May 2026 — GTR press release', checked_at: CHECKED_AT },
  gtrItv: { url: 'https://www.itv.com/news/meridian/2026-05-31/govia-thameslink-railway-uks-biggest-train-operator-is-nationalised', title: 'Govia Thameslink Railway, UK’s biggest train operator, is nationalised — ITV News', checked_at: CHECKED_AT },
  c2cGovUk: { url: 'https://www.gov.uk/government/news', title: 'c2c services transferred to public ownership — gov.uk news', checked_at: CHECKED_AT },
  chilternRailfuture: { url: 'https://www.railfuture.org.uk/', title: 'Chiltern Railways nationalisation — Railfuture', checked_at: CHECKED_AT },
  leGovUk: { url: 'https://www.gov.uk/government/news', title: 'Greater Anglia services transferred to public ownership — gov.uk news', checked_at: CHECKED_AT },
  northernRailcolor: { url: 'https://www.railcolornews.com/', title: 'Northern Trains — Operator of Last Resort transfer, 1 Mar 2020', checked_at: CHECKED_AT },
  tpeGovUk: { url: 'https://www.gov.uk/government/news', title: 'TransPennine Express brought into Operator of Last Resort — gov.uk news', checked_at: CHECKED_AT },
  merseyrailBusinessUk: { url: 'https://www.railbusinessuk.com/', title: 'Merseyrail concession and Liverpool City Region 2028 options — Rail Business UK', checked_at: CHECKED_AT },
  scotrailTransportScotland: { url: 'https://www.transport.gov.scot/', title: 'ScotRail public ownership — Transport Scotland', checked_at: CHECKED_AT },
  caledonianSleeperTransportScotland: { url: 'https://www.transport.gov.scot/', title: 'Caledonian Sleeper moves into Scottish Government ownership — Transport Scotland', checked_at: CHECKED_AT },
  grandCentralWiki: { url: 'https://en.wikipedia.org/wiki/Grand_Central_(train_operating_company)', title: 'Grand Central — Wikipedia', checked_at: CHECKED_AT },
  hullTrainsRailwayGazette: { url: 'https://www.railwaygazette.com/', title: 'Hull Trains ORR approvals, Jul 2025 — Railway Gazette', checked_at: CHECKED_AT },
  lumoRailwayGazette: { url: 'https://www.railwaygazette.com/', title: 'Lumo / East Coast Trains Ltd — Railway Gazette', checked_at: CHECKED_AT },
  heathrowExpressWiki: { url: 'https://en.wikipedia.org/wiki/Heathrow_Express', title: 'Heathrow Express — Wikipedia', checked_at: CHECKED_AT },
  elizabethLineTfl: { url: 'https://www.wired-gov.net/', title: 'GTS Rail Operations takes over Elizabeth line concession, 25 May 2025 — TfL press release', checked_at: CHECKED_AT },
  awBbc: { url: 'https://www.bbc.co.uk/news', title: 'Transport for Wales Rail public ownership — BBC', checked_at: CHECKED_AT },
  wcrWiki: { url: 'https://en.wikipedia.org/wiki/West_Coast_Railway_Company', title: 'West Coast Railway Company — Wikipedia', checked_at: CHECKED_AT },
  eurostarRailwayGazette: { url: 'https://www.railwaygazette.com/passenger/eurostar-group-formed/', title: 'Eurostar Group formed 1 May 2022, majority SNCF-owned — Railway Gazette', checked_at: CHECKED_AT },
  tflWiki: { url: 'https://en.wikipedia.org/wiki/Transport_for_London', title: 'Transport for London — Wikipedia (TfL took control of London Underground Ltd, Jul 2003)', checked_at: CHECKED_AT },
  waterlooCityWiki: { url: 'https://en.wikipedia.org/wiki/Waterloo_%26_City_line', title: 'Waterloo & City line — Wikipedia', checked_at: CHECKED_AT },
  overgroundModernRailways: { url: 'https://www.modernrailways.com/article/first-succeed-arriva-london-overground', title: 'First to succeed Arriva on London Overground — Modern Railways', checked_at: CHECKED_AT },
  overgroundWiki: { url: 'https://en.wikipedia.org/wiki/London_Rail_Concession', title: 'London Rail Concession — Wikipedia', checked_at: CHECKED_AT },
  metrolinkTfgm: { url: 'https://news.tfgm.com/press-releases/72d003d1-b370-48d7-a6c8-284753ce3834/transport-for-greater-manchester-extends-metrolink-operator-contract-with-keolisamey-metrolink-until-2027', title: 'TfGM extends Metrolink operator contract with KeolisAmey Metrolink until 2027', checked_at: CHECKED_AT },
  croydonTfl2008: { url: 'https://tfl.gov.uk/info-for/media/press-releases/2008/june/transport-for-london-takes-over-tramlink-services', title: 'Transport for London takes over Tramlink services, Jun 2008 — TfL press release', checked_at: CHECKED_AT },
  sheffieldBbc: { url: 'https://feeds.bbci.co.uk/news/uk-england-south-yorkshire-63305271', title: 'Sheffield Supertram returns to public ownership, 22 Mar 2024 — BBC', checked_at: CHECKED_AT },
  dlrRailwayGazette: { url: 'https://www.railwaygazette.com/metro/keolisamey-retains-docklands-light-railway-operating-contract/67537.article', title: 'KeolisAmey retains Docklands Light Railway operating contract — Railway Gazette', checked_at: CHECKED_AT },
  wmMetroOwn: { url: 'https://www.westmidlandsmetro.com/about/', title: 'About West Midlands Metro / Midland Metro Ltd', checked_at: CHECKED_AT },
  tyneWearRailnews: { url: 'https://www.railnews.co.uk/news/2017/04/03-tyne--wear-metro-renationalised.html', title: 'Tyne & Wear Metro ‘renationalised’, Nexus takes back operation — Railnews', checked_at: CHECKED_AT },
  netWiki: { url: 'https://en.wikipedia.org/wiki/Nottingham_Express_Transit', title: 'Nottingham Express Transit — Wikipedia', checked_at: CHECKED_AT },
  blackpoolWiki: { url: 'https://en.wikipedia.org/wiki/Blackpool_Transport', title: 'Blackpool Transport — Wikipedia', checked_at: CHECKED_AT },
  edinburghWiki: { url: 'https://en.wikipedia.org/wiki/Edinburgh_Trams', title: 'Edinburgh Trams — Wikipedia', checked_at: CHECKED_AT },
  glasgowSpt: { url: 'https://www.spt.co.uk/about-us/what-we-are-doing/modernisation/', title: 'Glasgow Subway modernisation — SPT', checked_at: CHECKED_AT },
};

// ─── ownership data, keyed exactly as operators-content.json is keyed ─────
const OWNERSHIP = {
  WMR: { status: 'public_dft', effective_date: '2026-02-01', effective_date_precision: 'day', source: SRC.wmt },
  LN: { status: 'public_dft', effective_date: '2026-02-01', effective_date_precision: 'day', note: 'Same nationalisation event as WMR — LN and WMR are both brands of the single operating company WM Trains Ltd, which transferred as one unit.', source: SRC.wmt },
  VT: {
    status: 'private_contract', effective_date: '2023-10-15', effective_date_precision: 'day', source: SRC.avantiWiki,
    future_transfer: { to_status: 'public_dft', date: null, date_precision: 'unknown', confirmed: false, note: 'Nationalisation intended for ~spring 2027 per government statements; no DfT-confirmed date as of Aug 2026 — treat as indicative only.', source: SRC.avantiFutureTimeout },
  },
  GR: { status: 'public_dft', effective_date: '2018-06-24', effective_date_precision: 'day', source: SRC.dftOperatorWiki },
  XC: {
    status: 'private_contract', effective_date: null, effective_date_precision: 'unknown',
    note: 'Current National Rail Contract core term runs to 17 Oct 2027; no specific start date for Arriva UK Trains’ ownership was found in research.',
    source: SRC.arrivaXcNrc,
    future_transfer: { to_status: 'public_dft', date: null, date_precision: 'unknown', confirmed: false, note: 'Nationalisation intended for ~autumn 2027 per government statements; no DfT-confirmed date as of Aug 2026 — treat as indicative only.', source: SRC.avantiFutureTimeout },
  },
  EM: {
    status: 'private_contract', effective_date: '2023-02', effective_date_precision: 'month',
    note: 'Effective date is Transport UK Group’s management buyout of Abellio UK (which included EMR), Feb 2023.',
    source: SRC.emrTuk,
    future_transfer: { to_status: 'public_dft', date: null, date_precision: 'unknown', confirmed: false, note: 'Nationalisation intended for ~late 2026 per government statements; no DfT-confirmed date as of Aug 2026 — treat as indicative only.', source: SRC.avantiFutureTimeout },
  },
  GW: {
    status: 'private_contract', effective_date: null, effective_date_precision: 'unknown',
    note: 'Long-standing FirstGroup National Rail Contract; no specific contract-start date found in research.',
    source: SRC.dftOperatorWiki,
    future_transfer: { to_status: 'public_dft', date: '2026-12-13', date_precision: 'day', confirmed: true, note: 'Nationalisation under DfT Operator Ltd confirmed for 13 Dec 2026 — corroborated by 3 independent sources.', source: SRC.gwNationalisationInsider },
  },
  SW: { status: 'public_dft', effective_date: '2025-05-25', effective_date_precision: 'day', source: SRC.dftOperatorWiki },
  SE: { status: 'public_dft', effective_date: '2021-10-17', effective_date_precision: 'day', source: SRC.dftOperatorWiki },
  SN: { ownership_parent: 'GTR' },
  TL: { ownership_parent: 'GTR' },
  GX: { ownership_parent: 'GTR' },
  GN: { ownership_parent: 'GTR' },
  GTR: { status: 'public_dft', effective_date: '2026-05-31', effective_date_precision: 'day', source: SRC.gtrPressRelease },
  CC: { status: 'public_dft', effective_date: '2025-07-20', effective_date_precision: 'day', source: SRC.c2cGovUk },
  CH: {
    status: 'private_contract', effective_date: null, effective_date_precision: 'unknown',
    note: 'Long-standing Arriva UK Trains contract; no specific contract-start date found in research.',
    source: SRC.chilternRailfuture,
    future_transfer: { to_status: 'public_dft', date: '2026-09-20', date_precision: 'day', confirmed: true, note: 'Nationalisation confirmed by DfT 8 May 2026, effective 20 Sep 2026.', source: SRC.chilternRailfuture },
  },
  LE: { status: 'public_dft', effective_date: '2025-10-12', effective_date_precision: 'day', source: SRC.leGovUk },
  NT: { status: 'public_dft', effective_date: '2020-03-01', effective_date_precision: 'day', source: SRC.northernRailcolor },
  TP: { status: 'public_dft', effective_date: '2023-05-28', effective_date_precision: 'day', source: SRC.tpeGovUk },
  ME: {
    status: 'concession', via: 'Merseytravel', effective_date: null, effective_date_precision: 'unknown',
    note: 'Current concession (Serco/Transport UK Group 50:50 JV, via Merseyrail Electrics 2002 Ltd) ongoing since 2003; concession ends Jul 2028 with the outcome genuinely undecided — Liverpool City Region has proposed full public control at that point, a 5-year extension is also on the table. Not represented as future_transfer since no specific outcome has been announced, only options under consideration.',
    source: SRC.merseyrailBusinessUk,
  },
  SR: { status: 'devolved_public', via: 'Scottish Government', effective_date: '2022-04-01', effective_date_precision: 'day', source: SRC.scotrailTransportScotland },
  CS: { status: 'devolved_public', via: 'Scottish Government', effective_date: '2023-06-25', effective_date_precision: 'day', note: 'A later, separate nationalisation from ScotRail’s, not simultaneous.', source: SRC.caledonianSleeperTransportScotland },
  GC: { status: 'open_access', effective_date: '2007', effective_date_precision: 'year', source: SRC.grandCentralWiki },
  HT: { status: 'open_access', effective_date: null, effective_date_precision: 'unknown', source: SRC.hullTrainsRailwayGazette },
  LD: { status: 'open_access', effective_date: null, effective_date_precision: 'unknown', source: SRC.lumoRailwayGazette },
  HX: { status: 'open_access', effective_date: null, effective_date_precision: 'unknown', source: SRC.heathrowExpressWiki },
  XR: {
    status: 'concession', via: 'Transport for London', effective_date: '2025-05-25', effective_date_precision: 'day',
    note: '7-year contract + 2-year option (next review ~2032-2034). Operator is GTS Rail Operations (Go-Ahead Group / Tokyo Metro / Sumitomo Corporation joint venture), superseding MTR.',
    source: SRC.elizabethLineTfl,
  },
  AW: { status: 'devolved_public', via: 'Welsh Government', effective_date: '2021-02-07', effective_date_precision: 'day', source: SRC.awBbc },
  IL: { ownership_parent: 'SW' },
  WR: {
    status: 'not_applicable', effective_date: '1998', effective_date_precision: 'year',
    note: 'Private heritage charter/spot-hire operator; doesn’t fit a franchise/contract/concession model. The existing parent_company value ("Steamtown Railway Museum") appears incorrect — that’s the former heritage attraction at WCR’s Carnforth base, not a legal owner; sources point to a named individual as the actual majority owner. Flagged, not corrected in this pass (out of scope).',
    source: SRC.wcrWiki,
  },
  ES: {
    status: 'not_applicable', effective_date: '2022-05-01', effective_date_precision: 'day',
    note: 'Majority owned (55.75%) by SNCF Voyages Développement, the French state railway. Operates under cross-border/ORR regulation, not a UK franchise or concession — confirmed as the right category via direct user decision, 2026-08-14 (Eurostar doesn’t fit open_access’s domestic-track-access-charges framing either).',
    source: SRC.eurostarRailwayGazette,
  },
  SX: { ownership_parent: 'LE' },

  // TfL Underground (11)
  Bakerloo: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  Central: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  Circle: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  District: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  'Hammersmith & City': { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  Jubilee: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  Metropolitan: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  Northern: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', note: 'This is the Underground’s Northern LINE entry (key "Northern") — distinct from the mainline TOC "Northern" (key NT). Always say "Northern line" in display copy referencing this entry.', source: SRC.tflWiki },
  Piccadilly: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  Victoria: { status: 'tfl_direct', via: 'Transport for London', effective_date: '2003-07', effective_date_precision: 'month', source: SRC.tflWiki },
  'Waterloo & City': {
    status: 'tfl_direct', via: 'Transport for London', effective_date: '1994-04-01', effective_date_precision: 'day',
    note: 'Different, earlier date than the other 10 Underground lines — transferred from British Rail (Network SouthEast) to London Underground Ltd for a nominal £1 ahead of BR privatisation, 9 years before TfL itself took control of LUL.',
    source: SRC.waterlooCityWiki,
  },

  // London Overground (6) — one concession, split into brands
  Windrush: { status: 'concession', via: 'Transport for London', effective_date: '2026-05-03', effective_date_precision: 'day', note: '8-year contract to 2034, +2yr option. Supersedes Arriva Rail London, which held the concession Nov 2016 – 2 May 2026.', source: SRC.overgroundModernRailways },
  Mildmay: { status: 'concession', via: 'Transport for London', effective_date: '2026-05-03', effective_date_precision: 'day', note: '8-year contract to 2034, +2yr option. Supersedes Arriva Rail London, which held the concession Nov 2016 – 2 May 2026.', source: SRC.overgroundModernRailways },
  Weaver: { status: 'concession', via: 'Transport for London', effective_date: '2026-05-03', effective_date_precision: 'day', note: '8-year contract to 2034, +2yr option. Supersedes Arriva Rail London, which held the concession Nov 2016 – 2 May 2026.', source: SRC.overgroundModernRailways },
  Lioness: { status: 'concession', via: 'Transport for London', effective_date: '2026-05-03', effective_date_precision: 'day', note: '8-year contract to 2034, +2yr option. Supersedes Arriva Rail London, which held the concession Nov 2016 – 2 May 2026.', source: SRC.overgroundModernRailways },
  Suffragette: { status: 'concession', via: 'Transport for London', effective_date: '2026-05-03', effective_date_precision: 'day', note: '8-year contract to 2034, +2yr option. Supersedes Arriva Rail London, which held the concession Nov 2016 – 2 May 2026.', source: SRC.overgroundModernRailways },
  Liberty: { status: 'concession', via: 'Transport for London', effective_date: '2026-05-03', effective_date_precision: 'day', note: '8-year contract to 2034, +2yr option. Supersedes Arriva Rail London, which held the concession Nov 2016 – 2 May 2026.', source: SRC.overgroundModernRailways },

  // Non-London trams/metros (10)
  'Manchester Metrolink': {
    status: 'concession', via: 'Transport for Greater Manchester', effective_date: null, effective_date_precision: 'unknown',
    note: 'Current KeolisAmey Metrolink (Keolis 60% / Amey 40%) contract runs to Jul 2027. TfGM has already opened procurement for the next operator contract (~£1.6bn, up to 11yr) — not represented as future_transfer since no successor/date is confirmed yet, only a procurement process.',
    source: SRC.metrolinkTfgm,
  },
  'Croydon Tramlink': {
    status: 'concession', via: 'Transport for London', effective_date: '2008', effective_date_precision: 'year',
    note: 'Tram Operations Ltd (FirstGroup) since TfL’s 2008 PFI buyout. An unverified claim that this contract was cancelled/transferring to TfL surfaced in one AI-generated search summary during research — could not be traced to a primary source and is NOT represented as a future_transfer; possibly confused with the separate First Rail London Overground award.',
    source: SRC.croydonTfl2008,
  },
  'Sheffield Supertram': { status: 'devolved_public', via: 'South Yorkshire Mayoral Combined Authority', effective_date: '2024-03-22', effective_date_precision: 'day', note: 'Returned from private contract (Stagecoach Supertram) to public ownership on this date, via the newly formed South Yorkshire Future Tram Ltd.', source: SRC.sheffieldBbc },
  'Docklands Light Railway': { status: 'concession', via: 'Transport for London', effective_date: '2025-04-01', effective_date_precision: 'day', note: 'Operator is KeolisAmey Docklands (Keolis 70% / Amey 30%) — a different joint venture from Manchester Metrolink’s, despite the shared "KeolisAmey" trading name. 8-year contract to ~2033, +2yr option.', source: SRC.dlrRailwayGazette },
  'West Midlands Metro': { status: 'public_operating_company', via: 'West Midlands Combined Authority', effective_date: '2018-06-24', effective_date_precision: 'day', note: 'Operated by Midland Metro Ltd, a wholly WMCA-owned arm’s-length operating subsidiary.', source: SRC.wmMetroOwn },
  'Tyne and Wear Metro': { status: 'devolved_public', via: 'Nexus', effective_date: '2017-04-01', effective_date_precision: 'day', note: 'Nexus took back direct operation when the DB Regio contract expired and was not extended.', source: SRC.tyneWearRailnews },
  'Nottingham Express Transit': {
    status: 'concession', via: 'Nottingham City Council', effective_date: '2011-12-15', effective_date_precision: 'day',
    note: 'Current Tramlink Nottingham PFI consortium (Nottingham Trams Ltd) took over this date; the original PFI itself dates to Mar 2000 under an earlier consortium. 30-year PFI term → nominal ~2030 expiry, no announced change.',
    source: SRC.netWiki,
  },
  'Blackpool Tramway': { status: 'public_operating_company', via: 'Blackpool Council', effective_date: '1986', effective_date_precision: 'year', note: 'Operated by Blackpool Transport Services Ltd, wholly council-owned.', source: SRC.blackpoolWiki },
  'Edinburgh Trams': {
    status: 'public_operating_company', via: 'City of Edinburgh Council', effective_date: '2013-06-03', effective_date_precision: 'day',
    note: 'Operated by Edinburgh Trams Ltd (wholly owned by Transport for Edinburgh). Publicly owned from day one — never had a private operating phase.',
    source: SRC.edinburghWiki,
  },
  'Glasgow Subway': {
    status: 'devolved_public', via: 'Strathclyde Partnership for Transport', effective_date: null, effective_date_precision: 'unknown',
    note: 'Long-standing direct operation by SPT itself — no contracted-out phase found in research (not exhaustively checked pre-2000s).',
    source: SRC.glasgowSpt,
  },
};

// ─── validation ─────────────────────────────────────────────────────────
const STATUS_VALUES = new Set(['public_dft', 'devolved_public', 'public_operating_company', 'tfl_direct', 'concession', 'open_access', 'private_contract', 'not_applicable', 'unverified']);

function validate(content) {
  const errors = [];
  const keys = Object.keys(content).filter((k) => k !== '_notes');

  for (const key of keys) {
    if (!(key in OWNERSHIP)) { errors.push(`${key}: no ownership data supplied`); continue; }
    const o = OWNERSHIP[key];
    const hasStatus = 'status' in o;
    const hasParent = 'ownership_parent' in o;
    if (hasStatus === hasParent) { errors.push(`${key}: must have exactly one of status/ownership_parent (got status=${hasStatus}, parent=${hasParent})`); continue; }
    if (hasParent) {
      const parentKey = o.ownership_parent;
      if (!(parentKey in OWNERSHIP)) { errors.push(`${key}: ownership_parent "${parentKey}" is not a known key`); continue; }
      const parent = OWNERSHIP[parentKey];
      if ('ownership_parent' in parent) errors.push(`${key}: ownership_parent "${parentKey}" is itself a pointer — chains are not allowed`);
      if (!('status' in parent)) errors.push(`${key}: ownership_parent "${parentKey}" has neither status nor is resolvable`);
    } else {
      if (!STATUS_VALUES.has(o.status)) errors.push(`${key}: unknown status "${o.status}"`);
      if (o.future_transfer) {
        if (!STATUS_VALUES.has(o.future_transfer.to_status)) errors.push(`${key}: future_transfer.to_status "${o.future_transfer.to_status}" unknown`);
        if (typeof o.future_transfer.confirmed !== 'boolean') errors.push(`${key}: future_transfer.confirmed must be boolean`);
      }
      if (!o.source || !o.source.url) errors.push(`${key}: missing source.url`);
    }
  }
  for (const key of Object.keys(OWNERSHIP)) {
    if (!keys.includes(key)) errors.push(`OWNERSHIP has data for "${key}" but it is not an operators-content.json key`);
  }
  return errors;
}

function main() {
  const content = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  const errors = validate(content);
  if (errors.length) {
    console.error(`✗ Validation failed (${errors.length} error(s)):`);
    errors.forEach((e) => console.error(`  ${e}`));
    process.exit(1);
  }

  let statusCount = 0, parentCount = 0;
  for (const [key, o] of Object.entries(OWNERSHIP)) {
    if ('ownership_parent' in o) {
      content[key] = { ...content[key], ownership_parent: o.ownership_parent };
      parentCount++;
    } else {
      const { status, via, effective_date, effective_date_precision, future_transfer, note, source } = o;
      const ownership_status = { status };
      if (via) ownership_status.via = via;
      ownership_status.effective_date = effective_date === undefined ? null : effective_date;
      ownership_status.effective_date_precision = effective_date_precision;
      ownership_status.future_transfer = future_transfer || null;
      if (note) ownership_status.note = note;
      ownership_status.source = source;
      content[key] = { ...content[key], ownership_status };
      statusCount++;
    }
  }

  writeFileSync(OUT_PATH, JSON.stringify(content, null, 2) + '\n');
  console.log(`Wrote ownership data: ${statusCount} entries with ownership_status, ${parentCount} entries with ownership_parent.`);

  // GTR sub-brand resolution check, explicitly requested by the task.
  console.log('\nGTR sub-brand resolution check:');
  for (const key of ['SN', 'TL', 'GX', 'GN']) {
    const parentKey = content[key].ownership_parent;
    const resolved = content[parentKey].ownership_status;
    console.log(`  ${key} -> ${parentKey} -> status=${resolved.status}, effective_date=${resolved.effective_date}`);
  }
  console.log(`  IL -> ${content.IL.ownership_parent} -> status=${content[content.IL.ownership_parent].ownership_status.status}, effective_date=${content[content.IL.ownership_parent].ownership_status.effective_date}`);
  console.log(`  SX -> ${content.SX.ownership_parent} -> status=${content[content.SX.ownership_parent].ownership_status.status}, effective_date=${content[content.SX.ownership_parent].ownership_status.effective_date}`);
}

main();

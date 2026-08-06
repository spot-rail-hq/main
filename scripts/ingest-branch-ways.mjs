#!/usr/bin/env node
/**
 * ingest-branch-ways.mjs — adds WAY-LEVEL track for branches that no OSM route
 * relation covers, so their stations stop rendering with no operator line.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT build-line-segments.mjs.
 * The main extraction is RELATION-driven: step 3 fetches geometry only for ways
 * a route relation references. That is the right default — a route relation is
 * an explicit upstream assertion of which operator runs a line. But six real
 * branches have NO route relation at all (verified 2026-08-04: a `rel(bw)` query
 * against the Wharfedale Line's 67 ways returns zero route relations), so the
 * relation path cannot reach them however it is tuned. Their stations sit
 * 2.4-7.3 km from the nearest attributed track while the track itself is right
 * there, already drawn as grey context by gb-railways.pmtiles.
 *
 * This script is SUPPLEMENTARY and ADDITIVE. It never edits or removes an
 * existing segment; it only appends segments for ways not already present by
 * way_id. That is what keeps it isolated: everything the relation path already
 * produced is byte-identical afterwards.
 *
 * WHY NOT INGEST FROM gb-railways.pmtiles. That tileset proves the track exists
 * but cannot be the source: its features carry only {kind, status, name} — no
 * OSM way or node ids — and tippecanoe has simplified the geometry per zoom. The
 * segment schema needs `nodes` (OSM node ids) for the routing graph's topology,
 * so tile geometry would produce segments that cannot participate in routing.
 * Overpass is the only source that carries both.
 *
 * ── THE ATTRIBUTION IS INFERRED, AND THAT IS THE WHOLE REASON FOR THE FLAG ──
 * These ways tag `operator=Network Rail` — the INFRASTRUCTURE owner, not the
 * train operator. Nothing in the way tags says "Northern runs this". Assigning
 * NT/EM here is our inference from which TOC serves the stations on the branch.
 * The geometry is sourced; the attribution is not. Every segment this script
 * writes therefore carries:
 *
 *     operator_precision: { NT: "inferred" }
 *
 * A MAP, not a bare string, and deliberately so. dedupe-line-segments.mjs UNIONS
 * `operators` when it merges two digitizations of one corridor — so a segment
 * can end up carrying an inferred operator alongside a relation-sourced one. A
 * single segment-level "inferred" would then be a lie in one direction or the
 * other. Keyed by operator, the merge stays truthful: absent key = sourced from
 * a real route relation, which also makes every pre-existing segment correct
 * with no field at all and no backfill.
 *
 * WHICH WAYS COUNT. Name match alone is not safe: within 600 m of Knottingley
 * there are 13 named lines including `Departure`, `Arrival` and
 * `Up Goole Goods Loop`; Corby's second-nearest is `British Steel Corby Branch`
 * and Heysham's is `Heysham Power Station`. Painting those in a passenger
 * operator's colour would be a worse bug than the missing line. So a way is
 * admitted only if it is named in its branch's list AND carries a `usage` tag
 * AND carries NO `service` tag — `service` is what OSM puts on sidings, yard
 * roads and crossovers. Measured at Knottingley: 11 running lines kept of 50
 * ways, every siding and yard road dropped.
 *
 * Usage: node scripts/ingest-branch-ways.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEG_PATH = path.join(__dirname, 'output', 'line-segments.json');
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const DRY = process.argv.includes('--dry-run');
// Restricts the run to one branch by key, e.g. --only=pontefract_baghill_spur.
// Exists because the script has no per-branch idempotency guarantee against
// upstream OSM drift: a plain run can pick up newly-mapped ways in an
// unrelated branch (verified 2026-08-06 — a dry run surfaced 7 new Askern-
// branch ways with no connection to the branch actually being worked on).
// Without this flag, fixing one branch would silently also ingest whatever
// else changed upstream since the last run.
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.slice('--only='.length) : null;

/**
 * The branches. `names` are OSM `name` values observed on active track
 * within 600 m of the affected stations (derived from the base tileset, not
 * hand-listed from memory). `bbox` is [S,W,N,E] and exists so a generic name
 * cannot pull in track from elsewhere in the country — "Down Goole" and
 * "Up Doncaster" are exactly the kind of directional running-line name that
 * could plausibly recur. (Originally six — Askern was split out of
 * `pontefract` 2026-08-04, and `pontefract_baghill_spur` was added
 * 2026-08-06 using `wayIds` instead of `names`; see that entry below.)
 */
const BRANCHES = [
  { key: 'wharfedale', op: 'NT', label: 'Wharfedale Line (Leeds/Bradford-Ilkley)',
    stations: ['GSY', 'MNN', 'BUW', 'ILK', 'BEY', 'BLD'],
    names: ['Wharfedale Line', 'Ilkley Branch'],
    bbox: [53.79, -1.90, 53.96, -1.66] },
  { key: 'harrogate', op: 'NT', label: 'Harrogate Line',
    stations: ['SBE', 'KNA'],
    names: ['Harrogate Line'],
    bbox: [53.90, -1.62, 54.06, -1.35] },
  { key: 'pontefract', op: 'NT', label: 'Pontefract / Knottingley / Goole',
    stations: ['SHC', 'PFM', 'POT', 'KNO', 'FEA', 'RWC', 'GLH', 'PFR'],
    names: ['Pontefract Line', 'Wakefield and Goole Line',
      'Castleford and Pontefract Monkhill Line',
      'Down Goole', 'Up Goole', 'Down Doncaster', 'Up Doncaster'],
    bbox: [53.63, -1.55, 53.76, -0.90] },
  // SPLIT OUT OF `pontefract` 2026-08-04, after external verification. The
  // Askern branch was originally swept up by the Pontefract name list and
  // attributed to NT along with it — wrong: Northern runs NO passenger service
  // over Knottingley West Jn - Shaftholme Jn. It is a freight-primary line
  // (Freightliner, DB Cargo UK, GB Railfreight) plus two passenger operators,
  // Grand Central (its Bradford services run via Pontefract Monkhill and
  // Askern) and LNER.
  //
  // ONLY THE PASSENGER OPERATORS ARE RENDERED, and that is a model limit, not
  // a judgement: data/operator-colors.json has no entry for any freight
  // operator, so there is nothing to colour them with. Adding freight would
  // mean new palette entries, which forces a regeneration — and CLAUDE.md
  // requires the hand-set Heritage colour to be re-verified by hand whenever
  // that happens. Out of scope here; flagged instead of forced.
  //
  // The short `Down Doncaster` / `Up Doncaster` ways stay with `pontefract`
  // above: all three are sub-kilometre and sit at Knottingley itself
  // (53.703-53.706), i.e. the junction throat, not the branch corridor.
  { key: 'askern', op: ['GC', 'GR'], label: 'Askern branch (Knottingley-Shaftholme, freight-primary)',
    stations: [],
    names: ['Knottingley West Junction and Shaftholme Junction Line'],
    bbox: [53.55, -1.40, 53.76, -1.00] },
  { key: 'south_fylde', op: 'NT', label: 'South Fylde (Preston-Blackpool South)',
    stations: ['LTM', 'AFV', 'MOS'],
    names: ['South Fylde Community Railway Line', 'Preston and Wyre Joint Railway'],
    bbox: [53.71, -3.08, 53.83, -2.68] },
  { key: 'morecambe', op: 'NT', label: 'Morecambe / Heysham branch',
    stations: ['HHB'],
    names: ['Morecambe Branch Line'],
    bbox: [53.98, -2.95, 54.09, -2.72] },
  { key: 'corby', op: 'EM', label: 'Corby branch (Midland Main Line)',
    stations: ['COR'],
    names: ['Kettering North Junction and Melton Mowbray Line'],
    bbox: [52.35, -0.80, 52.60, -0.60] },
  // WAY-ID SELECTED, not name-matched — the track this branch needs carries
  // NO `name` tag at all (confirmed via Overpass 2026-08-06: every other way
  // in a 1km box around Pontefract Baghill is either 'Pontefract Line',
  // 'Wakefield and Goole Line' or 'Castleford and Pontefract Monkhill Line',
  // none of which run past Baghill — PFR sits 709m from the nearest of
  // those). So the `names` mechanism above structurally cannot reach it: it
  // is a filter over a `name` tag that doesn't exist here. See `wayIds`
  // handling in the fetch loop below.
  //
  // The two ways below (`ref:lor=LN804`, `ref=SMJ2` — Swinton & Knottingley
  // Joint) are the Up/Down pair running directly past Baghill: verified by
  // perpendicular distance from PFR (53.69188,-1.30335) to each way's
  // polyline, not just to a bbox — 243765934 passes 5.7m from the station,
  // 302911126 passes 9.3m. Both carry usage=branch and no service tag, same
  // admission criteria as the name-matched branches above.
  //
  // CORRECTED 2026-08-06 — the note this replaces had the connector ways'
  // direction backwards and its "already snapped via a different line, no
  // fix needed" conclusion was wrong. Re-derived from live Overpass geometry
  // and OSM relation membership, not carried forward:
  //
  // 263248057 -> 263248089 -> 263248096 (and Down-line counterpart
  // 302911139 -> 302911122 -> 302911128) run SOUTH from PFR, not toward
  // Knottingley — 263248057's first node is the same point as 243765934's
  // south end (53.69107,-1.30425), confirmed by Overpass, not just bbox
  // proximity. All six carry ref:lor=LN804/ref=SMJ2, same as the original
  // pair, and — critically — are members of OSM relation 282107 ("Dearne
  // Valley Line", route=railway). So is segment 2304 (35 of its 37 ways),
  // which is what Moorthorpe (MRP) is already snapped to: Baghill and
  // Moorthorpe are the same named OSM route, not "a different line" as
  // previously recorded. Northern's own current service confirms it's a
  // real, live passenger corridor, not just an OSM tagging artifact: 2023/24
  // station-to-station journey counts show 353 Baghill<->Moorthorpe and 290
  // Baghill<->Swinton journeys (northernrailway.co.uk / national rail
  // station data, checked 2026-08-06) — op:'NT' below is confirmed by that,
  // not just inherited by assumption.
  //
  // Adding these six still does NOT fully connect segment 8861 to anything
  // else already in the graph — the chain continues past 263248096's end
  // (263248086 -> 263248066, not included below) and stays 4.1-5.5km short
  // of segment 2304 near Moorthorpe. Closing that fully means ingesting the
  // rest of relation 282107 southbound, which is separate, larger, un-scoped
  // work — these six only fix the immediate join at Baghill itself.
  //
  // NORTH (Knottingley/Ferrybridge direction) was investigated at the same
  // time and NOT extended THAT way: the chain there (243765938/243765937/
  // 177364259/177364258 up-line, 50944898/50944927/203754994 down-line —
  // also relation-282107 members) stays ~150-190m short of the existing
  // WAG1 "Pontefract Line" track near Knottingley, and Northern's own
  // station page says the curves that would carry it near Ferrybridge "are
  // now only in use for freight and diverted passenger services" — so that
  // specific join was correctly left alone.
  //
  // SUPERSEDED 2026-08-06 — the note above stopped at the Ferrybridge/
  // Knottingley dead end without checking whether SMJ2 continues north by
  // ANY other path. It does: reported by the user via Northern's own March
  // 2026 network map (Pontefract Baghill, Knottingley, Glasshoughton, South
  // Milford, Sherburn-in-Elmet, Church Fenton and Ulleskelf are all listed
  // as served Northern stations) plus a live Google Maps journey (Northern,
  // York -> Ulleskelf -> Church Fenton -> Sherburn-in-Elmet -> Baghill).
  // Re-traced from Overpass geometry with a full shared-node BFS (not
  // spot-checked endpoints) starting from 243765934's north tip: it reaches,
  // 83 ways later, to within 56.7m of segment 3659 (the existing ULL/CHF
  // segment, already NT/TP/XC) — via SMJ2/SMJ3, Brotherton Tunnel, Normanton
  // and Colton Junction Line (NOC), Milford Curve (MGW), Hull Line (HUL3/
  // HUL4) and Sherburn Curve (SHG), NOT via the Ferrybridge curves or WAG1
  // at all. Two ways the BFS reached were excluded: 70594523 (service=spur)
  // and 472403303 (service=siding) — real infrastructure, just not part of
  // the through route. See the 'baghill_milford_junction_link' branch below.
  { key: 'pontefract_baghill_spur', op: 'NT',
    label: 'Pontefract Baghill spur (Swinton & Knottingley Joint, Streethouse Jn – Baghill leg)',
    stations: ['PFR'],
    wayIds: [243765934, 302911126, 263248057, 263248089, 263248096, 302911139, 302911122, 302911128],
    bbox: [53.649, -1.320, 53.701, -1.281] },
  // Continues 'pontefract_baghill_spur' north from 243765934/302911126's own
  // tip (53.700635,-1.28212) up to Church Fenton — see that branch's
  // SUPERSEDED note above for how this was found and verified. NOT
  // name-matched (most of these ways are unnamed SMJ2/SMJ3 fragments, same
  // structural reason as the spur itself) and NOT a small hand list this
  // time — 83 way ids, all shared-node BFS-verified into one continuous
  // chain from the existing 'pontefract_baghill_spur' segment to within
  // 56.7m of segment 3659. op:'NT' confirmed by Northern's own March 2026
  // network map, not inferred by proximity.
  { key: 'baghill_milford_junction_link', op: 'NT',
    label: 'Baghill spur north continuation to Church Fenton (SMJ2/SMJ3, Brotherton, Normanton & Colton Jn, Milford Curve, Hull Line, Sherburn Curve)',
    stations: ['SIE', 'SOM'],
    wayIds: [
      243765938, 50944898, 243765937, 50944927, 243765943, 177364259, 203754994, 177364258,
      212497373, 3689903, 212497374, 212497375, 212497369, 212497370, 212497371,
      366657911, 366657916, 366657921, 149386470, 366657908, 193617442, 366657912, 193617441,
      366657904, 70594519, 366657902, 70594515, 366657913, 295426235, 366657910, 295426236,
      366657919, 29257371, 366657903, 29257372,
      549908125, 549908124, 366657906, 549908123, 549908122, 366657905, 549908117, 549908121,
      244109339, 549908119, 549908118, 796874767, 549914220, 796874766, 549914222, 796874769,
      244109341, 549914224, 268376471, 268377484, 796874768, 268680337, 268376474, 268680342,
      149877563, 549903766, 472402553, 472402552, 29250991, 149877562, 149877574,
      628296634, 628296635, 149877580, 149877584, 144455179, 150894102, 148679893,
      628296631, 628296632, 313370170, 313370144, 628296628,
      366657922, 268683531, 366657920, 366657915, 366657907,
    ],
    bbox: [53.700, -1.390, 53.825, -1.220] },
  // National gap audit 2026-08-06 (comparing gb-railways.pmtiles, which has
  // every named line, against line-segments.json, which has ~3.7% fewer):
  // both of the next two branches came from that audit, both are real,
  // current Greater Anglia (LE) passenger corridors with zero coverage.
  //
  // Shenfield to Southend Victoria: named "Shenfield to Southend Line" /
  // "Shenfield and Southend Victoria Line" (ref EA 1050/SSV) for the western
  // 65 ways, Shenfield end verified 34.5m from the existing seg 4298 (LE,
  // already covers Shenfield itself via the wider GEML). The named way ends
  // short of Southend Victoria station itself (stops near Rochford/Southend
  // Airport) — the final stretch into the terminus is unnamed, same pattern
  // as every other gap this session; found via shared-node BFS (47 more
  // ways), landing 28m from Southend Victoria (SOV) station. NOT connected
  // to segment 6301 (477m away) — that's correct, not a gap: 6301 is the
  // separate c2c (CC) Southend Central/East route, a different terminus a
  // few hundred metres away, not the same line. One siding-tagged way
  // (144905252) excluded.
  { key: 'shenfield_southend_victoria', op: 'LE',
    label: 'Shenfield to Southend Victoria Line (Greater Anglia)',
    stations: ['SNF', 'BIC', 'WIC', 'RLG', 'HOC', 'RFD', 'SIA', 'SOV'],
    wayIds: [
      4309923, 28832916, 48817249, 94456207, 94456210, 94456216, 94456219, 94456226, 94456227,
      105023763, 105023765, 128816280, 128816283, 128816284, 128816285, 128816596, 128816597,
      144947672, 144947682, 144947689, 148593669, 163266955, 163266957, 164012372,
      164759325, 164759328, 164759329, 164759333, 164759336, 164759340, 177599967, 177599971,
      290547904, 290547905, 290547907, 290547908, 290547909, 290547910, 290547911, 290547912,
      290547913, 290547914, 290547915, 290547916, 290547917, 290547918, 290547919, 290547927,
      290547942, 290547946, 333303172, 897753843, 1136739729, 1136739730,
      1206955938, 1206955939, 1206955940, 1206955941,
      48817248, 48816981, 48816980, 94454436, 94454428, 94454431, 94454427,
      185697482, 139107731, 1029030008, 28832918, 139107734, 139107748, 149588488, 28832920,
      144908282, 342947243,
    ],
    bbox: [51.535, 0.325, 51.645, 0.720] },
  // Crouch Valley Line (Wickford - Southminster) — all 28 ways carry the
  // name directly, ref WIS, 0 already in graph. Confirmed Greater Anglia
  // (not c2c, which was this audit's first guess — corrected via
  // greateranglia.co.uk's own Crouch Valley Line Community Rail Partnership
  // page and Class 720 Aventra service reports, checked 2026-08-06) — also
  // matches the geometry: the branch's west (Wickford) end sits 146m from
  // an SSV-tagged stub (the Shenfield-Southend Victoria line above), not
  // from the c2c network 5.7km away, which is the wrong line entirely to
  // compare against. Both real termini (Wickford end, Southminster end) are
  // this branch's genuine dead-ends — the Wickford-side 146m gap to the
  // Shenfield-Southend Victoria line is a real, small, unresolved gap, not
  // closed here (same "needs a manual bridge, not more ingestion" shape as
  // the Church Fenton join — flagged, not fixed blind).
  { key: 'crouch_valley', op: 'LE',
    label: 'Crouch Valley Line (Wickford - Southminster, Greater Anglia)',
    stations: ['SOF', 'NFA', 'ALN', 'BUU', 'SMN'],
    wayIds: [
      1029024703, 89814914, 89814911, 94570288, 94570285, 103885786, 28489765,
      1029024702, 28489764, 28536311, 28536312, 28536316, 28536317,
      366472304, 366472305, 366472303, 28832604, 28832612,
      58507005, 58506920, 58506980, 58506983, 58506985, 58506916, 58506917,
      94576253, 94576254, 1029020387,
    ],
    bbox: [51.605, 0.520, 51.665, 0.840] },
  // Manningtree and Harwich Line — named directly (ref MAH), Greater Anglia
  // (LE, same operator that already covers Manningtree itself via segment
  // 5954). 62 named ways split into two chains by BFS (likely Up/Down lines
  // mapped as separate way sequences that only meet at specific points, same
  // pattern seen elsewhere this session) — both included. Manningtree end
  // verified exact shared node (0m) with the existing seg 5954. Harwich end:
  // one chain lands 109m from Harwich Town, the other 348m from Harwich
  // International — both real, both small, neither closed here (same
  // "flag, don't auto-bridge" treatment as every other near-miss this
  // session). 3 siding-tagged ways excluded (105411788-90); 2
  // crossover-tagged ways kept (real through-track, not spurs).
  { key: 'manningtree_harwich', op: 'LE',
    label: 'Manningtree and Harwich Line (Greater Anglia)',
    stations: ['WRB', 'DVC', 'HWC', 'HPQ'],
    wayIds: [
      28228594, 30715573, 30726347, 30726349, 30878043, 30878044, 32459742, 35263683,
      35902907, 35902908, 36822991, 43721816, 43721826, 43721828, 43721829, 47145456, 47145488,
      96652456, 98532190, 98799204, 98799211, 98799285, 98806668, 101344525, 118976157,
      167807954, 167807956, 167807957, 167807964, 167807976, 167807989, 167807992, 167807994,
      167807996, 230885787, 230885788, 230885789, 230885790, 230885791, 230885792,
      230888699, 230888700, 230888703, 230888706, 230891279, 230891280, 230891281,
      230891284, 230891285, 230891286, 265588859,
      793496244, 793496245, 793496246, 793496247, 793496251, 793496252, 793496253, 840709305,
    ],
    bbox: [51.938, 1.045, 51.950, 1.290] },
  // Wherry Lines (Norwich - Reedham - Great Yarmouth / Lowestoft, via the
  // Reedham triangle junction) — the audit's "Reedham Swing Bridge" hit was
  // real: the whole named "Wherry Lines" way set (45 ways, ref NOL) was
  // missing, not just the bridge itself. Greater Anglia (LE), matches
  // existing LE coverage at both Norwich (seg 447 side) and the Lowestoft/
  // Yarmouth end (seg 6495 side) already in the graph. 0 already in graph,
  // 0 service-tagged. Reedham (REE), Haddiscoe (HAD) and Brundall (BDA) were
  // the unsnapped stations driving this — REE was 11km from its nearest
  // existing track before this.
  { key: 'wherry_lines', op: 'LE',
    label: 'Wherry Lines (Norwich - Reedham - Great Yarmouth / Lowestoft, Greater Anglia)',
    stations: ['REE', 'HAD', 'BDA', 'BYA', 'CNY', 'SYT'],
    wayIds: [
      12537942, 23341091, 23341290, 25971563, 25971564, 25971565, 26209656, 26234568,
      27845792, 27845793, 33081917, 33081918, 35445958, 79396133,
      118433299, 118521516, 118521556, 118521583, 118989836, 204858137,
      290548862, 290548863, 290548864, 290548865, 290548866, 290548867, 290548868,
      290548869, 290548871, 290548873, 445275097, 445275101,
      501172665, 501172674, 501172680, 501172684, 501172696, 501172697, 501172698, 501172701,
      1136004905, 1136005587, 1193156360, 1213564861, 1213564862,
    ],
    bbox: [52.470, 1.440, 52.640, 1.710] },
  // Dunfermline - Alloa Line, reopened for passengers 2008, ScotRail (SR) —
  // matches the SR already on both existing neighbours (seg 4459 at
  // Dunfermline, seg 5180 at Alloa, both already SR-tagged). Two named
  // chains cover it in OSM, in three geographic clusters: "Dunfermline -
  // Alloa Line" itself (15 ways, split into a 4-way cluster touching seg4459
  // at an exact shared node, and an 11-way cluster ~2.9km further west) and
  // "Stirling, Alloa and Kincardine Railway" (24 ways, the Alloa end). Real
  // gaps remain BETWEEN these three clusters (not closed here, same
  // flag-don't-bridge treatment as elsewhere this session) — but each
  // cluster is itself real, current, SR-confirmed track and belongs in the
  // dataset regardless. 3 of the 39 way ids were already in the graph
  // (harmless — ingest skips duplicates); 0 service-tagged.
  { key: 'dunfermline_alloa', op: 'SR',
    label: 'Dunfermline - Alloa Line (ScotRail)',
    stations: [],
    wayIds: [
      4353222, 26764177, 35978663, 69056886, 69056907, 87388592,
      89973848, 89973859, 89973860, 93311142, 93311158, 97822627, 165525727,
      371158405, 431358473, 484393902, 508426313, 541378478,
      763501922, 763501923, 840963320, 840963321, 875911759, 875911760,
      919598190, 922720229, 922720230, 1019104944, 1019104945, 1019183353,
      1281167280, 1281167281, 1283608797, 1453094733, 1453371288,
      1463485261, 1463485262, 1463485263, 1463485264,
    ],
    bbox: [56.050, -3.795, 56.130, -3.450] },
  // East West Rail (Oxford - Bicester - Winslow - Bletchley, reopened 2025).
  // Operator was a real blocker at first — no 'EWR' code exists anywhere in
  // data/operator-colors.json — but Chiltern Railways was named the actual
  // operator (chilternrailways.co.uk / press release, checked 2026-08-06),
  // and 'CH' already exists in the palette, so no regeneration needed.
  // Named directly in OSM ("East West Rail", ref OXD/BFO). BFS from the
  // Bicester end found 222 ways total, 106 already in the graph (the
  // western stretch reuses existing Chiltern Main Line track through
  // Bicester) — only the 116 new ones (113 after excluding 3 Bletchley
  // Depot/Carriage Sidings) are added here. Bletchley end: exact shared
  // node (0m) with the existing seg 4143. Bicester end distance read as
  // 53.7km against seg5928, which is a red herring, not a real gap — 5928
  // is tagged 'Weaver' (a London Overground line, nowhere near Bicester),
  // itself a stale nearest-segment mismatch that this ingest corrects.
  // Winslow itself (new 2025 station) isn't in station-list.json at all —
  // a separate station-data gap, not a track gap, not fixed here.
  { key: 'east_west_rail', op: 'CH',
    label: 'East West Rail (Oxford - Bicester - Winslow - Bletchley, Chiltern Railways)',
    stations: ['BLY'],
    wayIds: [
      926827727, 799321784, 1081186500, 460403487, 22754008, 1081186501, 1332727027,
      1081186502, 1332727026, 1332727028, 4359853, 1332727025, 3550662, 1125722168,
      4359851, 1125722167, 1137103307, 1150156433, 1229069772, 1150156434, 1214490325,
      1229069773, 1214490324, 1214490327, 1137103306, 1214490326, 4005862, 1150156435,
      5024226, 1150156436, 199529631, 1150156437, 199529629, 1150156438, 5024227,
      1150156439, 5024228, 1150156440, 1329259275, 1150156441, 1329259276, 1329259273,
      12580703, 1329259274, 1334628277, 1146014557, 1334628276, 1334628278, 199529661,
      1334628275, 1164966276, 1146014554, 1164966277, 1164966278, 4005861, 1164966279,
      560537090, 1146014555, 560537091, 1146014556, 560537092, 1081224815, 5024539,
      1081224816, 952378239, 1081224819, 952378238, 1081224820, 1081224810, 1081224822,
      1081224811, 1081224812, 46615541, 1081224813, 46615540, 1081224821, 1081224807,
      1081224808, 514245560, 1081224809, 1081224825, 1335362302, 320013522, 1081224824,
      1081224826, 1081224823, 320013521, 179325153, 1335362303, 179325155, 179329535,
      179325154, 1038711131, 44287122, 179329533, 179329542, 1038711132, 179333697,
      72867066, 1335362304, 179329541, 179334963, 80501630, 1524570186, 1524570185,
      846260099, 80501631, 846260098, 846260101, 427324696, 179391534, 510836024, 511074780,
    ],
    bbox: [51.890, -1.150, 52.005, -0.725] },
];

async function overpass(q) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    // BOTH headers are required against the public endpoint, and getting either
    // wrong produces an HTTP 406 with an HTML body that looks exactly like a
    // rate limit. It is not one — backing off will never clear it. Verified
    // 2026-08-04: identical query, no User-Agent -> 406, with User-Agent -> 200.
    // node's fetch() sends no UA by default and defaults a string body to
    // text/plain, so both have to be set explicitly. A local Overpass does not
    // care, which is why build-line-segments.mjs has never needed them.
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'srhq.uk-line-ingest/1.0 (+https://srhq.uk)',
      },
      body: 'data=' + encodeURIComponent(q),
    });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
    // Public Overpass answers rate limits with an XML error document, not JSON.
    const wait = attempt * 12000;
    console.log(`    Overpass busy (HTTP ${res.status}), retry ${attempt}/4 in ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('Overpass failed after 4 attempts');
}

const R = 6371000, rad = (d) => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lengthOf = (coords) => {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += metres(coords[i - 1], coords[i]);
  return t;
};

async function main() {
  const graph = JSON.parse(readFileSync(SEG_PATH, 'utf8'));
  const existingWays = new Set();
  for (const s of graph.segments) for (const w of (s.way_ids || [])) existingWays.add(w);
  let maxId = 0;
  for (const s of graph.segments) if (s.id > maxId) maxId = s.id;
  console.log(`Existing graph: ${graph.segments.length} segments, ${existingWays.size} distinct way ids, max id ${maxId}`);
  console.log(`Overpass: ${OVERPASS_URL}${DRY ? '  [DRY RUN — nothing will be written]' : ''}\n`);

  const branches = ONLY ? BRANCHES.filter((b) => b.key === ONLY) : BRANCHES;
  if (ONLY && branches.length === 0) throw new Error(`--only=${ONLY} matched no branch key`);
  if (ONLY) console.log(`--only=${ONLY}: restricting run to this branch\n`);

  const added = [];
  const report = [];
  for (const b of branches) {
    // Two mutually exclusive selectors: `names` (the default — matches any
    // way tagged with one of these names, scoped by bbox so a generic name
    // can't pull in track from elsewhere) or `wayIds` (an explicit list,
    // for track that carries no `name` tag at all and so can never be
    // reached by the name filter — see the pontefract_baghill_spur branch
    // above for why this exists). `wayIds` skips the bbox filter in the
    // query itself since the ids are already exact; `bbox` is kept on the
    // branch entry purely as a documented sanity check, not queried against.
    const q = b.wayIds
      ? `[out:json][timeout:120];way(id:${b.wayIds.join(',')});out geom;`
      : (() => {
          const [s, w, n, e] = b.bbox;
          const nameFilter = b.names.map((nm) => `way["railway"="rail"]["name"="${nm}"](${s},${w},${n},${e});`).join('');
          return `[out:json][timeout:120];(${nameFilter});out geom;`;
        })();
    console.log(`[${b.key}] ${b.label} -> ${[].concat(b.op).join('+')}`);
    const data = await overpass(q);
    const ways = (data.elements || []).filter((x) => x.type === 'way');

    let kept = 0, dropService = 0, dropNoUsage = 0, dropDup = 0, addedKm = 0;
    for (const way of ways) {
      const t = way.tags || {};
      if (t.service) { dropService++; continue; }        // siding / yard / crossover
      if (!t.usage) { dropNoUsage++; continue; }          // not a classified running line
      if (existingWays.has(way.id)) { dropDup++; continue; }
      const coords = (way.geometry || []).map((g) => [g.lon, g.lat]);
      if (coords.length < 2) continue;
      maxId += 1;
      const len = lengthOf(coords);
      // `op` may be one key or several — the Askern branch carries two
      // passenger operators and no single correct answer.
      const ops = Array.isArray(b.op) ? b.op : [b.op];
      added.push({
        id: maxId,
        nodes: way.nodes || [],
        coords,
        operators: ops,
        way_ids: [way.id],
        length_m: len,
        // See the header: keyed by operator so a dedupe union stays truthful.
        operator_precision: Object.fromEntries(ops.map((o) => [o, 'inferred'])),
        operator_source: 'way-tag',
        ingested_by: 'ingest-branch-ways.mjs',
        ingest_branch: b.key,
      });
      existingWays.add(way.id);
      kept++; addedKm += len / 1000;
    }
    console.log(`    ${ways.length} ways matched ${b.wayIds ? 'by id' : 'by name'} | kept ${kept} (${addedKm.toFixed(1)} km)` +
      ` | dropped: ${dropService} service, ${dropNoUsage} no-usage, ${dropDup} already in graph`);
    report.push({ ...b, matched: ways.length, kept, km: addedKm, dropService, dropNoUsage, dropDup });
  }

  console.log(`\nTotal new segments: ${added.length} (${added.reduce((a, s) => a + s.length_m, 0) / 1000 | 0} km)`);
  if (DRY) { console.log('DRY RUN — line-segments.json untouched.'); return; }

  graph.segments.push(...added);
  graph.segment_count = graph.segments.length;
  // Merge by key rather than replace outright — with --only, `report` covers
  // just the branches actually run this time, and a plain overwrite would
  // erase the record of every other branch's prior ingestion even though
  // their segments are still sitting in graph.segments untouched.
  const prevBranches = graph.branch_ingest?.branches || [];
  const thisRun = report.map((r) => ({ key: r.key, operator: r.op, segments: r.kept, km: +r.km.toFixed(1) }));
  const thisRunKeys = new Set(thisRun.map((r) => r.key));
  graph.branch_ingest = {
    generated_at: new Date().toISOString(),
    note: 'Way-level ingestion for branches with no OSM route relation. Attribution is inferred — see operator_precision.',
    branches: [...prevBranches.filter((r) => !thisRunKeys.has(r.key)), ...thisRun],
  };
  writeFileSync(SEG_PATH, JSON.stringify(graph));
  console.log(`Written: ${SEG_PATH} (${graph.segments.length} segments)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

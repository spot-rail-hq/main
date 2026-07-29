# Operator-colored rail line data — generation runbook

Produces the segment graph and color palette that `map.html` uses for
citylines.co-style operator-colored line rendering (Phases 5-7 — multi-
operator fan-out, From/To pathfinding, selected-station markers — are all
live). Mirrors `PROMPT3-TILES-RUNBOOK.md`'s structure. Everything below
was actually run in-session against a real local Overpass instance and real
station/OSM data — nothing here is guessed or aspirational. The one thing
still open is the final hosting/format decision for the largest output file
(`line-segments.json`) — flagged explicitly in Task 4 below, not decided
unilaterally.

## Pipeline overview

```
Overpass (self-hosted, GB extract)
   │
   ├─ Phase 0: scripts/build-operator-inventory.mjs
   │    → scripts/output/operator-inventory.json
   │      (raw operator/brand string → bucket/canonical mapping,
   │       via scripts/lib/operator-classify.mjs)
   │
   ├─ Phase 1: scripts/build-operator-palette.mjs
   │    → data/operator-colors.json
   │      (real corporate colors, CIE Lab ΔE76 + CVD-simulated
   │       distinguishability gating, dark/light themes)
   │
   ├─ Phase 2: scripts/build-line-segments.mjs
   │    → scripts/output/line-segments.json (or -checkpoint.json
   │      for a bounded bbox run — see LINE_SEGMENTS_BBOX below)
   │      (node-ID-matched segment graph, operators-per-segment)
   │
   ├─ Phase 3: scripts/build-station-graph-links.mjs
   │    → scripts/output/station-graph-links.json
   │      (each of the 2,637 NaPTAN stations snapped to its nearest
   │       SUITABLE point on the Phase 2 graph — operator/mode-aware,
   │       200m tolerance)
   │
   └─ Phase 6: scripts/build-graph-bridges.mjs
        →  scripts/output/graph-bridges.json
        └─ scripts/build-routing-graph.mjs
             → data/routing-graph.json
               (client-shipped From/To pathfinding graph — see Task 4b)
```

Run in that order — each phase's output feeds the next. `operator-colors.json`
(Phase 1) and `line-segments.json` (Phase 2) are independent of each other at
build time (both only depend on Phase 0's classification), but Phase 2's
segment `operators` arrays are colored using Phase 1's palette at *render*
time, not build time — so both need to be current before Phase 5 wiring.

## Prerequisites

- Local Overpass instance (same one `fetch-osm-facts.mjs` uses):
  `docker start srhq-overpass` if it's not already running, verify with
  `curl -s -m 5 http://localhost:12345/api/interpreter -d 'data=[out:json][timeout:5];out count;'`
  returns a 200. Override the endpoint with `OVERPASS_URL` if ever pointed
  at a different instance.
- Node.js (no other runtime deps — see "Why no turf.js" below).
- `station-list.json` (already in the repo root) for Phase 3.

## Why no turf.js, despite it being pre-approved as a dependency

The original plan approved `turf.js` as an offline-build-only dependency for
a coordinate-proximity fallback pass, anticipated to be needed where two
operators' relations run the same physical track but don't share OSM node
IDs (the original LNER/Grand Central scoping investigation found exactly
this). In practice, once the segment-graph builder ran across a full
corridor (not the narrow slice the original investigation checked), LNER and
Grand Central turned out to share 31–65 segments (up to 122km) via plain
node-ID matching. A second, structurally different corridor (Glasgow —
branches + a real closed loop) showed the same pattern: every operator pair
known to share track showed extensive node-level sharing, zero false
negatives found. `turf.js` was never added. If a future national anomaly
audit finds a real false negative, revisit this — the plan's Confirmed
Decisions section that approved it is still valid, it just hasn't been
needed yet.

---

## Task 1 — Phase 0: operator inventory

```bash
node scripts/build-operator-inventory.mjs
```

Queries all ~1,211 GB `train`/`light_rail`/`tram`/`subway` route relations'
tags (no geometry — fast, seconds not minutes), classifies each via
`scripts/lib/operator-classify.mjs`'s `classify()`, and reports bucket counts
(`toc`/`metro`/`heritage`/`excluded`/`unrecognized`). Re-run whenever OSM's
operator tagging might have changed materially (new TOC franchise change,
new metro system, etc.) — output is a report to review, not itself consumed
by later phases directly (Phase 2/3 call `classify()` live, not this file).

**If `unrecognized` is ever non-empty**: a new raw operator/brand string
showed up that isn't in `CANONICAL_TOC`/`CANONICAL_METRO`/
`CANONICAL_HERITAGE`/`EXCLUDED` in `scripts/lib/operator-classify.mjs` — add
a mapping there (not in this script — Phase 0 re-exports from the shared lib
so Phase 2/3 stay in sync automatically) before proceeding.

## Task 2 — Phase 1: operator color palette

```bash
node scripts/build-operator-palette.mjs
```

Writes `data/operator-colors.json`: real corporate/TfL-official colors
first (primary → secondary → algorithmic hue-nudge fallback, in that
priority order, each gated on CIE Lab ΔE76 ≥ 15 and CVD-simulated
(protanopia/deuteranopia) ΔE76 ≥ 15 for known-adjacent operator pairs), for
every TOC, metro/tram system, the shared heritage color, and the 20 TfL line
colors (14 London Underground/DLR/Elizabeth line/generic-Overground, plus
the 6 real 2024-renamed Overground lines added in this session). Console
output reports the full assignment table, any flagged (no-confident-source)
operators, and the CVD collision report — read it, don't just trust a clean
exit code, since flagged/collision cases are expected and by design not
auto-fixed (real brand colors sometimes just don't clear separation; operator
identity is never conveyed by color alone, so this is an acceptable
documented trade-off, not a bug).

**Currently flagged, unresolved**: Great Northern (GN) has no confident
source for its real color — placeholder is a purple-family hue, not a
guess presented as fact. Needs your input if a real source ever turns up.

## Task 3 — Phase 2: segment graph

```bash
# Bounded checkpoint first (always do this before a national run after any
# change to the graph-building logic) — defaults to the Doncaster–York–
# Newcastle + York–Harrogate corridor:
node scripts/build-line-segments.mjs

# Custom checkpoint corridor (s,w,n,e), with a label so it doesn't overwrite
# the default checkpoint file:
LINE_SEGMENTS_BBOX="55.55,-4.6,56.05,-3.75" LINE_SEGMENTS_LABEL="glasgow" \
  node scripts/build-line-segments.mjs

# Full national run, once a checkpoint looks clean:
LINE_SEGMENTS_NATIONAL=1 node scripts/build-line-segments.mjs
```

Pulls every colorable relation's track-only way members (`role=""` —
platform ways are excluded), their geometry, builds a fine-grained node
graph, splits into segments at junctions/dead-ends/operator-set-changes
(handles closed loops, e.g. Glasgow Subway, as a special case), and applies
two relation-level refinements before graph-building:

- **TfL line splitting** (`splitTflLine()` in the shared lib) — the bare
  `operator=Transport for London` tag doesn't distinguish individual lines,
  but every relation's own `name` tag does (`"Bakerloo line: A → B"`) — 100%
  match rate confirmed empirically, not assumed.
- **`RELATION_ID_OVERRIDES`** (same file) — a hand-verified, per-relation-ID
  table recovering relations that would otherwise be dropped as `excluded`
  (bad/missing operator tagging: `operator=Network Rail`, or no operator tag
  at all) but are real, currently-operating services — e.g. the Bittern
  Line, Peterborough–Lincoln Line, Edinburgh Trams, Blackpool Tramway, and
  several heritage railways. **This is deliberately NOT a blanket rule** —
  each entry was checked against a real source (operator's own timetable
  page, Wikipedia, or similar) before being added. Most `excluded`/`(none)`-
  tagged relations found during that audit were genuine noise (closed
  1960s branch lines, freight-only track, infrastructure loops, airport
  people-movers, a car-shuttle service) and were deliberately left alone —
  see the file's comments for the full reasoning per entry.

**Always checkpoint a bbox-bounded run before a national one** after
touching this script — the checkpoint report (segment count, operators-per-
segment histogram, longest segments, any-relations-that-failed) is cheap to
sanity-check and has caught two real bugs this way already: a `[bbox:...]`
scoping bug that silently pulled in a relation's full national extent (a
"corridor" segment that turned out to run to Plymouth), and would have
caught a `line-dasharray` MapLibre validation bug if it had been graph-side
rather than map.html-side.

**National run stats** (2026-07-15, current as of this runbook): 1,145
colorable relations (up from 1,113 base — the +32 is the TOC + heritage/tram
recovery overrides), 6,126 segments, 436,094 nodes. Runtime ~2 minutes
against the local Overpass instance, zero rate-limiting/retries needed.

## Task 4 — Phase 3: station-to-graph snapping

```bash
node scripts/build-station-graph-links.mjs
```

Snaps each of the 2,637 NaPTAN stations to its nearest **suitable** point on
the Phase 2 segment graph (true point-to-polyline distance, not just nearest
node — a station can sit mid-edge), via a degree-based spatial grid (not a
full R-tree — sufficient at this scale, no new dependency). 200m tolerance;
anything farther is reported as unsnapped with the true nearest distance
found, not silently forced. Current result: 2,546 / 2,629 snapped.

**Candidates are ranked by tier before distance** (2026-07-26 — pure
nearest-geometry snapping was putting National Rail termini on the tube line
running underneath them, see the script header): an operator the station is
actually served by beats the right mode alone, which beats anything else in
range. Current split: 2,421 operator-matched, 119 mode-matched only, 6
neither. The change moved exactly one station more than 50m (London
Marylebone, 21m onto a *Bakerloo-line* segment → 84m onto the Chiltern main
line, which is the whole point) and left the mean snap distance at 10.5m.
`snap_tier`, `snap_operators` and `nearest_distance_m` in the output record
why each station landed where it did.

The 83 unsnapped break into two categories — read
`scripts/output/station-graph-links.json` for full per-station detail:

- **11 are a `station-list.json` data gap**, not a graph problem — null
  lat/lon for Elizabeth-line-specific duplicate CRS codes that already exist
  correctly under another code (e.g. `LSX` duplicates `LST`).
- **83 are genuine graph gaps**, mostly OSM route-relation completeness
  issues on quieter branch lines (no relation exists at all, or an existing
  one is incompletely digitized) rather than anything wrong in this
  pipeline — see the Phase 3 checkpoint conversation for the traced
  examples (Weardale Railway, Wherry Lines via Acle, the Harrogate Line's
  truncated geometry). 59 of the 83 are more than 2km from any ingested
  track, i.e. their entire line is missing from Phase 2; fixing them needs a
  re-ingest, nothing here.

---

## Task 4b — Phase 6: routing graph (From/To pathfinding)

```bash
node scripts/build-routing-graph.mjs    # seed the node space
node scripts/build-graph-bridges.mjs    # scores candidates AGAINST that node space
node scripts/build-routing-graph.mjs    # apply the bridges
```

**Three commands, not two — these two scripts are a CYCLE.** Corrected
2026-07-29; the previous instruction here was bridges → routing, which is wrong
whenever the segment graph has changed. `build-graph-bridges.mjs` reads
`data/routing-graph.json` (for `node_coord` and component structure), which
`build-routing-graph.mjs` writes. Run bridges first against a stale routing
graph and it scores candidates in the OLD node space, emitting bridges whose
endpoints no longer exist. The next routing build then logs:

```
SKIP bridge for BXB: endpoint not present in this graph build (1637962126 / 1236166333)
```

…and drops them silently — the bridge list still says 25 while only 24 became
edges. Seeding routing first fixes it. It converges on the second pass (a third
changed nothing, verified 2026-07-29).

**Always check:** `bridge_edges` in the final routing log must equal
`bridges.length` in `graph-bridges.json`. If they differ, the cycle was run in
the wrong order.

Re-run all three after any Phase 2/3 rebuild. Neither script
needs Overpass any more (the bridge script's mode check used to; it now uses
the segment graph's own operator data, which is better evidence and offline).

- `build-graph-bridges.mjs` sweeps every disconnected island in the graph and
  welds the ones that are an OSM node-ID mismatch at a station throat rather
  than a real gap: same mode either side, within 150m, island carries at
  least one station. It reads the last `routing-graph.json` for node
  coordinates but recomputes components with previous bridge edges EXCLUDED,
  so repeated runs are stable. Output: `scripts/output/graph-bridges.json`
  (25 bridges, plus an `unbridged` list of the islands it deliberately left
  alone, with their measured gaps).
- `build-routing-graph.mjs` writes the client-shipped
  `data/routing-graph.json` (2.1MB raw / 416KB gzipped): node adjacency,
  real edge lengths, `station_node`, and per-edge geometry POINTERS —
  `segment_id` plus, for a segment split at a station, the two cut points
  `from_coord`/`to_coord`. **Not** array indices: the client reads geometry
  back from `operators.pmtiles`, where tippecanoe has simplified it per zoom
  (segment 970 is 356 points here, 36 in a z10 tile), so an index range
  addresses nothing. Coordinates survive simplification; indices don't.

Current connectivity: 2,513 of 2,546 snapped stations in the main component
(was 2,433 before the 2026-07-26 snapping/bridging work — 90.6% of random
station pairs routable, up from 84.3%). The 33 stranded are 9 islands whose
gap to the network is real missing track: the Harrogate line, the Bittern
line, the Marlow branch, Colne, Cromford, Duffield, Denby Dale, Sheringham/
West Runton, and the Isle of Wight (which is *correctly* isolated).

---

## Task 5 — Build the operators vector tile layer (2026-07-21, current schema)

`line-segments.json` (39.4MB raw / 6.2MB gzipped) hit the original plan's own
stated trigger for falling back to vector tiles ("only if the real file size
says otherwise") — for comparison, the largest existing plain-fetched JSON in
the repo (`stations-content.json`) is 1.1MB. Rather than a flat-JSON fetch
that blocks first paint, this is tiled the same way `gb-railways.pmtiles`
already is:

```bash
bash tile-generation/build-operator-tiles.sh
```

Runs `scripts/build-operator-tiles-geojson.mjs`, then `tippecanoe` to tile
its output. This script has been rewritten twice since first written
(2026-07-15) — the schema below is the CURRENT one; see the script's own
header comments for the full history if tracing an older tileset:

1. **v1 (superseded)**: one feature per SEGMENT, `operators` a comma-joined
   string (MVT properties are scalar-only), `operator_count` as a number.
   Multi-operator track rendered as a single neutral-grey line — couldn't
   show more than one color per physical corridor.
2. **v2, "true fan-out" (2026-07-15)**: one feature PER OPERATOR PER
   SEGMENT — a 6-operator segment becomes 6 identical-geometry features,
   each with a single `operators` key, `operator_index` (alphabetical
   position within that segment's own operator list) and `operator_total`.
   map.html rendered each as its own thin parallel `line-offset` lane,
   centered as `operator_index - (operator_total-1)/2`.
3. **v3, lane-continuity (2026-07-21, CURRENT)**: v2 looked fanned-out
   correctly in isolation but had a real, frequent visual defect — since
   `operator_index`/`operator_total` are both purely LOCAL to one segment,
   the same operator's absolute lane position swung every time the set of
   co-runners changed, which happens at nearly every junction (measured:
   28-47% of same-operator adjacent-segment-boundary pairs actually
   changed offset, across the Doncaster/LNER and Glasgow-checkpoint/
   ScotRail corridors — a visible sideways "jog", not a rare edge case).
   Root cause was RE-CENTERING by a per-segment total, not the ordering
   itself (alphabetical order between any two operators IS already globally
   consistent). Fixed by `assignStableLanes()` + `relaxLanes()` in the
   script: a BFS over the segment adjacency graph (segments sharing an OSM
   endpoint node) propagates one FIXED lane number per operator along each
   physically-connected corridor, with a bounded number of relaxation
   passes (8, chosen empirically — the algorithm does NOT reliably converge
   to a fixed point, a handful of segments at genuinely ambiguous
   multi-way junctions keep flip-flopping past ~pass 15, so a fixed count
   is used for determinism instead of "run until stable") to resolve
   conflicts from BFS visit order. The per-segment render value
   (`lane_offset`) then mean-centers using ONE fixed value per connected
   component, not per segment, so an operator's rendered offset only
   changes when its own lane genuinely had to be reassigned, not every time
   an unrelated neighbor joins/leaves. Verified: nationwide jog rate
   dropped to 0.6-3.6% across every checked operator (LNER, Southern,
   CrossCountry, Avanti West Coast, GWR, South Western Railway, Northern),
   down from 28-47%.

Current tile fields: `id` (unique per fan-out feature, `segment_id * 10 +`
enumeration index — unrelated to the lane number, only needs uniqueness for
map.html's `promoteId` hover feature-state), `segment_id`, `operators`
(single key), `lane_offset` (a plain number, already mean-centered — map.html
just scales it by zoom, no index/total math client-side anymore), `length_m`.

**Not built with `tilemaker`, deliberately** — `tilemaker` v3.1.0's `--input`
only accepts a raw `.osm.pbf` file (confirmed via `--help`, no GeoJSON
ingestion mode exists). Making it produce this layer would mean
re-implementing this entire pipeline's classification logic (Phase 0–3's
canonicalization, TfL splitting, `RELATION_ID_OVERRIDES`) a second time in
Lua — a duplicate that would silently drift out of sync with the real
(JS) one every time either changed. `tippecanoe` (GeoJSON → vector tiles,
arbitrary properties preserved losslessly, outputs `.pmtiles` directly) is
the right tool for tiling data that's already fully computed — same output
format, same R2/CORS/MapLibre pattern as `gb-railways.pmtiles`, just a
different generator for this one layer. `brew install tippecanoe` (v2.79.0
verified working).

**Verified, not just built (2026-07-21 rebuild).** STALE FIGURES — kept as the
record of what that rebuild verified, not as current values. Everything below
predates the dedupe stage entering the sequence, so its counts are PRE-dedupe.
Current post-dedupe values: **10,628 features**, tileset **9,579,487 bytes**,
54 distinct operators, plus the four `heritage_*`/`band` fields added
2026-07-29. Re-verify against a fresh run rather than trusting these:
- Output: `tile-generation/operators.pmtiles`, **9.33MB**.
- tippecanoe's own summary confirms all 9,268 fan-out features made it into
  the tiles (no silent drops): `9268 features, 3012721 bytes of geometry...`.
- Header/metadata read back correctly via the `pmtiles` npm package (a small
  Node script using `PMTiles`/a custom file-backed source, no CLI needed):
  22,068 tiles, zoom 5–14, GB bbox, `vector_layers` reports the `operators`
  layer with exactly the 5 current fields (`id`/`segment_id`/`operators`/
  `lane_offset`/`length_m`), tilestats layer count 9,268 — matches the
  fan-out math exactly (4,259 single-operator segments + 1,089×2 + 419×3 +
  237×4 + 106×5 + 16×6 = 9,268).
- **A live R2-hosted check the same session found the PREVIOUS deploy was
  stale** — fetching the actual production `operators.pmtiles` URL's
  metadata directly showed it was still v1 (6,126 features, no
  `operator_index`/`operator_total`/`lane_offset` at all) despite v2's code
  having existed locally since 2026-07-15 — i.e. Task 6 below had
  genuinely never been done, not just gone undocumented. Worth re-checking
  the live URL's metadata the same way after any future "is this actually
  deployed" doubt, rather than assuming a locally-built file made it to R2.

## Task 6 — Host on R2 (OPEN — needs your Cloudflare access)

Same steps as `PROMPT3-TILES-RUNBOOK.md` Task 2 — upload the CURRENT
`tile-generation/operators.pmtiles` (v3, lane-continuity — see Task 5) to the
same R2 bucket already hosting `gb-railways.pmtiles`, same CORS policy
(already scoped to `srhq.uk`/`www.srhq.uk`, no changes needed there),
**replacing** whatever's currently there. No Cloudflare account access from
here, same limitation as the original tiles runbook noted — every rebuild
of this file needs a human to actually push it to R2, this runbook can't do
that step for you.

`operator-colors.json` at 68KB needs no format decision — same pattern as
every other `data/*.json` file already committed directly to the repo.

---

## Task 7 — Quarterly OSM refresh checklist (next: October 2026)

The pipeline is pinned to whatever Overpass extract was loaded when the segment
graph was last built (currently OSM base **2026-07-12**). A quarterly refresh
re-runs `build-line-segments.mjs` from a fresh extract, which rebuilds the graph
— segment ids, geometry and counts all move. Everything below was verified
against the PRE-refresh graph and **must be re-measured afterwards**; none of it
carries over.

**1. Re-measure the lane optimiser.** `build-operator-tiles-geojson.mjs` reports
all three on every run — compare against the values it was accepted on. **All
three are POST-dedupe figures**; run `dedupe-line-segments.mjs` first or they
will not match (the span in particular reads 6.000 pre-dedupe and 7.000 post,
and acting on the pre-dedupe value visibly breaks fan-out width):

| figure | pre-refresh value |
|---|---|
| same-operator boundaries at ≥2 lane units | **4** (acceptance target was ≤10) |
| lane collisions | **0** (asserted at build time — a regression throws) |
| lane offset span / range skew | **7.000** / **0.000** (range −3.500..+3.500) |

If the span moves off 7.0, `LANE_FAN_ZOOM_STOPS` in `map.html` must be rescaled
with it — those stops are derived as `5/7 ×` a 5.0-unit baseline and the pairing
is documented at both ends.

**2. Drop the XR narrow relabel.** The Elizabeth line was relabelled from `LD` to
`XR` **in place** in `line-segments.json` (52 segments, matched by the member way
ids of the 24 `operator=GTS Rail Operations` route relations) because a full
graph rebuild was too costly at the time. `operator-classify.mjs` now maps
`'GTS Rail Operations': 'XR'` directly, so the refresh produces the correct
attribution on its own — **do not re-apply the relabel**, and check afterwards
that `XR` has ~52 segments (bbox roughly lon −0.97..0.33, lat 51.46..51.63,
Reading/Maidenhead to Shenfield plus the Abbey Wood branch) and that `LD` no
longer reaches east of the Greenwich meridian.

**3. Re-check the operators present in the tileset.** `map.html` reads the
PMTiles `tilestats` operator-value list to decide whether an operator has any
track before moving the camera (see `operatorTilesetKeys()`). That is only
authoritative while the list is complete — tippecanoe caps `values` at 100 per
attribute and there are currently 54 distinct operators. If a refresh pushes
that past 100, the list silently truncates; the client already detects this
(`count > values.length`) and falls back, but the pre-check stops working and
should be replaced rather than left degraded.

**4. Re-run the downstream graph.** `build-station-graph-links.mjs` →
`build-routing-graph.mjs` → `build-graph-bridges.mjs` → `build-routing-graph.mjs`.
Routing appears twice because Task 4b's last two scripts are a cycle — see there
for why, and check `bridge_edges` equals the bridge count afterwards.

**5. Re-check the heritage canonicalisation map — it is load-bearing.**
`scripts/lib/heritage-canonical.mjs` maps 247 raw OSM name/operator variants
onto 183 canonical railways. It is a JOIN, not a lookup table: a heritage
railway whose OSM name string is absent from the map is **dropped silently**,
with no error and no visible change to any total. OSM renames happen, and each
one moves a railway out of the graph without a warning. The build prints the
misses; check them on every refresh:

```bash
LINE_SEGMENTS_NATIONAL=1 node scripts/build-line-segments.mjs 2>&1 | grep -A100 'UNMAPPED HERITAGE'
```

Currently **90 strings** are reported unmapped. Most are sidings, works
railways, and museum yard track that are correctly excluded — the list is not a
to-do, it is a review queue. What matters is watching for a name you recognise
as a real passenger heritage railway appearing in it, which means the map has
gone stale against a rename.

**6. Confirm the geometry-integrity guard passed.** `build-line-segments.mjs`
refetches a 250-way deterministic sample after the way-fetch step and asserts
the geometry comes back identical, throwing if not. A clean run prints:

```
geometry integrity: 250 sampled ways refetched, all identical
```

Its absence means the guard was removed or the build did not reach that step —
either way the graph's lengths are unverified. See "Geometry integrity" below
for why this check is a refetch and not a shape heuristic.

**7. Known open attribution questions to re-check while the fresh data is
loaded** (found 2026-07-28, deliberately not chased): `LD` carries 68 features
around Glasgow (lat ~55.87) and two short fragments near Berkhamsted on the WCML
— Lumo runs neither. Possibly further classifier folds of the same class as the
GTS/Elizabeth bug, possibly legitimate OSM tagging of planned services.


## Task 8 — Heritage railway extraction (2026-07-29)

Heritage went from a token presence to real coverage in this pass: **122 → 2,506
segments** and **225 → 1,048 km**, spanning **174 distinct railways** in the
graph (169 reach the tileset as distinct `heritage_slug` values; the remainder
are canonical entries whose track is entirely outside live-railway scope).
Segment split by `heritage_type`: operating 2,262 · museum 129 · tramway 81 ·
funicular 21.

Every heritage segment carries `heritage_slug`, `heritage_type`,
`heritage_type_secondary` (only when a railway genuinely has two characters) and
`band` (`trunk`/`regional`/`local`/`micro`). These are attached **only to the
`Heritage` lane** of a segment — a shared segment like `["GW", "Heritage"]`
emits two features and the GW one is main-line track that must not inherit the
heritage railway's identity.

### Manual additions

**Statfold Barn Railway** is in the canonical map by hand. It is a genuine
operating narrow-gauge passenger railway but its OSM track carries no operator
or name tag that the extraction can key on, so no automated pass will ever find
it. If a future refresh reports it as unmapped or it vanishes from the graph,
the cause is upstream tagging, not the pipeline. Treat any similar hand-added
entry the same way: they are invisible to the extraction by construction.

### Character, not gauge, decides what counts

The include/exclude rule for miniature and narrow-gauge lines is **character,
not gauge**. A 15" line running a scheduled public passenger service over a
route between destinations (Romney Hythe & Dymchurch, Ravenglass & Eskdale) is a
railway and is included. A line of the same or wider gauge running circuits
inside a park, zoo, or garden centre is a ride and is excluded, regardless of
how substantial its equipment is. Gauge was tried first as the cheap rule and
rejected — it splits the wrong way at both ends, admitting park circuits while
excluding some of the best-known miniature main lines.

### History-mode candidates, deliberately not in the live graph

**Butterley Gangroad** and the **Cromford and High Peak Railway** were found
during the sweep and left out. Both are historically significant, neither runs a
present-day passenger service over the alignment in question, and the live
graph's contract is current operating railways. They belong to History mode's
OpenHistoricalMap layer, which already handles closed alignments — adding them
here would mean the live layer quietly carrying dead track, which is exactly
what the live-railway filter exists to prevent.

### Main-line expansion was declined, with figures

The heritage pass was constrained to be **purely additive**: it must not change
main-line attribution. That was measured, not assumed.

- Non-heritage track, previous graph vs this one (both post-dedupe): **5,249 →
  5,238 segments**, **21,485 → 21,499 km** — a **+0.07%** change on a pass that
  more than doubled total heritage coverage.
- The 11 fewer segments are accounted for: six were `railway=disused`,
  `construction`, or `razed` ways (the Maritime Line, a Huddersfield Line
  construction way, and three razed Clarkston-area goods branches) correctly
  removed by the live-railway filter, and the rest is re-segmentation around
  them.
- Introducing `classifyTags()` — the heritage-aware classifier that runs ahead
  of the legacy operator chain — changed main-line coverage at **zero of the 40
  coverage probes**. Southern, Merseyrail, c2c and Island Line all resolve
  exactly as before. The classifier is additive by construction (it only
  overrides when the legacy result is neither `toc` nor `metro`), and this is
  the measurement confirming it.

Route relations tagged `route=railway` are admitted **only when heritage**. The
containment test showed admitting them generally had zero effect on non-heritage
coverage while risking exactly the main-line contamination above, so the narrow
gate was kept.

### Geometry integrity — what was actually wrong, and what was not

A large apparent geometry gain (~+6,800 km of non-heritage track, on an
identical way set) drove a truncated-geometry investigation. The conclusion has
since been **corrected**, and it matters because the wrong version is easy to
rediscover:

- The comparison was **new PRE-dedupe against old POST-dedupe**. Dedupe removes
  parallel duplicate corridors and drops ~9% of segments; comparing across it
  manufactures most of the difference. Like-for-like the figure is +0.07% (see
  above). **28,285 km is the pre-dedupe national total and never ships** —
  21,499 km is what reaches the tileset.
- Ways 313501251, 384138096 and 380888776 were suspected stubs. All three are
  **complete**, matching Overpass exactly (498 m, 860 m, 1,585 m), in both the
  old and the new graph.
- A 250-way refetch sample found **zero** truncation. There is currently no
  evidence any way is being truncated.

**The guard that shipped, and why it is not a shape heuristic.** The obvious
check — flag ways whose point count looks implausibly low for their span — was
implemented, measured, and rejected. At ≥300 m on ≤3 points it flagged **1,488
ways**, and all 15 sampled were verified against Overpass as genuinely straight
(long fen and embankment straights, appearing in matching up/down pairs at
identical spans). Real rail geometry is straight often enough that shape carries
no signal at any threshold. What shipped instead re-requests a deterministic
250-way sample in a second, independent Overpass call and asserts identical
geometry — it tests the actual failure mode (a response delivering less than was
asked for) rather than guessing from the result's shape, has no false-positive
rate, and needs no threshold. It **throws**: a mismatch means every length in
the graph is suspect.

## Task 9 — Operator coverage gaps (findings, 2026-07-29)

Found by `scripts/verify-operator-coverage.mjs` (40 hand-verified probes, 700 m
tolerance, exit 1 on regression). Recorded, not fixed.

**Southern (SN).** 14 of 18 probes resolve to the GTR parent rather than to
Southern — most of the Southern/Thameslink/Great Northern/Gatwick Express
network is tagged at the Govia Thameslink Railway parent level in OSM, not per
sub-brand. Splitting them back out needs route-name matching shaped like
`splitTflLine()`; deferred, and the harness records GTR as a legitimate pass so
the state is explicit rather than silently green.

**Hull Trains, Grand Central, Lumo.** All three are open-access operators with
no route relation in OSM at all, so they have no network to extract — their
track exists only under the franchised operator that shares it. Nothing in this
pipeline can recover them; it needs either upstream relations or a timetable
source, neither of which is in scope.

**Merseyrail Kirkby.** No ME-keyed track within tolerance of Kirkby. Merseyrail
terminates there on a platform shared with Northern's Wigan service and the
approach is tagged for the Northern route. Recorded in the harness as a known
gap so it does not mask a future regression.

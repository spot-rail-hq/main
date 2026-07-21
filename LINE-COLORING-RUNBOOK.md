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
   └─ Phase 3: scripts/build-station-graph-links.mjs
        → scripts/output/station-graph-links.json
          (each of the 2,637 NaPTAN stations snapped to its
           nearest point on the Phase 2 graph, 200m tolerance)
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

Snaps each of the 2,637 NaPTAN stations to its nearest point on the Phase 2
segment graph (true point-to-polyline distance, not just nearest node — a
station can sit mid-edge), via a degree-based spatial grid (not a full
R-tree — sufficient at this scale, no new dependency). 200m tolerance;
anything farther is reported as unsnapped with the true nearest distance
found, not silently forced. Current result: 2,543 / 2,637 snapped (96.4%).
The 94 unsnapped break into two categories — read
`scripts/output/station-graph-links.json` for full per-station detail:

- **11 are a `station-list.json` data gap**, not a graph problem — null
  lat/lon for Elizabeth-line-specific duplicate CRS codes that already exist
  correctly under another code (e.g. `LSX` duplicates `LST`).
- **83 are genuine graph gaps**, mostly OSM route-relation completeness
  issues on quieter branch lines (no relation exists at all, or an existing
  one is incompletely digitized) rather than anything wrong in this
  pipeline — see the Phase 3 checkpoint conversation for the traced
  examples (Weardale Railway, Wherry Lines via Acle, the Harrogate Line's
  truncated geometry).

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

**Verified, not just built (2026-07-21 rebuild):**
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

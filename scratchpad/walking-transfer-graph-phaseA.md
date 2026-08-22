# Walking-transfer graph — Phase A feasibility

Report only. Nothing built, migrated, or written — all queries below are
read-only, run directly against the live `srhq-infra` Postgres, scratch
files deleted after. 2026-08-22.

---

## 1. Radius and candidate pairs

**`naptan_stations` schema, checked directly:**

```
tiploc | crs | name | lat | lon
```

Plain `double precision` lat/lon — **no PostGIS geometry/geography column**
despite living in a PostGIS-enabled database, and **no mode/network
distinction column at all**. 2,637 rows, 11 with null coordinates.

**Real distance counts** (cast to `geography` on the fly, `ST_DWithin`,
unordered pairs):

| radius | candidate pairs |
|---|---|
| 800m | 175 |
| 1200m | 534 |
| 1600m | 1,042 |

**The three named sanity-check pairs, real measured distances:**

```
London Kings Cross <-> St Pancras (main):        305m
London Kings Cross <-> St Pancras (Low Level):   338m
Birmingham Moor Street <-> New Street:           544m
Manchester Piccadilly <-> Victoria:             1,367m
```

**Manchester Piccadilly↔Victoria — one of the three pairs you specifically
asked about — is missed entirely at both 800m and 1200m.** It only appears
at 1600m. This is the single most important number in this section: a
radius chosen without checking this real case would silently exclude a
genuine, well-known interchange, which is exactly the failure mode Phase A
exists to fix.

**Does the pair count "balloon" at 1600m?** Checked directly rather than
assumed — growth is roughly proportional to radius² (175 → 534 → 1,042 is
close to the area-scaling you'd expect from a roughly uniform station
density), not a runaway explosion. But breaking the 1600m set down by
distance band surfaced a **real, separate problem that has nothing to do
with radius choice**:

```
under 150m:        13 pairs
150m-800m:        162 pairs
800m-1200m:       359 pairs
1200m-1600m:      508 pairs
```

Inspected the 13 sub-150m pairs directly — almost all of them are **the
same physical station complex recorded as two separate `naptan_stations`
rows**, not genuine cross-station walks: `Lichfield Trent Valley (High
Level)`/`Lichfield Trent Valley` (1m apart!), `Glasgow Central`/`Glasgow
Central Low Level` (131m), `Liverpool Lime Street`/`...Low Level` (100m),
`St Pancras`/`St Pancras LL` (72m), and one clear **duplicate NaPTAN
record**: `Highbury & Islington` appears twice, 10m apart, under two
different CRS codes (`HHY` and `HII`) — not a walking transfer at all, a
data-entry duplicate. **This is a real trap for Phase A's actual build**:
filtering by radius alone won't separate "genuine short walk between two
real stations" from "the same station counted twice." CLAUDE.md already
documents a `SAME_STATION`/`CLOSED_CRS` map inside `migrate-station-list.mjs`
built for exactly this kind of problem — Phase A's real implementation
should cross-check against that (or extend it) rather than re-deriving
station-equivalence from scratch.

**Would `naptan_stations` need enrichment first? Yes — confirmed with a
real example, not a hypothetical.** It has no mode/network column, and it
is **not** exclusively National Rail: `Newcastle Airport Metro Station` (a
Tyne & Wear Metro stop, not heavy rail at all) sits in the same 2,637-row
table with zero field distinguishing it from a real NR station. There's
also a real integration upside already in place: `naptan_stations.tiploc`
overlaps `tiplocs.tiploc_code` (the CSA router's own key) at **2,633/2,637
= 99.8%** — the exact same coverage figure already documented from the
SCHEDULE backfill work, same 4 known gaps. So the *join key* is solid;
what's missing is *classification*. The site already has mode/network data
(`station-list.json`, `data/station-regions.json`) that could supply this
without a new derivation — flagging that as the enrichment path, not
proposing new data collection.

## 2. Routing engine options — scoped, not chosen

**Real current VPS headroom, checked directly (not the task's assumed
~18GB free, which is stale):**

```
Disk:  38G total, 24G used, 13G free   (not ~18GB — ~5GB less than assumed)
RAM:   3.7GB total, ~483MB free right now, 1.8GB "available", 0B swap
CPU:   2 vCPUs
```

**Self-hosted OSRM:**
- A Great Britain OSM extract (Geofabrik-style `.osm.pbf`) is on the order
  of 1.4-1.6GB compressed — this is a general-knowledge estimate, not a
  live-verified download (downloading one would itself be "building," out
  of scope for this pass). Processing (`osrm-extract` + `osrm-partition`/
  `osrm-customize` for MLD) typically produces a few GB of derived `.osrm*`
  files for a country-sized foot-profile network; total disk footprint
  (source + derived, before cleanup) plausibly 8-15GB transiently, settling
  to maybe 5-10GB kept long-term. That alone would consume most or all of
  the real 13GB free.
- **RAM is the harder blocker, and it's a genuinely new finding the task's
  own framing didn't have**: this box has **3.7GB total RAM, no swap**,
  already running Postgres + the journey-search service + the
  darwin-subscriber. A one-time country-sized `osrm-extract`/`osrm-partition`
  run is commonly RAM-hungry enough (multi-GB, even for a foot-only
  profile, since pedestrian routing still has to load the full street/path
  network) that attempting it in-place risks OOM-killing something on this
  shared box — with zero swap configured, that's not a graceful degradation,
  it's a hard failure with a real chance of taking down the live services
  sharing the machine. Feasible only via either (a) temporarily resizing
  the Hetzner instance for the one-time build then scaling back down, or
  (b) building the dataset on separate hardware and shipping only the
  finished `.osrm*` files to the VPS to serve from (serving via
  `osrm-routed` needs meaningfully less RAM than building does). Either
  way, this is real added operational complexity, not a quick add.

**Google Directions API, one-time batch call per pair:**
- Call count *is* the pair count from §1: **175 / 534 / 1,042** calls at
  800/1200/1600m respectively. Even at 1600m this is a trivially small
  one-off batch — On the order of low single-digit dollars total at
  Google's published per-request Directions API pricing (stating this as
  an approximate order-of-magnitude, not a verified current quote — I
  didn't call Google's pricing API to confirm current rates, since that's
  outside a report-only pass).
- Given the refresh cadence is **quarterly**, not continuous, this is a
  batch job that runs a few times a year and then sits idle — which is
  exactly the shape a one-off API bill fits well, and exactly the shape
  standing infrastructure (OSRM, kept running, patched, monitored) fits
  poorly. No ongoing server footprint, no RAM risk to the shared VPS, no
  new failure mode to operate.

**Straight-line distance:** flagged as explicitly asked, not recommended.
Known-unreliable in precisely the cases that matter for this project — a
river, a rail cutting, or a one-way pedestrian system between two stations
can make the real walk substantially longer than the straight-line figure
implies (Birmingham Moor Street↔New Street's 544m straight-line, for
example, is a plausible candidate to check for exactly this once real
routing data exists — worth verifying, not assuming, once Phase B runs
real routes). Useful only as a cheap upper-bound/pre-filter before a real
routing call, never as the transfer-time value itself.

## 3. Schema and integration shape (proposed, not created)

```sql
-- PROPOSAL ONLY — not created
CREATE TABLE walking_transfers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_tiploc   text NOT NULL REFERENCES tiplocs(tiploc_code),
  to_tiploc     text NOT NULL REFERENCES tiplocs(tiploc_code),
  walk_minutes  integer NOT NULL,
  source        text NOT NULL CHECK (source IN ('osrm', 'google_directions', 'straight_line_estimate')),
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_tiploc, to_tiploc)
);
```

One row per **unordered** pair (`from_tiploc < to_tiploc`, same
direction-independent convention this codebase already uses for line
segments — see CLAUDE.md's node-chain-keying note), treated as symmetric by
the router at query time. Pedestrian one-way systems exist in principle but
are a rare enough edge case that modeling directionality here isn't worth
the complexity for Phase A — flagging that as a deliberate simplification,
not an oversight.

**Does this drop into the CSA router's existing connection-scan loop?
No — and this is worth being direct about, since it's the one place a
"just add a mode flag" framing would be actively misleading.**

`run_csa()` currently processes one globally time-sorted list of
connections, each with a **fixed, precomputed `dep_dt`/`arr_dt`** baked in
at graph-build time (once per date, then cached). A real train's departure
time is a calendar fact, known in advance, sortable up front. A walking
transfer has no such fact — you can walk between two stations whenever you
arrive at the first one, and *when* that is depends on which real trains
got you there, which isn't known until the search actually runs. There is
no fixed `dep_dt` to precompute and sort into the connections list the way
every other row in it has.

This is the standard "footpath" extension in CSA/RAPTOR literature, and
it's a **structurally different mechanism**, not a data-shape change:
whenever a real connection improves `earliest_arrival` at some station,
the algorithm must *also* immediately check every walking-transfer neighbor
of that station and see whether arriving there `walk_minutes` later would
improve *its* earliest arrival too — a relaxation step interleaved with the
existing scan, not more rows sorted alongside the rail connections. Building
this is a real, scoped piece of router work (touching `run_csa()`'s core
loop), not a drop-in read from a new table. Flagging this now so Phase A's
actual build prompt doesn't underscope it as "add a table + a mode flag."

## 4. Performance sanity check

At the recommended radius (see below), on the order of ~1,000 unordered
pairs → roughly 1,000-2,000 directional edges depending on how the router
ends up representing symmetry internally. Against the CSA router's existing
**626,260 schedules** (and the ~564,000 real connections a single two-day
search already scans), this is **under 0.3% by count** — negligible as raw
data volume. The real cost isn't the edge count, it's the algorithmic
change in §3 (footpath relaxation checked per improved station, not per
edge scanned) — and because the walking-edge set stays in the low
thousands regardless of which radius wins, that per-station relaxation
check stays cheap too. Nothing here suggests a performance concern at any
of the three radii tested.

---

## Recommendation

**Radius: 1600m.** 800m and 1200m both miss a real, named interchange
(Manchester Piccadilly↔Victoria) that Phase A exists specifically to catch
— a radius that fails its own named test case isn't a real option. 1600m's
higher pair count (1,042 vs 534/175) is not runaway growth (confirmed
proportional to area), and the actual noise found (13 near-duplicate
same-station pairs) exists at every radius equally and needs the same fix
(cross-check against `SAME_STATION`-style station-equivalence data)
regardless of which radius is chosen — it's not a reason to shrink the
radius, since shrinking it wouldn't remove those duplicates anyway (the
closest one is 1m apart).

**Routing engine: Google Directions API, one-time batch.** ~1,042 calls at
the recommended radius is a trivial, cheap one-off matching the quarterly
refresh cadence exactly. Self-hosted OSRM is not ruled out as impossible,
but this specific VPS's real headroom — 13GB disk (not the assumed 18GB)
and, more importantly, **3.7GB total RAM with zero swap, already shared
with live production services** — makes an in-place build a real
operational risk, not a routine one; it would need either temporary
hardware resizing or building elsewhere and shipping the result over.
Given the workload is inherently batch/infrequent, not continuously-served,
standing up and maintaining that infrastructure buys little the batch API
approach doesn't already cover more simply and more cheaply.

**Before Phase B's actual build**: resolve the same-station-duplicate
question (reuse/extend `migrate-station-list.mjs`'s existing
`SAME_STATION` map rather than re-deriving it) and confirm the
mode/network enrichment source for excluding non-NR entries like the
Newcastle Airport Metro case — both are real, concrete gaps found here,
not theoretical ones.

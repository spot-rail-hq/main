# Phase A, step 3, Part 1 — footpath-relaxation integration investigation

Report only. `run_csa()` (srhq-journey-search/service.py:328-377) read in
full alongside its callers (`build_connections_for_date`, `merge_legs`,
`search()`) — no code changed anywhere.

---

## 1. Current structure of `run_csa()`

```python
def run_csa(connections, origin_tiplocs, dest_tiplocs, depart_after):
    connections = sorted(connections, key=lambda c: c["dep_dt"])
    earliest_arrival = defaultdict(lambda: None)
    predecessor = {}
    trip_reached = set()
    for t in origin_tiplocs:
        earliest_arrival[t] = depart_after
    for c in connections:
        ...
```

**Connections**: a flat list of dicts, one per calling-point-to-next-
calling-point hop of a single scheduled service — `{schedule_id,
train_uid, atoc_code, dep_tiploc, dep_dt, arr_tiploc, arr_dt}`, built once
per calendar date by `build_connections_for_date` and sorted globally by
`dep_dt` at the top of `run_csa` — this is a textbook single-pass CSA scan.

**Earliest-arrival tracking**: `earliest_arrival` is a plain dict
(`tiploc -> datetime`), seeded to `depart_after` for every origin tiploc
before the scan starts. `predecessor` (`tiploc -> connection dict`) records
*which connection* produced the current earliest arrival at a stop, and is
walked backwards after the scan to reconstruct the journey.

**The scan itself**, one pass, connections in departure order:
- `trip_reached` (a set of `schedule_id`) implements "once you've boarded a
  service, later hops of that same service are always boardable" without
  re-checking the origin stop's earliest-arrival each time — this is the
  standard in-vehicle-continuation trick, and is untouched by anything
  below.
- Otherwise, a connection is boardable only if its `dep_tiploc`'s
  `earliest_arrival` is set and departs at or after that time plus a
  transfer buffer — `MIN_TRANSFER_MINUTES` (5), waived only for the very
  first boarding at an origin stop.
- If boardable: mark the trip reached, and if the connection's `arr_dt` is
  strictly earlier than the current `earliest_arrival` at `arr_tiploc`,
  update both `earliest_arrival` and `predecessor` for that stop.

After the scan: pick whichever `dest_tiplocs` entry has the earliest
`earliest_arrival`, then walk `predecessor` backwards from there to the
origin to build the return chain.

**Pruning that already exists: none, inside the algorithm itself.** No max
duration, no max-changes limit, no target-arrival deadline — `depart_after`
is a lower bound only. The only thing that bounds the search space at all
is external to `run_csa`: `search()` only ever builds and passes in
connections for exactly two calendar dates (the query date and the day
after), so the practical bound is "how many scheduled services run across
two days," not any explicit cutoff inside the CSA scan. It's also strictly
single-criterion — arrival time only. It does not track number of changes
at all, so among two options with identical earliest-arrival, there's no
tiebreak preferring fewer changes; that's a pre-existing property, not
something footpaths change.

## 2. Does the textbook footpath-relaxation shape fit? Mostly — with one real gap and one real complication

**The textbook shape does apply correctly, algorithmically.** Relaxing
footpaths immediately whenever a stop's earliest-arrival improves is valid
here for the same reason it's valid in the standard algorithm: footpaths
have no fixed departure time, so relaxing them out-of-band (not as entries
in the sorted connection scan) doesn't break the forward-in-time invariant
the scan depends on — any stop a footpath relaxation improves can only
ever matter to connections *later* in the sorted scan (a footpath always
takes non-negative time), so relaxing inline, the moment an improvement
happens, is safe and matches how the connections loop already only acts on
strict improvement (`c["arr_dt"] < cur_ea`).

**Real gap #1 — the origin case.** As written, `run_csa` seeds
`earliest_arrival` for origin tiplocs and goes straight into the connection
scan. The textbook version also relaxes footpaths *from the origin*
before scanning begins — e.g. walking from Birmingham Moor Street to New
Street to catch a specific train should be considered from the start, not
only ever reachable by first boarding a train that happens to call at Moor
Street. Skipping this pre-scan relaxation is a real, silent gap, not a
theoretical one — it would make walking transfers work only when they
follow a train leg, never when they could substitute for the very first
leg.

**Real gap #2 (bigger) — the output contract.** `predecessor[stop]`
today is *always* a scheduled connection dict, and every downstream reader
assumes that unconditionally:
- `merge_legs()` merges consecutive chain entries by comparing
  `schedule_id` — a footpath "leg" has no `schedule_id`, so as written this
  either throws `KeyError` or needs an explicit branch added.
- `search()` builds each leg's JSON output from `train_uid`, `atoc_code`,
  and calls `get_live_status()` against Darwin for both ends of every leg —
  a walk has no train_uid/atoc_code and no Darwin event to look up at all.

So a footpath "connection" needs to be a *distinguishable* shape (e.g. a
`kind: "walk"` marker, no schedule_id/train_uid/atoc_code, dep_dt/arr_dt
computed from walk_seconds rather than a timetable) — and every one of the
3 downstream consumers above needs an explicit branch for it. This isn't
optional polish; without it the existing pipeline will crash or silently
mis-render the moment a footpath actually wins a chain.

## 3. Data integration — confirmed against the real table, not assumed

Query per tiploc `t`, since storage is unordered (`tiploc_a < tiploc_b`,
one row per pair, not two):

```sql
SELECT tiploc_a, tiploc_b, walk_seconds, walk_seconds_reverse
FROM walking_transfers
WHERE tiploc_a = %s OR tiploc_b = %s;
```

Direction handling, confirmed to match the convention exactly as specified:
- If `t = tiploc_a` (walking A→B): always use `walk_seconds`.
- If `t = tiploc_b` (walking B→A): use `walk_seconds_reverse` **if not
  NULL**, else fall back to `walk_seconds` — NULL means "confirmed
  symmetric," populated only for the 6 real elevation-driven exceptions.

For `run_csa()`, this should be loaded **once per search into an in-memory
dict** (`tiploc -> [(neighbor, walk_seconds), ...]`), not queried per
relaxation — 1,038 rows total, trivially small, and this matches the
existing `load_or_build_date` pattern (build once, cache in memory,
reuse) rather than adding a DB round-trip inside the hot scan loop, which
would be a real, avoidable regression if done naively.

## 4. Manchester Piccadilly ↔ Victoria (1,618m, ~1,316s / 22min) — does existing pruning suppress it?

**Checked directly against what's actually in the algorithm (section 1),
not assumed: partially, and not for the reason that would make it safe to
skip a cutoff.**

The *only* thing that would ever suppress this walk is the same strict-
improvement check every relaxation already uses: if a real all-rail
connection reaches the same destination stop with a strictly earlier
`earliest_arrival` than "arrive at Piccadilly, then walk 22 minutes," the
walk is never recorded, because `earliest_arrival` only ever holds the
single best time per stop. In that specific sense, yes — a genuinely worse
walking option that loses on arrival time is naturally never offered, no
hand-tuned cutoff needed for *that* case.

**But this is single-criterion optimization on arrival time alone, and
that's a real, non-hypothetical hole.** Nothing stops a 22-minute walk from
winning outright whenever it produces an earliest arrival even a single
minute better than every rail alternative — e.g. a walk that arrives one
minute sooner than waiting for the next direct train would be offered by
the algorithm exactly as written, with no sense that "waiting 21 minutes on
a platform" is obviously preferable to "walking 22 minutes to save 60
seconds." There is no walking-time ceiling, no penalty, no secondary
tiebreak on effort or transfer count anywhere in `run_csa` today.

**Conclusion: existing pruning does not generically protect against this.**
It only suppresses a walk when a faster alternative to that exact stop
already exists — it provides zero protection against a walk that's
technically fastest by a trivial margin. A cutoff (or an equivalent
preference rule) is a real decision that needs to be made deliberately; it
does not fall out of the current algorithm for free.

## 5. Proposed structural approach (not built)

- **New loader**, e.g. `load_footpaths(conn)`: one query against
  `walking_transfers`, returns the direction-resolved adjacency dict from
  section 3. Cache it the same way connections are cached (load once,
  reuse across searches) — footpath data changes rarely, unlike
  per-date schedules.
- **`run_csa()` gains an optional `footpaths` parameter.**
  - Pre-scan: after seeding `earliest_arrival` for origins, relax each
    origin's footpath neighbors once (`depart_after + walk_seconds`),
    closing real gap #1 above.
  - In-scan: immediately after the existing arrival-improvement block
    (current lines 352-355), if that improvement just happened, relax the
    improved stop's own footpath neighbors the same way, repeating until no
    further improvement ripples out from that update (a small
    improvement-only fixed-point loop — safe by construction since it only
    ever fires on strict improvement, mirroring the connections loop's own
    guard, and the footpath graph is sparse: 1,038 edges over ~2,637
    stations, mostly isolated pairs rather than dense clusters, so expected
    chain depth is shallow).
  - Predecessor entries for a footpath relaxation need their own
    distinguishable shape (`kind: "walk"`, no `schedule_id`/`train_uid`/
    `atoc_code`), per real gap #2.
- **Downstream changes required, not optional**: `merge_legs()` needs an
  explicit non-merging branch for a walk-shaped chain entry;
  `search()`'s leg-building needs a walk-specific branch that renders walk
  duration/distance instead of train fields and skips the Darwin
  live-status lookup entirely (there's no scheduled event to check).
- **Cutoff, per section 4's finding**: recommend the simplest form — a
  hand-set walk-time ceiling applied when *building* the footpaths dict
  (exclude edges above it entirely, rather than truncating post hoc). This
  is consistent with how `MIN_TRANSFER_MINUTES` is already a hand-set
  constant in this codebase, and it changes zero of `run_csa`'s core
  optimization semantics — it only shrinks which footpath edges the
  algorithm is allowed to use at all. The alternative (a walking-time
  penalty baked into the comparison itself) would turn this from a clean
  single-criterion shortest-arrival search into a weighted one — a bigger,
  harder-to-reason-about change to an algorithm whose main virtue right now
  is being simple and easy to trust. Not proposing that for a first cut.

### Architectural risk, flagged plainly

- **Highest risk: the output-shape contract.** `run_csa`'s return value
  (`predecessor` chain) is currently assumed identical in shape by 3
  separate downstream functions, none of which defensively check what kind
  of entry they're looking at. Adding a second entry "kind" means all 3
  must be updated in lockstep or the failure mode is either a hard crash
  (`KeyError` on `schedule_id`/`train_uid`) or, worse, a walk silently
  rendered as if it were a train leg. This is the real risk in this change
  — not the CSA math, which is a small, well-understood extension, but
  the fact that 3 independent consumers currently trust one implicit shape.
- **Termination**: the in-scan relaxation loop must only fire on strict
  improvement (same guard the connections loop already uses) to avoid any
  risk of cycling — the footpath graph being sparse makes this unlikely to
  matter in practice, but it should be built as a real fixed-point loop,
  not assumed safe.
- **Performance**: fine in principle (footpath dict lookup is O(1) per
  relaxation, and only fires on the already-rare event of an arrival
  improvement) — but only if the footpaths dict is loaded once and cached,
  not queried per relaxation inside the scan loop. Flagging this
  explicitly since it's an easy mistake to make by analogy to "just query
  it where it's needed."
- **Verification**: this service is already deployed and already verified
  against 3 real itineraries. Any implementation of this needs those exact
  3 itineraries re-run and confirmed either identical or deliberately,
  explainably different afterward — a footpath bug that silently changes
  an already-correct existing itinerary would be a worse outcome than one
  that simply fails to add walking options at all.

---

## Not done, per scope

No code changes to `run_csa()`, `merge_legs()`, `search()`, or anywhere
else in `srhq-journey-search`. No new function written. This is
investigation and a proposal only.

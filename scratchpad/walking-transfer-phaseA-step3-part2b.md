# Phase A, step 3, part 2b — footpath relaxation wired into the live search path

Investigated first, implemented second, verified live third, per the ask.
Local edit to `srhq-journey-search/service.py` — **not committed**
(`git diff --stat`: 134 changed, 103 insertions, 31 deletions across this
step + part 2a combined).

---

## Investigation 1 — timing

Re-ran the exact 4 part-2a cases with wall-clock timing, footpaths on vs
off, real DB, real schedule data (2026-08-24 08:00 query):

```
load_footpaths()            3.7ms      (1,038-row table — trivial)
connection-build (2 days) 4,435.4ms    (pre-existing cost, unrelated to footpaths)

run_csa() timing, OFF vs ON:
Solihull -> Telford Central:        684.5ms  vs 685.5ms   delta  -1.0ms
Solihull -> Moor Street:            660.8ms  vs 696.5ms   delta +35.7ms
Solihull -> Manchester Piccadilly:  707.5ms  vs 678.7ms   delta -28.8ms
Whitby -> Windermere:               646.6ms  vs 672.8ms   delta +26.2ms
```

**Conclusion: safe to ship.** `load_footpaths()` is cheap enough (~4ms) to
call once per request rather than needing its own cache tier the way the
per-date connections graph does — implemented that way (item 6). The
footpath relaxation's own cost inside `run_csa()` is noise-level (±20-36ms
against a ~650-710ms baseline that's already dominated by the 558k-
connection scan itself, unrelated to this feature) — sometimes faster,
sometimes slower, no systematic regression. The real cost in the request
path remains connection-build (~4.4s cold, ~5ms once memory-cached per
`load_or_build_date`'s existing tiering) — nothing this step touches.

## Investigation 2 — connection-risk classification

**Not a drop-in substitution. Real new logic was needed, confirmed by
reading both `classify_connection_risk()` and `get_live_status()`/
`_darwin_event_lookup()` directly before writing anything.**

`classify_connection_risk(incoming_arrival_status, wait_minutes)` itself
is already fully generic — a status dict plus a number — and needed **zero
changes**. What needed real new logic is the **caller's** decision of
*which* status and *which* wait to feed it, for two structurally new
interchange shapes that only exist once a walk leg can appear:

1. **Train-arrives → walk-starts.** The existing model computes `wait =
   next_leg.dep_dt - cur_leg.arr_dt`, which is always exactly `0:00:00`
   for this boundary (a walk starts the instant you step off the train, by
   construction — see `_relax_footpaths()`). Feeding that straight into
   the existing scale would report **"tight"** (0 min < the 5-minute
   `CONNECTION_RISK_BUFFER_MINUTES` floor) for a boundary where there is
   nothing to actually miss — a walk has no fixed departure a delay could
   cause you to lose. This needed an explicit new branch, not a
   substitution: these changes now get `{"risk": "n/a", "reason": "next
   leg is a walk transfer... there is no departure to miss"}` instead of
   running through `classify_connection_risk()` at all.

2. **Walk-arrives → train-departs** — the boundary that *is* a genuine,
   missable connection. The wait computation is still valid unchanged
   (arrival-at-destination-of-walk to departure-of-next-train is a real
   platform wait). But the *incoming arrival status* can't come from a
   Darwin lookup keyed to the walk's own synthetic `dep_dt`/`arr_dt` —
   confirmed directly from `_darwin_event_lookup()`'s own query, which
   joins on `tiploc + event_type + scheduled HH:MM string` within a
   12h-before/2h-after window, **not** on any real identifier. A walk's
   fabricated time isn't just "no data" if fed through that — it's a real
   risk of silently attaching some *other*, unrelated real train's actual
   live status to the walk, if that other train happens to share the same
   station and HH:MM. So instead, the walk->train risk must be sourced
   from the **last real (non-walk) leg before the walk** — its already-
   computed arrival status is reused directly (its own `dep_tiploc`/`dep_dt`
   are, by chain-continuity, identical to the walk's `dep_tiploc`/`dep_dt`
   anyway, so nothing is lost by reusing it rather than re-deriving it).
   A delay on that real train propagates through the walk's fixed duration
   unchanged, which is exactly the quantity that determines whether the
   connecting train is still catchable.
   - **Edge case, handled explicitly**: if the walk chain runs all the way
     back to the very first leg of the journey (the origin's own first hop
     is itself a walk), there's no preceding train at all — reported as
     `{"risk": "unknown", "reason": "no preceding scheduled service before
     this walk..."}`, consistent with `classify_connection_risk()`'s own
     stated philosophy of never asserting "fine" from absent data.

## Implementation

- **`merge_legs()`**: rewritten to check `.get("type")` on both sides
  before ever touching `schedule_id` — two entries only continue the same
  trip if **both** are real scheduled connections with matching
  `schedule_id`. A walk entry is never merged into anything in either
  direction (in particular, this can't `KeyError` the way indexing
  `["schedule_id"]` directly on a walk entry would).
- **`search()`**: `leg_statuses` now explicitly returns `None` for any leg
  with `type == "walk"` — never calls `get_live_status()` for one, guarded
  by the same `.get("type") == "walk"` check throughout, not a silent
  no-op. Leg JSON gained a `"type"` field on every leg (`"train"` or
  `"walk"`, additive — no existing field removed or renamed); a walk leg
  carries `walk_seconds` instead of `train_uid`/`atoc_code`/`live_status`.
  `changes` now runs through the two-branch logic from investigation 2
  above; the plain train→train case is untouched and falls through to the
  exact same `classify_connection_risk()` call as before (confirmed
  byte-identical for every non-footpath itinerary, same as part 2a).
- **`footpaths = load_footpaths(conn)`** is now called directly inside
  `search()` and passed into `run_csa()` — the live endpoint uses this by
  default, unconditionally, per item 6.

## Live re-verification (real `search()`, real DB, 2026-08-24 08:00)

Ran via a script that wraps `get_live_status` to record every real call it
receives, then asserts zero of those calls match any walk leg's own
tiploc+time — not just eyeballing the JSON.

**1. Solihull → Birmingham Moor Street — unaffected.** 1 train leg, 0 walk
legs, `0:15:00`, identical shape to before.

**2. Solihull → Manchester Piccadilly — differs from the old baseline, as
expected.** `2:18:00` (was `3:20:00` pre-footpaths). Legs: train
(Solihull→Moor St) → **walk** (Moor St→New St, 762s, no `live_status`,
no train fields) → train (New St→Wolverhampton) → train
(Wolverhampton→Piccadilly). Changes: Moor St change is `risk: "n/a"`
(walk transfer); New St change is `risk: "unknown"` with the standard
"not a confirmed actual" reason (correctly sourced from the Moor
St→New St walk's *preceding train's* arrival status, not a fabricated
Darwin lookup); Wolverhampton change is a plain train→train `"unknown"`,
identical in shape to how any ordinary interchange renders. Darwin call
count: exactly 6 (2 per train leg × 3 train legs, 0 for the walk) —
asserted programmatically, not just inspected.

**3. Whitby → Windermere — unaffected.** 6 train legs, 0 walk legs,
`6:12:00`, identical to before; 12 real Darwin calls (2 × 6), all for
train legs.

**4. Solihull → Telford Central — the original bug case, via the live
path.** `1:21:00` (was `2:49:00`). 2 train legs + 1 walk leg
(Moor St→New St, 762s). Darwin calls: exactly 4 (2 × 2 train legs), 0 for
the walk — asserted, not assumed.

**Every case**: walk legs carry no `live_status`, no `train_uid`, no
`atoc_code`; train legs are unaffected in shape beyond the additive
`"type"` field. Confirmed programmatically in all 4 cases: `len(darwin_
calls) == 2 * count(train_legs)` exactly, and zero of those calls matched
any walk leg's own (tiploc, time) pair.

---

## Not done, per scope

Nothing beyond what was asked. The VPS test directory (which briefly held
the DB password) was deleted after the run, same as every prior step.

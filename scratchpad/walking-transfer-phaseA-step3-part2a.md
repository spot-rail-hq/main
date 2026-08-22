# Phase A, step 3, part 2a — footpath relaxation in run_csa(), isolated

Implemented in `srhq-journey-search/service.py` (local edit, **not committed
— 76 insertions, `git diff --stat` confirms nothing else touched**). Tested
via a standalone harness run in a throwaway VPS container, real DB, real
schedule data. **`merge_legs()`, `search()`, the live `/journey-search`
endpoint, and any Darwin live-status lookup are completely untouched** —
confirmed by `git diff` only ever touching the constants block and the
region between `bulk_resolve`... `resolve_stations`/`run_csa`.

---

## What was built

**`MAX_FOOTPATH_SECONDS = 900`** — same style/location as
`MIN_TRANSFER_MINUTES`, a hard exclusion applied at load time, not a
penalty.

**`load_footpaths(conn)`** — one query against `walking_transfers`,
returns `tiploc -> [(neighbor, walk_seconds), ...]`. Ceiling applied
**per direction independently**: `walk_seconds` gates the `a->b` edge,
`walk_seconds_reverse` (falling back to `walk_seconds` when NULL) gates
`b->a` separately — an edge can in principle be excluded one way and kept
the other, though nothing in the current 1,038-row dataset actually hits
that case.

**`_relax_footpaths(stop, footpaths, earliest_arrival, predecessor)`** —
the fixed-point relaxation helper: given one stop whose `earliest_arrival`
just improved, walks outward across every footpath edge, including edges
chained through a neighbor that itself just improved, stopping only when
no further strict improvement is found. Same termination argument as
proposed in part 1: it only ever re-queues a stop on strict improvement
(mirrors the connections loop's own `c["arr_dt"] < cur_ea` guard), so even
the dataset's three genuinely ~0-second edges (real, co-located platforms)
can't cause a cycle — an equal-value relax is never re-queued.

**`run_csa(..., footpaths=None)`** — new optional last parameter, default
`None`. Existing callers (i.e. `search()`, unmodified) are unaffected:
`if footpaths:` guards both call sites, so passing nothing at all skips
every line of new code. Two call sites added, exactly per the part 1
proposal:
- **Pre-scan**: once per origin tiploc, right after origins are seeded,
  closing the "walk-from-origin-before-boarding-anything" gap flagged in
  part 1.
- **In-scan**: immediately after the existing arrival-improvement block,
  whenever a connection just improved a stop's `earliest_arrival`.

## Tagging scheme — what part 2b builds against

**A footpath-derived predecessor entry carries `"type": "walk"`.
Scheduled-connection entries are left completely unmodified — no `"type"`
key at all, not even `"type": "train"`.** Downstream code should treat
`entry.get("type") == "walk"` as the walk-leg check; anything else (which
happens to coincide exactly with "has a `schedule_id` key") is a scheduled
connection.

This was a deliberate choice over tagging both shapes: `run_csa()`'s
internal `trip_reached` logic only ever consults `c["schedule_id"]` for
entries drawn from the `connections` iterable itself, and a footpath
relaxation entry is *never* pushed into that iterable — it only ever lives
in `predecessor`, reached solely via the chain-reconstruction walk at the
end. So there's no code path anywhere that needs the untouched dicts to
carry a marker; adding one would be a no-op change to the existing hot
loop for no behavioural benefit.

A walk entry's shape, for 2b's reference:
```python
{
    "type": "walk",
    "dep_tiploc": <stop walked from>,
    "dep_dt": <time the walk started>,
    "arr_tiploc": <stop walked to>,
    "arr_dt": <dep_dt + walk_seconds>,
    "walk_seconds": <int>,
}
```
No `schedule_id`/`train_uid`/`atoc_code` — deliberately, so `merge_legs()`
can't accidentally treat a walk as continuing the same schedule.

One behavioural detail worth confirming explicitly rather than leaving
implicit: **a stop reached via footpath relaxation is not exempt from
`MIN_TRANSFER_MINUTES`** on its next boarded connection, even for the
dataset's ~0-second edges. The `is_origin` waiver in the boarding check
only fires for a tiploc that is itself literally in `origin_tiplocs` — a
footpath-reached neighbor never is, so it always needs the standard
5-minute buffer before boarding onward. This matches how every other
non-origin arrival (by train or on foot) is already treated, and was
confirmed rather than assumed by inspecting the boarding-check condition
directly.

---

## Test harness results (real DB, real schedules, 2026-08-24 08:00 query time)

Standalone harness (not part of the repo, run via a throwaway VPS
container against the live Postgres, deleted afterward along with the DB
credential it used) — imports `service.py` directly, calls `run_csa()`
with and without `footpaths` loaded, and prints the raw predecessor chain
without ever calling `merge_legs()` (a footpath-including chain would
crash it — exactly the gap 2b exists to close, correctly not touched here).

### 1. Solihull → Telford Central — the original bug case

**Footpaths OFF**: the Leamington Spa detour, exactly as before —
10 legs, 5 operators, **2h49m**, routed south via Dorridge → Leamington Spa
→ Coventry → Birmingham International → New Street → Wolverhampton.

**Footpaths ON**: Solihull → Acocks Green → **Birmingham Moor Street**,
**WALK to New Street (762s)**, then a direct Wolverhampton line service to
Telford Central — 4 train legs + 1 walk leg, **1h21m**. **1h28m faster.**
This is exactly the Moor Street↔New Street short-circuit Phase A set out
to capture, confirmed with a real chain, not a synthetic one.

### 2. Manchester Piccadilly ↔ Victoria — confirmed absent from the graph

```
Piccadilly (MNCRPIC) -> is MNCRVIC in its footpath neighbors? False
Victoria   (MNCRVIC) -> is MNCRPIC in its footpath neighbors? False
raw walking_transfers row: ('MNCRPIC','MNCRVIC', 1316, None)
```
1,316s > 900s ceiling, `walk_seconds_reverse` is NULL so the same 1,316s
value gates the reverse direction too — excluded both ways. Doesn't win,
doesn't almost-win, isn't a candidate: it's simply not an edge in the
loaded graph at all, checked directly against the dict rather than
inferred from a `run_csa()` output.

### 3. Regression check — 2 of 3 identical, 1 genuinely, explainably not

- **Solihull → Birmingham Moor Street: IDENTICAL.** Same 4-leg chain
  either way — makes sense, the destination *is* Moor Street, so there's
  no faster arrival there to be had by walking away from it.
- **Whitby → Windermere: IDENTICAL.** Same 38-leg, 6h12m chain either way
  — the route runs entirely through track nowhere near any footpath-linked
  station pair, so the extra graph has nothing to offer it.
- **Solihull → Manchester Piccadilly: NOT IDENTICAL** — and this is a real
  finding, not a bug, worth reporting plainly rather than forcing the
  "should be identical" framing from the task description. Footpaths OFF
  reproduces the same Leamington Spa detour as case 1 (same 25-minute wait
  at Leamington Spa the codebase's own `CONNECTION_RISK_BUFFER_MINUTES`
  comment already references as a previously-verified real wait), arriving
  Manchester Piccadilly at 11:29, **3h20m**. Footpaths ON takes the same
  Moor Street↔New Street shortcut as case 1 and arrives at 10:29 instead —
  **1 hour faster, 2h18m total.** The root cause is identical to the
  original bug case: the Leamington Spa detour was never specific to
  Telford Central, it affects *any* destination reachable only by first
  getting past Birmingham, so a previously "verified" itinerary that
  happened to route through the same chokepoint is legitimately, correctly
  superseded once footpaths are available. **Correcting the task's own
  premise here rather than silently forcing a match**: this itinerary was
  "correct" only in the sense of "what the tool produced before footpaths
  existed," not "already optimal" — the two that stayed identical
  (Moor Street, Whitby→Windermere) are the genuine zero-regression
  evidence; this third case is instead a second confirmation that the
  feature works, on a route nobody was specifically testing it against.

---

## Not done, per scope

`merge_legs()`, `search()`, the live `/journey-search` endpoint, and any
Darwin live-status lookup are unmodified — confirmed via `git diff`, not
just by intention. The VPS test directory (which briefly held the DB
password in a scoped `.env`) was deleted after the run.

# CSA journey router — build report

Structural pathfinding only, no live overlay, no UI. 2026-08-20. Built and
run against the SCHEDULE backfill tables (`schedules`/`calling_points`/
`tiplocs`) on `srhq-prod`'s existing Postgres — nothing written to the site
repo except this file and the CLAUDE.md gaps note. The router script itself
lives at `scratchpad/csa-router.py` (a copy of what actually ran on the VPS,
kept for reference — it isn't wired into anything, doesn't run from this
repo, and needs `DATABASE_URL`/psycopg2 to execute).

---

## 1. Algorithm

Earliest-arrival Connection Scan Algorithm (CSA), standard formulation
(`earliest_arrival[station]`, `trip_reached[schedule_id]` short-circuit for
continuing the same physical train, `predecessor` pointers for path
reconstruction), plus a 5-minute minimum-connection-time buffer on any
station change that boards a *different* schedule (not needed when staying
on the same train).

**STP resolution is not optional, exactly per the ask.** Every candidate
schedule for a search date is resolved via the same precedence logic as the
real `resolve_schedule()` SQL function (Cancellation > New > Overlay >
Permanent) before its calling points ever become a connection. For
performance, this is implemented as one bulk, set-based query per date
(`DISTINCT ON (train_uid) ... ORDER BY train_uid, <same STP CASE
expression>`) rather than 30,000+ individual function calls — but this bulk
query is **verified**, not assumed, to be equivalent: `router.py --verify`
cross-checks it against real calls to `resolve_schedule()` for 200 real
`train_uid`s, and reports **0 mismatches**, every run.

Day-rollover within a schedule (a stop's `HHMM` dropping below the previous
stop's) increments a running day-offset — necessary for connections that
cross midnight. Both the search date and the following day are resolved and
combined, so journeys crossing midnight are followed correctly; multi-day
overnight journeys (two midnight crossings) are out of scope, consistent
with "structural pathfinding," not a live product.

Station names/CRS codes resolve to one or more real `tiploc_code`s
(`tiplocs.crs` exact match, else `tiplocs.name ILIKE`, restricted to rows
with a real `crs` to exclude junctions/sidings/signals) — multi-tiploc
origins/destinations (e.g. "Manchester" → all 6 Manchester-named stations
with a CRS) are supported directly; the router reports exactly which
tiploc(s) it actually searched, so a resolution ambiguity is visible, not
silent.

## 2. Output shape

Ordered legs, each with train UID, ATOC/TOC, origin/destination tiploc and
time; between legs, the interchange tiploc and wait duration; total journey
time at the end. Real output, verbatim, below.

**Headcode**: not available — flagging rather than guessing. The SCHEDULE
backfill's `schedules` table (built in the prior prompt) never captured
`schedule_segment.signalling_id` (the real 4-character headcode field,
confirmed live in the raw JSON, e.g. `"9I41"` — a separate `CIF_headcode`
field also exists in the feed but is blank in every record sampled, so
`signalling_id` is the only real headcode source). Adding it would mean
altering the `schedules` schema and re-streaming the full 3.36GB extract a
second time to backfill it — a real, non-trivial VPS/infra action beyond
what a "no repo changes beyond CLAUDE.md" prompt implied I should take
without asking first. Every leg below reports **train UID + ATOC** instead;
say the word and I'll add the column and backfill pass.

## 3. Verification — real, hand-checkable itineraries

### Bulk-resolve correctness check (run before every search)

```
Verified bulk_resolve against resolve_schedule() for 200 real train_uids: 0 mismatches
```

### A) Known frequent direct route: Solihull → Birmingham Moor Street

```
Solihull -> Birmingham Moor Street, depart after 2026-08-20 08:00
Origin tiplocs considered: ['SOLIHUL']
Destination tiplocs considered: ['BHAMMRS']
----------------------------------------------------------------------
Leg 1: P69343 (LM)  SOLIHUL 08:11  ->  BHAMMRS 08:26
----------------------------------------------------------------------
Total journey time: 0:15:00
```

Correct — a direct 15-minute West Midlands Railway stopper, exactly the
real-world service pattern on that corridor.

### B) The flagged case: Solihull → Manchester

```
Solihull -> Manchester, depart after 2026-08-20 08:00
Origin tiplocs considered: ['SOLIHUL']
Destination tiplocs considered: ['MNCRIAP', 'MNCROXR', 'MNCRPIC', 'MNCRUFG', 'MNCRVHS', 'MNCRVIC']
----------------------------------------------------------------------
Leg 1: Y81130 (LM)  SOLIHUL 08:09  ->  DORIDGE 08:16
    change at DORIDGE, wait 0:16:00
Leg 2: L37406 (CH)  DORIDGE 08:32  ->  LMNGTNS 08:52
    change at LMNGTNS, wait 0:25:00
Leg 3: G00851 (XC)  LMNGTNS 09:17  ->  MNCRPIC 11:29
----------------------------------------------------------------------
Total journey time: 3:20:00
```

The map's old topology-only graph couldn't produce a real itinerary for
this pair at all (no timetable awareness). The router now does: 2 changes,
3 TOCs (LM → CH → XC), arriving Manchester Piccadilly 11:29.

**This looked geographically suspicious at first** (routing south to
Dorridge/Leamington Spa rather than through Birmingham New Street) so I
checked it rather than taking it on faith:

- Real SCHEDULE data confirms Solihull's own local corridor (both West
  Midlands Railway and Chiltern services calling there in this window) runs
  via Birmingham **Moor Street**/Snow Hill, not Birmingham **New Street** —
  no CrossCountry or Avanti service calls at Solihull directly in the
  08:00–09:30 window, so New Street isn't directly reachable by rail from
  Solihull without already changing.
- Independently re-ran `BHI (Birmingham International) → Manchester`
  starting from the exact time Solihull→BHI would actually arrive (09:39):
  it resolves to **the same train**, `G00851`, calling at Birmingham
  International at 09:41 and still arriving Manchester Piccadilly 11:29 —
  confirming 11:29 is the true earliest arrival, not an artifact of a bug;
  the router just happened to board that train two stops earlier
  (Leamington Spa) than the more obvious Birmingham interchange, which
  makes no difference to the outcome since it's the same physical working.

### C) Cross-country, deliberately picked to require several changes: Whitby → Windermere

```
WTB -> WDM, depart after 2026-08-20 08:00
Origin tiplocs considered: ['WTBY']
Destination tiplocs considered: ['WMER']
----------------------------------------------------------------------
Leg 1: G86048 (NT)  WTBY 08:44  ->  MDLSBRO 10:17
    change at MDLSBRO, wait 0:09:00
Leg 2: C32286 (NT)  MDLSBRO 10:26  ->  DLTN 10:55
    change at DLTN, wait 0:07:00
Leg 3: C02000 (GR)  DLTN 11:02  ->  NWCSTLE 11:35
    change at NWCSTLE, wait 0:18:00
Leg 4: C31778 (NT)  NWCSTLE 11:53  ->  CARLILE 13:20
    change at CARLILE, wait 0:08:00
Leg 5: W84888 (TP)  CARLILE 13:28  ->  OXENHLM 14:06
    change at OXENHLM, wait 0:33:00
Leg 6: G85384 (NT)  OXENHLM 14:39  ->  WMER 14:56
----------------------------------------------------------------------
Total journey time: 6:12:00
```

5 changes, 6 legs, 4 TOCs (NT, GR, TP) — confirms the algorithm has no
hidden cap on change count; it already went well past "two changes" for a
real branch-to-branch rural pair (Whitby and Windermere are both
terminating branch lines).

## 4. Performance — real numbers, flagged honestly

Every search above, cold, on the full 626,260-schedule dataset:

```
[perf] resolve + build:  ~4.3–4.5s  (38,675 + 38,371 resolved schedules, ~564,000 connections)
[perf] CSA scan:         ~0.6–0.75s
[perf] total:            ~5.0–5.2s
```

**Flagging rather than letting this pass quietly, per the ask: ~5 seconds
per search is too slow for an interactive per-user-search feature.** The
actual pathfinding (the CSA scan itself) is fast — well under a second even
scanning ~564,000 connections spanning two full days. Essentially all the
cost is in **rebuilding the same day's connection graph from Postgres on
every single search** (the two bulk-resolve queries plus fetching ~640,000
calling-point rows and re-running day-rollover arithmetic in Python), and
that work is **identical for every search sharing the same date** — it
doesn't depend on origin or destination at all. A real implementation
should build each date's connection graph once (on first request, or on a
schedule) and cache it in memory/process for reuse across all searches that
day, which would cut every subsequent search down to roughly the CSA scan
time alone (~0.6–0.75s). Not built here — this report is diagnosing the
cost, not fixing it, per the "structural pathfinding only" scope.

## 5. CLAUDE.md entry

Added a "SCHEDULE ↔ Darwin join — three permanent coverage gaps" section
(after the Darwin LDBWS REST section) documenting the Isle of Man/boat-train
GB-coverage exclusion and VSTP-created same-day services, both carried over
verbatim from the real examples found in the prior join investigation —
findings only, no code referenced or added.

---

## Explicitly not done, per scope

No Darwin live-status overlay, no UI, no saved-route/chip schema work, no
headcode backfill (flagged above, not actioned), no caching/perf fix (flagged
above, not actioned), no site-repo wiring of the router itself, no commits.

# Live overlay implementation — status report

Status only, no build/deploy beyond what's described. All changes are local
to `~/Documents/GitHub/srhq-journey-search/service.py` (not committed, not
pushed, not redeployed) — ready for review via GitHub Desktop, same as the
initial commit. The live Coolify-deployed container was never touched;
verification ran against a separate, throwaway test directory on the VPS,
now deleted.

---

## 1. Overlay lookup function

`_darwin_event_lookup()` + `get_live_status()` in `service.py`. The join is
exactly the one established in the earlier investigation — tiploc +
scheduled-time proximity, never a direct key:

```sql
SELECT rid, expected_or_actual, is_actual, delay_minutes, source, received_at
FROM darwin_movements
WHERE tiploc = %s AND event_type = %s
  AND replace(scheduled, ':', '') = %s
  AND received_at BETWEEN %s AND %s
ORDER BY is_actual DESC, received_at DESC
LIMIT 1
```

`ORDER BY is_actual DESC, received_at DESC` does both things asked in one
pass: any confirmed-actual row outranks every forecast row regardless of
timing, and within whichever group wins, the latest `received_at` is taken
(the table is append-only, so this is "the most recent thing Darwin has
said about this exact event"). Verified against real mixed data before
wiring it in — a real Aberdare 05:52 departure with 3 forecast rows and 1
actual row: the query picked the actual row (`05:51`, `-1` min, source `TD`)
correctly, not the numerically-latest-looking forecast.

Times are compared through `Europe/London` (via `zoneinfo`), not a
hardcoded UTC offset — the same approach the activation-lead investigation
used, needed because `darwin_movements.received_at` is real UTC and
CIF/Darwin scheduled times are always local (BST in August).

## 2. Absence classification

Three tiers, exactly per the characterization report, and explicitly *not*
the LDBWS ±120/119 figure (unrelated system):

- `> 4h` before scheduled time, no record → `not_yet_available` (routine)
- `0–4h` before, no record → `uncertain` (genuinely unknown, not guessed)
- scheduled time already passed, no record → `expected_but_absent`, worded
  as "possible unreported disruption" — deliberately not a "cancelled"
  claim, since that specific scenario was never actually observed in the
  original investigation.

## 3. Wired into `/journey-search`

Pure addition: each leg gets one new `live_status` field, scoped to the
leg's **origin departure event only** (the "can I catch this train"
moment — interchange waits stay schedule-only, no live overlay on those in
this pass). Nothing else in the existing response shape changed; the three
verification itineraries still parse identically with this as an addition.

## 4. Verification — real, current data, actual values

Ran the modified `service.py`'s functions directly (not the deployed
service) against the real database, from a disposable test harness in a
throwaway directory on the VPS (deleted afterward). Real UTC time at run:
`2026-08-21T12:21:46Z` (13:21:46 BST).

**Case 1 — real leg departing soon, real matching data:**
`LO`, tiploc `HIGHBYE`, scheduled `13:11` (10 min out when first checked
manually, already departed by the time the harness ran):

```
{'status': 'actual', 'scheduled': '13:11', 'expected_or_actual': '13:11',
 'delay_minutes': 0, 'source': 'TD', 'rid': '202608218965431',
 'received_at': '2026-08-21T12:11:18.922901+00:00'}
```

Confirms it reflects the *latest* row, not a stale forecast: manual checks
earlier in this session (11:31 and 12:00 UTC) only showed forecast rows for
this rid; by the time the harness ran, a new `is_actual=true` row
(`12:11:18` UTC, TD source) had landed, and the function picked that one up
— exactly the "prefer actual, take latest" behavior, observed live, not
just reasoned about.

**Case 2 — real leg >4h out:**
`VT`, tiploc `EUSTON`, scheduled `19:07` (~6h from now):

```
{'status': 'not_yet_available', 'scheduled': '19:07',
 'note': 'routine -- more than 4h before scheduled time, no live data expected yet'}
```

Correctly routine, not a gap.

**Case 3 — genuine same-day-absence-after-departure, found in real data,
not constructed:**

Searched real passenger services (real ATOC, real category, real CRS
stations) already past their scheduled departure today. Two of the first
misses found turned out to be the already-known ferry-connection category
(Troon Harbour→Brodick, a CalMac route) — explained, not a real gap, and
reported as such rather than being counted. Continuing the search turned up
a genuinely unexplained one: **`C01288`, Avanti West Coast, `XX` category
(a real InterCity working), Liverpool Lime Street → Euston, departed
`12:08`** — checked every real stop on its route (Runcorn 12:26, Lichfield
Trent Valley 13:14/15, Tamworth Low Level 13:21/22, Euston 14:32 arrival):
**zero `darwin_movements` rows anywhere on the entire journey**, despite
being ~1h53m into running by the time this was checked and due into Euston
in under 30 minutes.

```
{'status': 'expected_but_absent', 'scheduled': '12:08',
 'note': "scheduled time has passed with no darwin_movements record -- possible
 unreported disruption; this is NOT a confirmed cancellation (that case was
 never actually observed in the underlying investigation, so it isn't
 asserted as proven behavior here)"}
```

This tier is now verified against a real, currently-live example, not left
theoretical — and the classification's hedged wording is doing real work
here: this repo has no way to know from this data alone whether `C01288`
silently never ran today or is running with Darwin simply not reporting it,
and the overlay correctly says exactly that rather than guessing.

---

## Explicitly not done

No UI. No commit, no push, no redeploy — `service.py` in
`~/Documents/GitHub/srhq-journey-search` is the only file changed, staged
for your own review via GitHub Desktop. Interchange-wait live status (only
origin-departure per leg is covered) and any caching of the overlay lookup
itself are both out of scope for this pass.

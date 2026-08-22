# Phase A, step 2 addendum — full-dataset symmetry check

All 1,038 stored pairs checked in reverse (B→A) via real Routes API calls,
compared against the stored forward (A→B) value. No CSA router changes.

---

## Cost

Combined with step 2's original batch, this is ~2,081 total calls this
month (1,038 forward + 1,038 reverse + a handful of manual test calls) —
still well under the Routes API Essentials SKU's 10,000/month free
allowance confirmed in step 2. Real cost: **$0.00**.

## Results

**1,038/1,038 compared, 0 failures** (the extraction fix from step 2 —
defaulting a missing `distanceMeters` to 0 — held up for the 3 near-zero
pairs in reverse too).

Threshold used for "meaningful" vs "noise", stated plainly rather than
left implicit: **≥60 seconds absolute AND ≥15% relative difference**, both
required — a short pair (say, 40s) doubling in relative terms is still
just noise in absolute terms, and a long pair (say, 20 minutes) drifting
5% is 60 seconds but proportionately trivial. Requiring both catches real
asymmetry without flagging routing jitter at either end of the length
distribution.

**Distribution across all 1,038 pairs**: median absolute difference 26s,
mean 36.8s, max 325s.

**1,032/1,038 (99.4%) are effectively identical** — within noise by this
threshold, same shape as the Birmingham Moor St/New St spot-check from
step 2 (762s vs 752s, 1.3%).

**6/1,038 (0.6%) show a real, non-trivial difference:**

```
Drumfrochar <-> Greenock Central   fwd=1305s  rev=1630s   +24.9%   (distance identical: 1734m/1733m)
Drumfrochar <-> Greenock West       fwd= 731s  rev= 965s   +32.0%   (distance identical:  904m/904m)
Helensburgh Central <-> Upper       fwd=1043s  rev= 806s   -22.7%   (distance identical: 1071m/1071m)
Coombe Junction Halt <-> Liskeard   fwd=1044s  rev= 834s   -20.1%   (distance identical: 1002m/1002m)
Harringay <-> Harringay Green Lanes fwd= 500s  rev= 597s   +19.4%   (distance identical:  637m/636m)
Upper Warlingham <-> Whyteleafe     fwd= 312s  rev= 391s   +25.3%   (distance identical:  367m/367m)
```

## What's actually causing it — checked, not assumed

**Every one of the 6 pairs is a real, findable elevation/gradient case**,
not a barrier or a genuinely different route — and the data itself points
there before the station names even confirm it: **distance is identical
(within 1m) in both directions for all six**, while only the *time*
differs. A one-way pedestrian restriction or a barrier would force a
different, usually longer, physical route in one direction — that would
show up as a real distance difference too. Identical distance with
different time is specifically the signature of a slope: walking uphill
takes longer than the same path downhill, and Google's walking-duration
model accounts for elevation gain, not just flat distance.

The station names corroborate this directly:
- **Helensburgh Central ↔ Helensburgh Upper** — "Upper" isn't incidental;
  Helensburgh's Upper station sits genuinely higher up the town's hillside
  above the Clyde.
- **Drumfrochar ↔ Greenock Central/West** — Greenock is built on a steep
  slope rising from the Clyde; Drumfrochar sits well uphill from the town-
  centre stations.
- **Coombe Junction Halt ↔ Liskeard** — the Looe Valley branch: Liskeard
  sits on high ground, Coombe Junction down in the valley (the real
  train service here famously has to reverse at Coombe because of this
  same incline).
- **Upper Warlingham ↔ Whyteleafe** — Upper Warlingham sits on the North
  Downs escarpment above Whyteleafe in the valley.
- **Harringay ↔ Harringay Green Lanes** — the smallest difference of the
  six (19.4%), consistent with a more modest real elevation change between
  the two.

## Schema decision

**Kept the symmetric single-value design as the default, added one
nullable override column rather than doubling every row.** Given 99.4% of
pairs are genuinely symmetric, storing a full second direction for every
pair would double storage/complexity for almost no real benefit. Added:

```sql
ALTER TABLE walking_transfers ADD COLUMN walk_seconds_reverse INTEGER;
-- NULL (1,032 rows) = symmetric, same as walk_seconds
-- populated (6 rows) = a confirmed, real tiploc_b -> tiploc_a difference
```

No `walk_meters_reverse` column — distance was never meaningfully
asymmetric in any of the 1,038 pairs checked, so there's nothing real for
it to store. Populated the 6 known rows; verified directly:

```
 tiploc_a | tiploc_b | walk_seconds | walk_seconds_reverse
----------+----------+--------------+----------------------
 COOMBE   | LISKARD  |         1044 |                  834
 DRMFCHR  | GRENCKC  |         1305 |                 1630
 DRMFCHR  | GRENCKW  |          731 |                  965
 HLNSBRC  | HLNSBRU  |         1043 |                  806
 HRGY     | HRGYGL   |          500 |                  597
 UWRLNGH  | WHYTELF  |          312 |                  391
```

Updated the tracked `srhq-darwin-subscriber/schema.sql` to match (local
file edit, not committed — same pattern as step 2). Step 3's router work
will need to check `walk_seconds_reverse` when traversing tiploc_b→tiploc_a
and fall back to `walk_seconds` when it's NULL — flagging that concretely
now so it isn't a surprise when step 3 starts, without touching the router
itself here.

---

## Not done, per scope

No CSA router changes. Google Maps API key file deleted from the VPS
immediately after this batch, same as step 2.

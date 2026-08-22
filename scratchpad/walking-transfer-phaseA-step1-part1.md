# Phase A, step 1, Part 1 — SAME_STATION vs the 13 duplicate pairs

Report only, per the ask — this determined what Part 2 actually implements.

---

## Where SAME_STATION is actually used

Grepped the whole repo: it appears in exactly **one file**,
`scripts/migrate-station-list.mjs`. It is not consumed by departures
search, map.html, or anything else live on the site.

Its real shape and purpose, read directly from that file:

```js
// Keyed ATCO -> CRS, 4 hand-verified entries
const SAME_STATION = {
  '9400ZZLUKSX': 'KGX', // King's Cross St. Pancras -> London Kings Cross
  '9400ZZTWCST': 'NCL', // Central Station -> Newcastle (Newcastle Central)
  '9400ZZGLBUC': 'GLQ', // Buchanan Street subway -> Glasgow Queen Street
  '9400ZZWMNWS': 'BHM', // Grand Central -> Birmingham New Street
};
```

It's used at generation time to decide whether a NaPTAN metro/tram/DLR
**stop** (keyed by ATCO) is close enough and confirmed-same-place enough to
be **suppressed** — folded into an *existing* National Rail station's row
as an `interchange` sub-entry — rather than rendered as its own separate
dot on the map/database. It's a display-generation concern for one specific
output file (`station-list.json`), not a general station-equivalence
registry.

## Why it's the wrong mechanism for the 13 pairs

**Wrong identifier space.** `SAME_STATION` keys are metro/tram/DLR ATCO
codes; every one of the 13 walking-transfer pairs is two **National
Rail-coded RLY tiplocs**, both real CRS-bearing rail stations. Reusing it
would mean forcing a rail-tiploc↔rail-tiploc relationship into a table
designed for metro-stop↔rail-station suppression — a different
relationship entirely, not just a different data source.

**Wrong problem, and — checked properly, not assumed — mostly not even a
real duplicate problem.** The Phase A report called these 13 pairs
"noise"/"duplicates" from distance alone. That was premature. I went back
and checked the schedule data directly for the 3 closest pairs (the ones
that looked most like same-point database artifacts):

```
Lichfield Trent Valley High Level (LCHTTVH):  905 calling_points, 896 distinct schedules
Lichfield Trent Valley           (LCHTTVL): 1,107 calling_points, 1,089 distinct schedules
Tamworth High Level      (TMWTHHL): 4,376 calling_points, 4,345 distinct schedules
Tamworth                 (TMWTHLL):   910 calling_points,   908 distinct schedules
Highbury & Islington        (HGHI): 1,810 calling_points, 1,810 distinct schedules
Highbury & Islington     (HIGHBYA): 3,191 calling_points, 3,191 distinct schedules
```

Every one of these 6 tiplocs carries hundreds to thousands of real,
independently-scheduled calling points — not a vestigial/superseded code.
Checked further for Highbury & Islington specifically: **no single
schedule ever calls at both HGHI and HIGHBYA** (a direct `INTERSECT` query,
zero rows) — they're operationally distinct TIPLOC identities (different
platform groups sharing one station name), not one real place recorded
twice. **Correcting my own earlier framing**: calling this pair a "data-
entry duplicate" in the Phase A report was wrong, or at least unproven — I
should have checked schedule volume before concluding that, and I'm
retracting that specific characterization now that I have.

The other 10 of the 13 pairs (Glasgow Central/Low Level, St Pancras/LL,
Liverpool Lime Street/Low Level, Glasgow Queen Street/Low Level, Heath
High/Low Level, Catford/Catford Bridge, West Hampstead/Thameslink, Wigan
North Western/Wallgate, Minffordd/Ffestiniog, St Budeaux Ferry Road/
Victoria Road) are well-established, genuinely separate, separately-
ticketed UK stations that happen to sit very close together — exactly the
kind of short, real, valuable walking transfer Phase A exists to capture.
They were never duplicates.

## Recommendation

**Neither.** Don't reuse `SAME_STATION` (wrong ID space, wrong problem),
and don't build a new exclusion/merge list either — none of the 13 pairs
need excluding or merging. Every one of them is a real, distinct,
independently-scheduled location. Compute walking edges for all of them
like any other candidate pair; the routing engine (Google Directions, per
the Phase A recommendation) will naturally return a very short — even
near-zero — time for genuinely co-located platforms, which is correct data,
not noise to filter. Manufacturing an exclusion mechanism for a problem
that direct investigation shows isn't real would be worse than doing
nothing here.

Proceeding to Part 2 on this basis: no duplicate-resolution column, table,
or logic is added.

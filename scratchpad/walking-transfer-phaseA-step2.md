# Phase A, step 2 — walking edges computed and stored via Routes API

No CSA integration (step 3 is separate, not started). All work below is
against the live `srhq-infra` Postgres and real Google Routes API calls.

---

## Part 0 — schema-tracking investigation

Checked `srhq-journey-search`'s git history directly: **none of its 4
tables (`tiplocs`, `schedules`, `calling_points`, `associations`) were ever
created via a tracked file** — the repo only holds `Dockerfile`,
`.gitignore`, `.gitattributes`, `service.py`. That schema only ever existed
as a one-off `schema.sql` applied directly on the VPS, never committed
anywhere. **Flagging this plainly, not fixing it retroactively**, per the
ask.

But there's a real, closer precedent that changes what "the pattern" even
is here: **`naptan_stations` itself is already tracked**, in a *different*
repo — `srhq-darwin-subscriber/schema.sql`, committed in that repo's
initial commit. My own step 1 (adding `geog`/`mode`/`network`) applied
directly to the live table and never touched that file, so it had already
drifted out of sync — a gap I created, not a pre-existing one, so bringing
it current isn't the "retroactive fix to the untracked pile" the task said
to avoid.

**What I did**: updated `srhq-darwin-subscriber/schema.sql` (local file
edit, not committed/pushed — same review-before-commit pattern as every
other repo change this session) to (a) bring `naptan_stations` current with
step 1's columns, and (b) add the new `walking_transfers` table there,
since that's the repo that already owns this table's nearest relative. This
is a real, reviewable diff for the new table; the 4 journey-search tables
remain genuinely untracked, unaddressed, and now explicitly flagged rather
than quietly joined by a fifth.

## Part 1 — candidate pairs

```sql
SELECT count(*) FROM naptan_stations a JOIN naptan_stations b ON a.tiploc < b.tiploc
WHERE a.mode='rail' AND b.mode='rail'
  AND EXISTS (SELECT 1 FROM tiplocs t WHERE t.tiploc_code=a.tiploc)
  AND EXISTS (SELECT 1 FROM tiplocs t WHERE t.tiploc_code=b.tiploc)
  AND ST_DWithin(a.geog, b.geog, 1600);
-- 1038
```

**1,038**, 4 fewer than the earlier 1,042 estimate — checked exactly why,
not just noted the gap: 3 pairs excluded because they involve `ANGELRD`
(Angel Road, the closed station replaced by Meridian Water — already
documented in CLAUDE.md as having no real schedule data), and 1 pair
excluded because it involves `SNDRMNK`, one of the 3 metro-classified
stations from step 1. Fully explained, nothing upstream changed
unexpectedly.

## Part 2 — Routes API

**Pricing, checked live before running anything** (not assumed): fetched
Google's current published pricing page. Routes API "Compute Routes
Essentials" (the basic-fields SKU this qualifies for, since only
`duration`/`distanceMeters` are requested) is **free for the first 10,000
requests/month**, then $5.00/1000 up to 100k. At ~1,038 calls, this batch
**does not leave the free tier** — real cost is $0.00, assuming this
Google Cloud project hasn't already used its monthly allowance elsewhere
(I can't see the account-wide total from here — worth a quick check of the
Cloud Console billing page for confirmation, but nothing about my own
~1,043 calls (batch + test calls) comes close to needing the £226.82
credit regardless).

**Batch run**: 1,038 pairs, WALK mode, field mask `routes.duration,
routes.distanceMeters` only. **1,035 succeeded on the first pass, 3
failed** — all three were the exact 3 pairs flagged in the Part 1 report as
sub-10m apart (`HGHI`/`HIGHBYA`, `LCHTTVH`/`LCHTTVL`, `TMWTHHL`/`TMWTHLL`).
Investigated rather than just retried blind: Google's real response for
these is `{"routes": [{"duration": "0s"}]}` — `distanceMeters` is *omitted
entirely* when a route rounds to zero distance, and my extraction code
indexed it directly instead of defaulting missing-key to 0. Fixed and
re-ran just those 3 — all three now store correctly as `walk_seconds=0,
walk_meters=0`, an honest reflection of these being genuinely
co-located platforms (consistent with Part 1's finding that they're real,
independently-scheduled locations, not database duplicates — a ~0 walk is
the correct value for two real, adjacent platform groups, not a data
error). **Final: 1,038/1,038 stored, 0 unresolved failures.**

## Part 3 — storage

Table created (definition also added to `schema.sql`, per Part 0):

```sql
CREATE TABLE walking_transfers (
  id           BIGSERIAL PRIMARY KEY,
  tiploc_a     TEXT NOT NULL REFERENCES naptan_stations(tiploc),
  tiploc_b     TEXT NOT NULL REFERENCES naptan_stations(tiploc),
  walk_seconds INTEGER NOT NULL,
  walk_meters  INTEGER NOT NULL,
  source       TEXT NOT NULL DEFAULT 'routes_api',
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tiploc_a, tiploc_b),
  CHECK (tiploc_a < tiploc_b)
);
```

**Symmetry — checked with a real call, not assumed.** Queried Birmingham
Moor Street → New Street (stored direction) and then called the *reverse*
direction (New Street → Moor Street) directly: **752s vs the stored 762s**,
same 885m both ways — a 10-second (1.3%) difference, consistent with
ordinary route-estimation noise rather than a genuine directional
difference. On this one real check, symmetric storage looks reasonable.
I did **not** call all 1,038 pairs in both directions to fully rule out a
genuinely one-way case elsewhere (station-specific gated access, a
one-way underpass) — that would double the API calls for a check this
task didn't ask for. Flagging plainly: **no asymmetric case was found, but
only one pair was actually checked both ways** — if a specific pair's
transfer time ever looks suspicious later (e.g. asymmetric station access
is reported), that's the concrete thing worth re-checking directionally,
not a general assumption to fully trust yet.

---

## Verification — real rows, for direct review

```
                  a                  |                      b                       | walk_seconds | walk_meters |   source
-------------------------------------+----------------------------------------------+--------------+-------------+------------
 Birmingham Moor Street Rail Station | Birmingham New Street Rail Station           |          762 |         885 | routes_api
 Highbury & Islington Rail Station   | Highbury & Islington Rail Station            |            0 |           0 | routes_api
 London Kings Cross Rail Station     | London St Pancras International Rail Station |          336 |         404 | routes_api
 Manchester Piccadilly Rail Station  | Manchester Victoria Rail Station             |         1316 |        1618 | routes_api
```

Worth noting plainly rather than glossing over: **Manchester Piccadilly ↔
Victoria comes back as 22 minutes (1,316s)** — genuinely real, walkable, but
long enough that whether the CSA router should actually offer it as a
worthwhile change (versus a same-tiploc alternative or just not bothering)
is a real judgement call for step 3, not something this step decides.

**Final count: `SELECT count(*) FROM walking_transfers` → 1,038.**

---

## Not done, per scope

No CSA router changes. No commit/push of the `schema.sql` edit in
`srhq-darwin-subscriber` — local file change only, same review-first
pattern as every other repo task this session. The Google Maps API key
file used for the batch was deleted from the VPS immediately after the run.

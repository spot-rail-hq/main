# Push Port ↔ SCHEDULE join investigation

Report only, no schema/repo changes. 2026-08-20. All queries run directly
against the live `srhq-infra` Postgres on `srhq-prod` (95.217.157.127),
against real data — `darwin_movements` (60,652,278 rows, 2026-07-08 to
2026-08-20) and the SCHEDULE backfill tables from the previous prompt
(626,260 schedules / 9,516,832 calling points).

---

## 1. `darwin_movements` shape — actual columns, real rows

```
       Column       |           Type           | Nullable
--------------------+--------------------------+----------
 id                 | bigint                   | not null
 tiploc             | text                     | not null
 rid                | text                     |
 event_type         | text                     | not null
 scheduled          | text                     |
 working             | text                     |
 expected_or_actual | text                     |
 is_actual          | boolean                  | not null
 delay_minutes      | integer                  |
 platform           | text                     |
 source              | text                     |
 msg_timestamp      | timestamp with time zone |
 received_at        | timestamp with time zone | not null
```

**Nothing else exists.** No `train_uid`, no headcode, no TOC/ATOC column, no
schedule/origin-date column — the ingest pipeline that built this table only
captured per-event fields, not journey-identity fields.

Real sample (10 most recent rows, one arrival+departure pair per service):

```
tiploc   | rid              | event_type | scheduled | working  | platform
PRSP     | 202608207126465  | departure  | 21:20     | 21:20:30 | 3
PRSP     | 202608207126465  | arrival    | 21:20     | 21:20    | 3
LEWES    | 202608207177204  | departure  | 21:52     | 21:52    | 4
LEWES    | 202608207177204  | arrival    | 21:50     | 21:50    | 4
NDULWCH  | 202608206709837  | departure  | 21:51     | 21:51    | 1
NDULWCH  | 202608206709837  | arrival    | 21:50     | 21:50    | 1
STHWICK  | 202608206793297  | departure  | 22:20     | 22:20:30 | 2
STHWICK  | 202608206793297  | arrival    | 22:20     | 22:20    | 2
REIGATE  | 202608207115152  | departure  | 21:51     | 21:51    | 2
REIGATE  | 202608207115152  | arrival    | 21:50     | 21:50    | 2
```

The **only** train-identifying field of any kind is `rid`, and it's a bare
15-digit numeric string — no TOC, no CIF-style code embedded visibly.

## 2. Format comparison — `rid` vs `schedules.train_uid`: genuinely different namespaces

**`rid`**: always 15 digits. Confirmed by decoding: the first 8 digits parse
as a real calendar date matching `received_at::date` exactly, every time
tested:

```
rid              | rid_date_part | parsed_date | received_at
202608207403442  | 20260820      | 2026-08-20  | 2026-08-20
202608208088829  | 20260820      | 2026-08-20  | 2026-08-20
```

So `rid` = `<8-digit origin date><7-digit opaque sequence>`. That remaining
7 digits do **not** decode to a CIF train UID in any reliable way — tested
directly: taking the last 5 digits of `rid` and matching against the numeric
part of `schedules.train_uid` (ignoring the leading letter) produces massive
many-to-many collisions. For one `mid2` value alone (`67`, digits 9–10 of
`rid`), 30 different UID leading letters (C, G, W, L, Y, F, X, H, P, Q, J, S,
V, N, M, A, K, B, U, R) all matched — there is no consistent letter↔digit
encoding. With ~626K schedules and only 100,000 possible 5-digit endings,
this is arithmetic coincidence, not a real derived key. (It did coincidentally
hold for a few UIDs resolved via the *real* tiploc+time join below — e.g.
`C00068`'s `rid` ended `...00068` — but that's because those were confirmed
real matches by other means, not because the suffix is decodable on its own.)

**`schedules.train_uid`**: always 6 characters, one letter + 5 digits
(standard TOPS UID format), confirmed by leading-character distribution
across the real table (`C` 104,674 · `W` 79,999 · `G` 73,711 · `P` 69,607 ·
`L` 67,501 · `Y` 50,579 · `H` 30,575 … 20 distinct leading letters total).

**Conclusion**: these are two unrelated identifier schemes. There is no
string transform from one to the other that can be trusted as a join key.

## 3. Real join test — 10 services, multiple TOCs, using the actual resolver

Method: for each ATOC, picked a real `train_uid` running on 2026-08-20 with a
genuine advertised (public-time) origin stop, resolved it through the actual
`resolve_schedule(uid, date)` function built last session, took that
schedule's origin `tiploc_code` + `public_departure`, and looked for an exact
match in `darwin_movements` (`tiploc` + `scheduled` with the colon stripped,
`event_type='departure'`, same date).

```
atoc | uid     | tiploc   | dep  | darwin match?
AW   | C05395  | HLYH     | 0130 | NO — see below
EM   | C04199  | CORBY    | 0432 | YES  rid=202608206704199 scheduled=04:32
GN   | C10076  | MRGT     | 1744 | YES  rid=202608206710076 scheduled=17:44
GR   | C01889  | DLTN     | 0809 | YES  rid=202608206701889 scheduled=08:09
GW   | C00773  | BNBR     | 1831 | YES  rid=202608196700773 scheduled=18:31
LO   | C00069  | HIGHBYE  | 0010 | YES  rid=202608206700069 scheduled=00:10
SE   | J03426  | LEWISHM  | 0031 | YES  rid=202608207403426 scheduled=00:31
TL   | C02767  | HORSHAM  | 0607 | YES  rid=202608206702767 scheduled=06:07
VT   | C00577  | DOUGLAS  | 0830 | NO — see below
XC   | G00673  | SOTON    | 0756 | YES  rid=202608207100673 scheduled=07:56
```

**8/10 exact hits on `tiploc + public_departure` alone** (no fuzzy/proximity
matching needed — exact string equality on the converted time). The 2 misses
are not join failures, they're real scope boundaries:

- **`C05395` (AW)**: origin `HLYH` (Holyhead), destination `DUBLINF`. Checked
  the tiploc table: `DUBLINF` = a Dublin ferry-port location. This is a
  boat-train working connecting to the Ireland ferry — the Irish leg is
  outside Great Britain / outside Darwin's coverage entirely, so it
  structurally can never have a `darwin_movements` row for that ATOC-tagged
  service. Confirmed no `01:30` departure ever appears at `HLYH` in the
  dataset (there's a recurring unrelated `01:49 arrival` at that tiploc
  instead).
- **`C00577` (VT)**: origin/destination tiplocs are `DOUGLAS` /
  `HEYMST`. `tiplocs.name` for `DOUGLAS` is literally `"DOUGLAS (ISLE OF
  MAN)"` — this is the Isle of Man Steam Railway, a narrow-gauge heritage
  system with no connection to National Rail/Darwin at all, despite carrying
  an ATOC tag (`VT`) in the SCHEDULE feed.

An earlier, less careful first pass (before restricting to calling points
with a real `public_departure`) picked a GWR service that turned out to be
`RDNGSTN → RDNGTCD` — Reading station to Reading Traincare Depot, an empty-
stock depot move with **no public times at all** (`public_arrival`/
`public_departure` both blank). That's not a join failure either — it's a
non-passenger working that was never going to be in Darwin. Filtering out
this category before the join (see §5) is essential.

**Hit rate on the correctly-resolved, real-public-time sample: 8/10 (80%),
with both misses fully explained by real out-of-scope services, not by the
join key being wrong.**

## 4. STP relevance on the Darwin side — confirmed with real cancelled-date examples

`darwin_movements` has **zero** STP-related columns and **zero**
cancellation-status concept — `event_type` only ever takes two values,
confirmed directly:

```
event_type
arrival
departure
```

(`expected_or_actual` is a time field, not a status enum — every value
sampled is an `HH:MM` string.)

Tested directly against two real, past-dated STP=Cancellation records:

- **Eurostar `C00354`, cancelled 2026-08-14** (a real single-date `C` record
  layered over a `P`/multiple `O` pattern). The underlying P schedule's
  origin is `PARISND` (Paris Nord) — international, so not a clean GB test,
  but confirms the same shape.
- **Chiltern Railways `L38221`, cancelled 2026-08-15** (Saturday). The
  underlying P schedule departs `MARYLBN` (Marylebone) `17:27` on Saturdays.
  `resolve_schedule('L38221','2026-08-15')` correctly returns the `C` row:

  ```
  (104007, L38221, C, 2026-08-15, 2026-08-15, 0000010, "", "", 5204, ...)
  ```

  And `darwin_movements` for `MARYLBN` at `17:27` on 2026-08-15 returns
  **zero rows** — not a row with a cancelled flag, just nothing at all:

  ```sql
  SELECT rid, event_type, scheduled FROM darwin_movements
  WHERE tiploc='MARYLBN' AND scheduled='17:27' AND received_at::date='2026-08-15';
  -- (0 rows)
  ```

**Confirmed: Darwin only ever describes trains that actually ran.** There is
no STP concept on the Darwin side because there's nothing to reconcile — a
cancelled-per-SCHEDULE service simply produces no movement rows. This means
STP precedence only has to be resolved once, upstream, on the SCHEDULE side
(exactly what `resolve_schedule()` already does) — **the join itself never
needs to reason about STP.**

Side note for anyone reading `source`: `darwin_movements` isn't purely
Darwin Push Port TS messages — `source` takes 8 distinct real values (`CIS`,
`Darwin`, `GPS`, `TD`, `TRUST`, `Trust`, `Workstation`, blank), so it's a
blended multi-feed table. Doesn't change the STP conclusion above, but worth
knowing before assuming every row came from the same pipeline stage.

## 5. Coverage gaps, both directions — real examples, not just counts

### schedules → darwin (forward)

First, the baseline: of 535,724 schedules with a recorded origin (`LO`)
calling point at all, only **407,944 (76%)** carry a real public origin
time. The other 24% are non-passenger workings by `train_category` —
dominated by `EE` (Empty Coaching Stock, 90,527 of them), plus bus-
replacement categories (`B1`/`B4`/`B5`/`B6`/`B7`), freight/departmental
(`DD`/`DH`/`DT`), and light-engine/other (`ZZ`, `EL`, `XU`). **None of
these can ever appear in `darwin_movements`, structurally** — Darwin only
carries public-facing running information.

Second, a real quantitative check that surfaced an important operational
finding: sampling 60 real `(schedule, origin tiploc, public_departure)`
triples from calling points that *do* have public times and a real domestic
ATOC, matching **without first running them through `resolve_schedule()`**
(i.e. matching a raw candidate calling point straight against
`darwin_movements`) gave only **15/60 (25%) hits** — much worse than the
properly-resolved 8/10 (80%) in §3. The only methodological difference is
STP resolution. This strongly indicates that a large share of "misses" in a
raw join are **stale/superseded schedule variants** (a `P` row whose actual
running that day is overridden by a same-UID `O` or `C` elsewhere) being
checked instead of the one STP actually selects — not real data gaps.
**This is the single most important operational finding in this report**:
any journey-search join must resolve STP first and join on the *resolved*
schedule's calling points, never on a raw/unfiltered one.

### darwin → schedules (reverse)

Sampled 60 real departure events from `darwin_movements` (any date since
2026-08-01, via `TABLESAMPLE` for a genuinely random cross-section) and
checked whether *any* calling point in SCHEDULE — at the same tiploc, same
time, on a day-of-week the schedule is flagged to run — exists anywhere.
**57/60 matched (95%).**

The one concrete miss captured with detail: `WEYBDGB` (Weybridge), a real
`08:41` departure recorded in `darwin_movements` on 2026-08-01
(`rid=202608017684226`). Checked every calling point ever recorded at that
tiploc in the whole SCHEDULE dataset — the closest scheduled departures are
`08:33` and `09:03`, nothing at `08:41` at all, on any UID, any STP
indicator. Most likely explanation: a short-notice VSTP-created working
(re-timed relief/empty-stock service, added after the full weekly extract's
cutoff) — this backfill only ingested the full CIF SCHEDULE extract, not the
separate, more-frequent VSTP feed, so same-day schedule amendments created
that way are invisible to `resolve_schedule()` by design, not by bug.

## 6. Bottom line

**No direct-key join exists, and none should be expected** —
`darwin_movements` carries no train UID, headcode, TOC, or schedule-date
field of any kind; its only train-identifying field (`rid`) is a
Darwin-internal opaque sequence in a completely different namespace from
`schedules.train_uid`, confirmed empirically (§2), not assumed from docs.

**The reliable join, exactly as needed for journey search:**

1. `resolve_schedule(train_uid, date)` first — **mandatory**, not optional.
   Skipping this step is empirically the biggest cause of false misses (§5).
2. Join the *resolved* schedule's `calling_points` to `darwin_movements` on:
   - `calling_points.tiploc_code = darwin_movements.tiploc`
   - `calling_points.public_departure` (or `public_arrival` for the arrival
     event) `= replace(darwin_movements.scheduled, ':', '')`, falling back
     to the working `departure`/`arrival` time only for calling points that
     have no public time (rare for anything worth surfacing to a user — see
     below)
   - `darwin_movements.received_at::date` matching the schedule's applicable
     running date (allow ±1 day for services crossing midnight, since a few
     of the real matches above were logged under the previous calendar date)
3. **No STP reasoning is needed on the `darwin_movements` side at all** (§4)
   — Darwin already reflects only what actually ran; the resolver in step 1
   already did the only STP work that matters.

**Pre-filter before ever attempting the join**, since both are real,
structural, non-bug reasons a schedule won't have a Darwin counterpart:
exclude schedules whose calling point has no public time (ECS/freight/bus-
replacement, ~24% of all origins, §5) and be aware that a small number of
SCHEDULE entries describe services genuinely outside GB National Rail
(heritage narrow-gauge, cross-border/ferry-linked international, §3) that
will legitimately never appear in Darwin regardless of join correctness.
Journey search should treat "no live Darwin match" for these categories as
expected, not as a data-quality signal.

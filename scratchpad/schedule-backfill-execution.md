# SCHEDULE full-extract backfill — execution report

One-time backfill, no daily-refresh automation added. 2026-08-20. Follows
`schedule-data-investigation.md`. All work done directly on `srhq-prod`
(95.217.157.127) against the existing `srhq-infra` Postgres — no changes to
the site repo, no commits.

---

## 1. Setup check

- **NROD credentials on the VPS**: did not exist before this run (confirmed —
  `env | grep -i nrod` on the host came back empty). Added as
  `/root/schedule-ingest/.env` (`chmod 600`, root-only), not committed
  anywhere, alongside the derived `DATABASE_URL` for the ingest script (built
  from the Postgres container's own `POSTGRES_PASSWORD`, connecting via the
  Docker-internal `coolify` network by container name — the DB isn't
  published to a host port, so anything talking to it has to be on that
  network).
- **Disk before**: `38G total, 22G used, 15G available` — matches the last
  investigation exactly (no drift since then).

## 2. Schema

Applied via `docker exec … psql < schema.sql` against the `postgres`
database, `public` schema — same DB `darwin_movements`/`naptan_stations`
already live in, neither touched. Four new tables:

- **`tiplocs`** — `tiploc_code` PK, `name` (`COALESCE(tps_description,
  description)`, since the investigation found `tps_description` more
  reliably populated), `crs`, `stanox`, all nullable per the real coverage
  found (§3 of the investigation). No FK to `naptan_stations` — join happens
  at query time on CRS, exactly as asked, not duplicated.
- **`schedules`** — natural key `UNIQUE(train_uid, stp_indicator,
  schedule_start_date)`, matching the identity a real NROD `Delete` record
  itself uses. Plus `schedule_end_date`, `days_runs`, `atoc_code`,
  `train_category`, and `source_sequence` (the file's own
  `Metadata.sequence`, for future reference per the ask).
- **`calling_points`** — FK to `schedules(id)` on delete cascade, `seq` for
  order, `tiploc_code`, scheduled + public times, `platform`, `line`, and a
  computed `is_stop boolean` — `true` for every `LO`/`LT` row, and for `LI`
  rows only when `public_arrival` or `public_departure` is populated; `false`
  for a bare `pass`. No activity-code field used, because none exists in this
  feed (confirmed in the investigation).
- **`associations`** — raw `JsonAssociationV1` fields, unresolved, as asked.
  **One deliberate deviation from the ask worth flagging explicitly**: I did
  *not* add an enforced FK from `associations` to `schedules`.
  `main_train_uid` alone isn't unique in `schedules` (STP variants share a
  UID), so a real single-column FK isn't well-defined without also matching
  STP indicator + date — and associations don't carry a schedule's STP/date
  in a way that maps cleanly 1:1. Rather than force a fake constraint just to
  say "there's a FK," I left it as plain columns with no enforced reference.
  If you want a real FK here, it needs a decision on what "the associated
  schedule" means precisely first — flagging rather than guessing.

## 3. Streaming ingest

Ran as a `python:3.12-slim` container on the `coolify` Docker network (only
place that can reach Postgres), `psycopg2` + `requests`, streaming
`gzip.GzipFile` wrapped around the live HTTP response directly into batched
`execute_values` inserts. **The 3.36GB uncompressed form was never written to
disk anywhere** — decompression happened entirely in-memory as the stream was
read line-by-line.

One operational hiccup, resolved before it mattered: the first launch
attempt used a bare `&` background in a non-interactive SSH command, which
looked stalled from outside (the log file appeared frozen mid-run) because
Python's stdout buffering doesn't flush to a redirected file until either the
buffer fills or the process exits cleanly — it wasn't actually stuck, and
finished correctly; I verified against live DB row counts throughout rather
than trusting the log file alone, and confirmed final counts match exactly
before treating it as done.

- **Duration: 576.6s (~9.6 minutes)**, authenticate-to-finish.
- **Disk after: `38G total, 24G used, 12G available`** — **backfill cost
  ~2GB** of the 15GB that was free (now 12GB free). In line with the
  investigation's estimate ("low single-digit GB").
- **Ingested counts** (from the script's own tally, cross-checked against
  live `SELECT count(*)` on every table post-run):

| Table | Rows | Matches investigation's predicted count? |
|---|---|---|
| `tiplocs` | 12,070 | Yes — exact |
| `schedules` | 626,260 | Yes — exact |
| `calling_points` | 9,516,832 | Yes — exact |
| `associations` | 94,865 | Yes — exact |

Every count matches the prior investigation's full-extract totals exactly —
same extract shape, same day.

## 4. Query-time STP resolver

Deployed as a real Postgres function, not a one-off script:

```sql
CREATE OR REPLACE FUNCTION resolve_schedule(p_train_uid text, p_date date)
RETURNS SETOF schedules AS $$
  SELECT *
  FROM schedules
  WHERE train_uid = p_train_uid
    AND schedule_start_date <= p_date
    AND schedule_end_date >= p_date
    AND substring(days_runs FROM extract(isodow FROM p_date)::int FOR 1) = '1'
  ORDER BY CASE stp_indicator
             WHEN 'C' THEN 0 WHEN 'N' THEN 1 WHEN 'O' THEN 2 WHEN 'P' THEN 3
           END
  LIMIT 1;
$$ LANGUAGE sql STABLE;
```
`extract(isodow FROM date)` gives Monday=1..Sunday=7, which lines up directly
with `days_runs`'s 1-indexed character position (confirmed against real data
in the investigation: `'0000001'`'s Sunday-only pattern). Priority order is
C > N > O > P, per the ask (and per the investigation's finding that `N`
UIDs never coexist with `P` for the same UID in this data anyway, so the
ordering between N and O/P rarely gets exercised in practice — included for
correctness regardless).

## 5. Verification — real results, not just "passed"

**Row counts** — see the table in §3. Exact match, not "roughly."

**Heathrow Express, UID `C00045`, both dates from the investigation:**

- `resolve_schedule('C00045', '2026-11-29')` (the Sunday with a same-date
  Cancellation) → returned exactly **one row**: `id=496083, stp_indicator=C,
  schedule_start_date=2026-11-29, schedule_end_date=2026-11-29,
  days_runs=0000001`. **Correct** — a naive P-only lookup would have said
  this train runs; the resolver correctly surfaces the cancellation instead.
- `resolve_schedule('C00045', '2026-08-16')` (a different Sunday, not
  cancelled, with its own single-date Overlay) → returned exactly **one
  row**: `id=108137, stp_indicator=O, schedule_start_date=2026-08-16,
  schedule_end_date=2026-08-16, atoc_code=HX, train_category=XX`. **Correct**
  — returns the Overlay's specific details for that date, not the generic
  Permanent schedule.

**Stop/pass inference, UID `C00058` (the London Overground service from the
investigation), full calling-point sequence, verbatim:**

```
seq  tiploc     type  pub_arr  pub_dep  pass   is_stop
 0   HIGHBYE    LO             0525            t
 1   CNNBELL    LI    0527     0527            t
 2   ELLBNLL    LI                      0527H  f   <- pass-through junction
 3   DALS       LI    0529     0530            t
 4   HAGGERS    LI    0532     0532            t
 5   HOXTON     LI    0534     0534            t
 6   SHRDHST    LI    0536     0536            t
 7   WCHAPEL    LI    0538     0539            t
 8   SHADWEL    LI    0541     0541            t
 9   WAPPING    LI    0543     0543            t
10   RTHERHI    LI    0544     0544            t
11   CNDAW      LI    0546     0546            t
12   SURREYQ    LI    0548     0548            t
13   SURRQSJ    LI                      0549   f   <- pass-through junction
14   CANALJ     LI                      0550   f   <- pass-through junction
15   NEWXNJN    LI                      0551   f   <- pass-through junction
16   NEWXGEL    LT    0555                     t
```
**Correct** — all 4 known non-stopping junction points (`ELLBNLL`,
`SURRQSJ`, `CANALJ`, `NEWXNJN`) are marked `is_stop=false`; every real
passenger stop, including origin/terminus, is `true`. No false positives or
negatives in this sequence.

**TIPLOC ↔ `naptan_stations` join coverage:**
```
naptan_total=2637  matched=2633  pct=99.8
```
**Exact match** to the investigation's finding (`2,633/2,637`, 99.8%) — same
4 stations (`ANGELRD`, `FROSTLY`, `WOLSHAM`, `ZZTYALS`) still the only ones
without a live TIPLOC.

---

## Summary

All five verification checks pass with concrete, inspectable results — not
just row counts, but the two specific STP-precedence cases and the specific
non-stopping calling points the investigation flagged as the real trap. One
open design question to resolve before it matters: whether `associations`
should get a real FK, and what "the associated schedule" precisely means if
so. Everything else matches what was proposed. Ready for the next step
(daily-refresh/cron wiring) whenever you want it — not started here per the
ask.

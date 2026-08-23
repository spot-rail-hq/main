# Alembic migrations setup for srhq-journey-search — build report

Implements `scratchpad/journey-search-migrations-investigation.md`'s
recommendations, expanded scope per your confirmed decisions (all 7
tables, fresh-snapshot baseline, schema only). Local files only, in
`srhq-journey-search` — **not committed or pushed**:

```
alembic.ini                    (edited: sqlalchemy.url left unset)
alembic/env.py                 (edited: reads DATABASE_URL from env)
alembic/README
alembic/script.py.mako
alembic/versions/0952e4f88108_baseline_snapshot_of_live_schema_7_.py
requirements-migrations.txt    (new: alembic, sqlalchemy, psycopg2-binary)
```

`Dockerfile` (the runtime service image) is untouched — Alembic is
dev/ops tooling, not part of the running `service.py` process.

---

## Step 1 — Alembic setup

Standard `alembic init alembic`, then two deliberate deviations from the
generated defaults:

- **`alembic.ini`'s `sqlalchemy.url` is left unset.** `alembic/env.py`
  instead reads `DATABASE_URL` straight from `os.environ`, the exact same
  pattern `service.py` itself uses (`os.environ["DATABASE_URL"]` at the
  top of that file) — so no connection string/credential ever lands in a
  tracked file, and Alembic is pointed at whatever DB you set
  `DATABASE_URL` to at invocation time (a throwaway test DB for
  verification, as below, or the real DB when actually applying a
  migration for real). This is read/DDL access for migration purposes
  only — `service.py`'s own runtime connection code is untouched.
- **`target_metadata = None`, and stays that way.** No SQLAlchemy ORM
  models exist in this project and none are being introduced — `service.py`
  is plain SQL throughout, and every migration (including this baseline)
  is hand-authored raw SQL via `op.execute()`, not diffed from declarative
  models. This means **autogenerate is never used here, by design** —
  consistent with why Alembic (not something heavier) was the right choice
  in the first place.

---

## Step 2 — Baseline migration: what was captured, per table

**Method**: `pg_dump --schema-only` run directly against the live
production Postgres (via `docker exec` into the actual DB container,
read-only, no live data touched or exported) for exactly the 7 tables in
scope, plus a hand-added `CREATE EXTENSION IF NOT EXISTS postgis` (pg_dump's
per-table mode doesn't emit extension DDL at all, but `naptan_stations.geog`
needs it). This is real DB introspection, not reconstruction from memory
or from either repo's existing docs — more precise than SQLAlchemy
reflection would have been here too, since plain SQLAlchemy doesn't
natively understand PostGIS's `geography` type without an extra dependency
(GeoAlchemy2) this project doesn't otherwise need.

| Table | Columns captured | Key constraints/indexes captured |
|---|---|---|
| `schedules` | `id, train_uid, stp_indicator, schedule_start_date, schedule_end_date, days_runs, atoc_code, train_category, source_sequence, updated_at` | PK `id`; unique `(train_uid, stp_indicator, schedule_start_date)`; CHECK `stp_indicator IN ('P','O','C','N')`; btree index on `train_uid` (`idx_schedules_train_uid`) |
| `calling_points` | `id, schedule_id, seq, tiploc_code, location_type, arrival, departure, pass, public_arrival, public_departure, platform, line, is_stop` | PK `id`; unique `(schedule_id, seq)`; btree index on `tiploc_code`; FK `schedule_id → schedules(id) ON DELETE CASCADE` |
| `tiplocs` | `tiploc_code, name, crs, stanox, updated_at` | PK `tiploc_code` (no surrogate `id`) |
| `associations` | `id, main_train_uid, assoc_train_uid, assoc_start_date, assoc_end_date, assoc_days, category, date_indicator, location, base_location_suffix, assoc_location_suffix, diagram_type, stp_indicator` | PK `id`; no FKs, no other indexes |
| `darwin_movements` | `id, tiploc, rid, event_type, scheduled, working, expected_or_actual, is_actual, delay_minutes, platform, source, msg_timestamp, received_at` | PK `id`; btree indexes on `received_at DESC` and `(tiploc, received_at DESC)` |
| `naptan_stations` | `tiploc, crs, name, lat, lon, geog, mode, network` | PK `tiploc`; `geog geography(Point,4326)` with a GiST index (`idx_naptan_stations_geog`) |
| `walking_transfers` | `id, tiploc_a, tiploc_b, walk_seconds, walk_meters, source, computed_at, walk_seconds_reverse` | PK `id`; unique `(tiploc_a, tiploc_b)`; CHECK `tiploc_a < tiploc_b`; FKs both `tiploc_a` and `tiploc_b → naptan_stations(tiploc)` |

**Something the introspection surfaced that neither the original
investigation report nor a hand-written recreation would necessarily have
gotten right**: `id` columns are **not** all the same mechanism.
`calling_points.id` and `associations.id` are `GENERATED ALWAYS AS
IDENTITY`; `schedules.id`, `darwin_movements.id`, and
`walking_transfers.id` are instead a plain `bigint` column with a separate
owned `SEQUENCE` + `DEFAULT nextval(...)` (the older bigserial-shaped
pattern). Both are functionally equivalent for the router's own purposes
(`service.py` never inserts into any of these tables, only reads), but
they are genuinely different DDL, and the baseline preserves each exactly
as pg_dump captured it rather than normalizing to one style — a hand-typed
"recreate this schema" migration could easily have picked one style and
applied it to all 7 uniformly, which would not have matched.

Nothing else surfaced was a surprise relative to the investigation:
`associations` really is unused by any query in `service.py` (confirmed
again here — its DDL is captured for completeness of scope, since it's in
the router's DB, but nothing reads it); `naptan_stations`/
`walking_transfers` really do match what `srhq-darwin-subscriber`'s
`schema.sql` already described.

---

## Step 3 — Verification: applied to a fresh test DB, structurally diffed

**Not just "it ran without error"** — concretely:

1. Spun up a throwaway `postgis/postgis:17-3.5-alpine` container (same
   image/version as production) on an isolated Docker network on the VPS,
   completely separate from the live database.
2. Ran `alembic upgrade head` against it from a throwaway
   `python:3.12-slim` container (mounting the repo, `pip install -r
   requirements-migrations.txt`, `DATABASE_URL` pointed at the test
   container only) — confirmed `upgrade` completed and logged
   `Running upgrade -> 0952e4f88108`.
3. **Structural diff, not a text diff**: ran `psql \d <table>` against
   both the live production DB and the freshly-migrated test DB, for all
   7 tables, and diffed the two outputs pairwise.
   **Result: byte-identical for all 7 tables** — every column, type,
   default, nullability, index, and constraint matched exactly.
   (A raw `pg_dump`-text diff was tried first and looked almost clean but
   wasn't fully order-independent — pg_dump reordered the `schedules`
   block based on internal object-creation order, which is a cosmetic
   artifact of dump ordering, not a real difference; the plain
   `\restrict`/`\unrestrict` tokens pg_dump embeds are also random per
   invocation and not schema content. The `\d`-based diff sidesteps both
   and is the real structural check.)
4. **Round-trip check**: also ran `alembic downgrade base` then `alembic
   upgrade head` again against the same test DB — both completed cleanly,
   confirming `downgrade()` (currently `DROP TABLE ... CASCADE` for all 7,
   deliberately *not* dropping the `postgis` extension itself, since that's
   shared infrastructure this migration didn't necessarily introduce) is
   real and reversible, not just present as an unused stub.
5. **Cleanup**: the test container and its isolated Docker network were
   both removed after verification; nothing was left running or copied
   onto the VPS outside this session.

---

## Step 4 — `srhq-darwin-subscriber`'s `schema.sql`: flagged, not touched

Not modified — per instruction, this is Aaron's call in a separate small
session there. What it would actually take, so that session doesn't have
to re-derive it:

- **`schema.sql` currently defines `darwin_movements`, `naptan_stations`,
  and `walking_transfers`** (confirmed, again, not drifted from live in
  this build's own introspection — matches what the investigation already
  found). Once this Alembic baseline is the real source of truth for all
  7 tables, those 3 definitions in `schema.sql` become genuinely
  redundant.
- **Two real options for that file**, not one obvious answer:
  - Delete the 3 `CREATE TABLE`/index blocks entirely and replace with a
    short comment pointing at `srhq-journey-search/alembic/` as the real
    source of truth (keeps `schema.sql` honest about what it does and
    doesn't own, smallest edit).
  - Remove the file/mechanism altogether if nothing else in that repo
    actually depends on `schema.sql` being present (worth checking —
    `consumer.js`/`db.js`/`index.js` weren't found to read `schema.sql`
    programmatically in this investigation, it reads as documentation +
    a manually-run DDL script, but that should be confirmed in that
    repo's own session before deleting it).
- **Not resolved here, on purpose** — this build only touched
  `srhq-journey-search`, exactly as scoped.

---

## What's NOT done

- `srhq-darwin-subscriber` itself: untouched, per Step 4 above.
- No future migrations beyond this baseline — the next schema change to
  any of these 7 tables should be a new hand-authored Alembic revision
  (`alembic revision -m "..."`, filled in by hand with `op.execute()`,
  matching this one's style), not autogenerate.
- Nothing committed or pushed in `srhq-journey-search` — `git status`
  shows the 3 new/changed paths (`alembic.ini`, `alembic/`,
  `requirements-migrations.txt`) as untracked, exactly as they were left.

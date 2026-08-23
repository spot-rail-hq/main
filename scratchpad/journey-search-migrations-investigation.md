# Migrations for srhq-journey-search — investigation

Investigate only, per the ask — no code changed, no migration tool
installed, nothing committed. Verified directly against the live
production database (via `docker exec` into the actual Postgres container,
`w86fhfcllcg17zhat0ybgi7v`, read-only `\d`/`\dt`/`\dx` commands only) and
by reading `service.py`'s real queries, not by trusting either repo's
existing docs.

---

## 1. Current state — what the code actually depends on

### Every table `service.py` queries directly

Grepped every `cur.execute(...)` in the file. Five tables, no others:

| Table | Columns actually read | Live indexes used implicitly |
|---|---|---|
| `schedules` | `id, train_uid, atoc_code, stp_indicator, schedule_start_date, schedule_end_date, days_runs` (+ `count(*), max(id)` for the fingerprint) | `idx_schedules_train_uid`, PK `id` |
| `calling_points` | `schedule_id, seq, tiploc_code, public_arrival, arrival, public_departure, departure, is_stop` | `idx_calling_points_tiploc`, unique `(schedule_id, seq)` |
| `tiplocs` | `tiploc_code, name, crs` | PK `tiploc_code` |
| `walking_transfers` | `tiploc_a, tiploc_b, walk_seconds, walk_seconds_reverse, walk_meters` | unique `(tiploc_a, tiploc_b)` |
| `darwin_movements` | `rid, expected_or_actual, is_actual, delay_minutes, source, received_at` (WHERE on `tiploc, event_type, scheduled, received_at`) | `idx_darwin_movements_tiploc_received` |

No `naptan_stations`, no `associations` — both exist live but `service.py`
never touches either. No PostGIS function calls (`ST_*`, `geography`
casts, etc.) anywhere in `service.py` — the CSA router itself needs no
spatial functionality at all; that's exclusively `naptan_stations.geog`'s
concern (built for the walking-transfer-graph generation step, a separate
one-off process, not this live service).

**Extensions live on the DB** (from `\dx`): `postgis` 3.5.7 (+ its
`postgis_tiger_geocoder`/`postgis_topology` siblings, both unused by
anything in this project — they ship as part of the `postgis/postgis`
base image, not something anyone here asked for), `fuzzystrmatch` (also
present, not referenced by `service.py` or anywhere else searched in
either repo — likely also came bundled with the base image or an earlier
experiment, not something currently load-bearing). **`service.py` itself
needs zero extensions** — it only uses plain SQL on plain-typed columns.

### The real finding: two of the three tracked/untracked boundaries don't line up the way the premise assumed

The ask was framed around `srhq-darwin-subscriber`'s `schema.sql` possibly
having *drifted* from the five tables above. Checked directly — the
drift risk is real but not where the framing expected:

- **`schema.sql` tracks `darwin_movements`, `naptan_stations`, and
  `walking_transfers`** — and for these three, it's accurate. Diffed
  column-by-column against the live `\d` output: matches (walking_transfers'
  live table additionally carries the `id BIGSERIAL` PK and
  `walking_transfers_check`, both present in `schema.sql` too — no
  meaningful drift found here).
- **`schedules`, `calling_points`, `tiplocs`, and `associations` are not
  defined in ANY file in any of the three local repos** (`main`,
  `srhq-darwin-subscriber`, `srhq-journey-search`) — grepped all three for
  `CREATE TABLE.*schedules`, `calling_points`, `tiplocs`; nothing. These
  are exactly the four tables `service.py` (the CSA router) depends on
  most heavily for three of its five tables, plus one it never touches
  (`associations` — present live, unused by any code found in this
  investigation, presumably schedule split/join data for a feature never
  built against it, or from a NROD extract that's imported wholesale).
  **Whatever process created and populates these four tables (almost
  certainly a NROD/CIF import pipeline) isn't in any repo cloned to this
  machine.** Its schema exists only as a live fact in the production
  database itself, with no tracked source of truth anywhere.

So "does srhq-darwin-subscriber's schema.sql risk drifting from the live
DB" is real but narrow (3 tables, currently accurate); the bigger, currently
uncovered gap is that **the majority of what `service.py` reads has no
tracked schema at all**, in any repo, from any tool.

---

## 2. Tool choice

**Alembic**, for the reason the ask anticipated: this is a pure-Python
codebase (`service.py`, stdlib `http.server` + `psycopg2`, no ORM, no
existing migration tooling of any kind) and Alembic is the standard choice
for exactly this shape of project — SQL-first, no ORM commitment required
(Alembic doesn't require SQLAlchemy models; `op.execute("...")` with raw
SQL works fine and matches this codebase's existing style of writing plain
SQL directly rather than through a query builder).

**Nothing about the current setup argues for a different tool.** No
Node.js migration framework is relevant here (that would fit
`srhq-darwin-subscriber`, a separate Node codebase with its own
`schema.sql`-as-idempotent-DDL approach already, which is its own
reasonable pattern for that repo and not in scope to change here). No
existing migration history to import from a prior tool. No multi-database/
multi-tenant complexity that would argue for something heavier.

---

## 3. Baseline strategy — flagged, not decided

Two real options, with a real risk difference between them:

- **Fresh snapshot baseline of the live DB as it exists today** (e.g.
  `pg_dump --schema-only`, or Alembic's own autogenerate against the live
  DB) — guaranteed accurate to what's actually running right now,
  including the four untracked tables from section 1. Downside: doesn't
  reconstruct *why* the schema looks the way it does (schema.sql's own
  comments are full of exactly that reasoning — e.g. `walk_seconds_reverse`
  NULL-means-symmetric, the mode/network TW-metro-detection method) —
  a pure snapshot would lose all of that unless it's manually
  re-attached as migration comments.
- **Reconstruct history from `srhq-darwin-subscriber`'s `schema.sql`** —
  keeps that reasoning, but per section 1 it only covers 3 of the 7 tables
  that exist live, and would need the other 4 (`schedules`,
  `calling_points`, `tiplocs`, `associations`) written from scratch anyway
  by inspecting the live DB — so this option doesn't actually avoid a live
  snapshot, it just supplements it for the 3 tables schema.sql already
  gets right.

**Real risk of drift between `schema.sql` and the live DB**: low today
(confirmed matching in section 1), but schema.sql is hand-maintained
prose-with-DDL, not itself verified by any tooling against the live DB —
nothing currently re-checks it, so today's "matches" is a one-time manual
confirmation, not an enforced guarantee.

Not deciding between these — this is exactly the kind of call that
determines how much of the existing hand-written reasoning survives into
the new migration history, which only Aaron can weigh against how much
that reasoning is worth preserving vs. how much a clean start is worth.

---

## 4. Ownership going forward — flagged, not decided

If an Alembic setup is built inside `srhq-journey-search`, it would
necessarily take over tracking `schedules`, `calling_points`, `tiplocs`,
and `associations` (nothing else does today), plus optionally
`darwin_movements`/`naptan_stations`/`walking_transfers` — the three
`schema.sql` already tracks.

Two real shapes, not resolved here:

- **Deprecate `schema.sql` for the three overlapping tables**, single
  source of truth in `srhq-journey-search`'s migrations. Cleanest, but
  `srhq-darwin-subscriber` is the actual *writer* for `darwin_movements`
  and (indirectly, via whatever populates it) `naptan_stations`/
  `walking_transfers` — moving their schema ownership to a different
  repo than the one that writes to them is a real structural inversion
  worth being deliberate about, not just a file-location tidy-up.
- **Keep both**, accepting the now-explicit two-sources-of-truth risk for
  those three tables specifically (already flagged as the reason this
  investigation exists) — while at least the *rest* of the DB
  (`schedules`/`calling_points`/`tiplocs`/`associations`) finally gets a
  tracked home for the first time.

Flagging as a decision, not resolving it — same as requested.

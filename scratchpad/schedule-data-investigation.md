# SCHEDULE data investigation — record shapes, STP resolution, storage proposal

Investigation only, no build, no schema created. 2026-08-20. Follows on from
`journey-planner-scoping.md`. Working file: fresh full extract re-fetched via
the same two-step auth chain (Basic Auth → 302 → presigned S3 URL fetched with
NO Basic Auth header, since S3 rejects a request carrying both a presigned
signature and an Authorization header). All analysis below streamed directly
from the compressed `.gz` (`zcat | jq …`) — the 3.36GB uncompressed form was
never written to disk.

---

## 0. New infrastructure facts surfaced while investigating (not asked for, but load-bearing)

Investigating §3/§4 required querying the actual VPS Postgres, which corrected
two things the previous report got wrong:

- **The "Darwin subscriber" is real and identified.** It's a Coolify-managed
  container (`clear-cardinal-o1498lzpzvgu85caebsnldob`, Node/Kafka, project
  `srhq-infra`) named `srhq-darwin-subscriber` in its own logs — a **Kafka**
  consumer (via Confluent Cloud, topic
  `prod-1010-Darwin-Train-Information-Push-Port-IIII2_0-JSON`), not a raw
  STOMP client. It's been running 6+ weeks and has written **60,487,596 rows**
  into `darwin_movements`. (Logs show periodic Kafka consumer-group
  rebalancing/coordinator errors — self-healing, not investigated further,
  out of scope here.)
- **`naptan_stations` already exists**, 2,637 rows, `tiploc text PK, crs, name,
  lat, lon` — this is the existing geo/name reference the storage proposal
  builds on rather than duplicates.
- **Disk is 15GB free, not ~18GB.** `df -h /`: 38G total, 22G used, **15G
  available**. Small gap from the number in the ask, but real — sizing in §4
  uses the actual figure.

---

## 1. Record shapes — real examples, real counts

**Record type counts** (full extract, streamed count, ~38s to scan):

| Type | Count |
|---|---|
| `JsonScheduleV1` | 626,260 |
| `JsonAssociationV1` | 94,865 |
| `TiplocV1` | 12,070 |
| `JsonTimetableV1` (header) | 1 |
| `EOF` (footer) | 1 |

Calling points: **9,516,832** total `schedule_location` rows across the
626,260 schedules — average **15.2 calling points per schedule**.

**Header** (first line of the file, verbatim):
```json
{"JsonTimetableV1":{"classification":"public","timestamp":1787185863,"owner":"Network Rail","Sender":{"organisation":"Rockshore","application":"NTROD","component":"SCHEDULE"},"Metadata":{"type":"full","sequence":5204}}}
```
`Metadata.sequence` matters — see §2/§4, it's the real mechanism for detecting
a missed update.

**A `TiplocV1` record** (verbatim, second line of the file):
```json
{"TiplocV1":{"transaction_type":"Create","tiploc_code":"AACHEN","nalco":"081601","stanox":"00005","crs_code":null,"description":null,"tps_description":"AACHEN"}}
```
Full field set across all 12,070 records (confirmed by unioning `keys` over
every record, not sampled): `crs_code, description, nalco, stanox,
tiploc_code, tps_description, transaction_type`. **No lat/lon field exists
anywhere in this record type** — see §3.

**A full `JsonScheduleV1` record with ordered calling points** (real London
Overground service, verbatim, `CIF_train_uid: C00058`):
```json
{"JsonScheduleV1":{"CIF_bank_holiday_running":null,"CIF_stp_indicator":"P","CIF_train_uid":"C00058","applicable_timetable":"Y","atoc_code":"LO","new_schedule_segment":{"traction_class":"","uic_code":""},"schedule_days_runs":"0000001","schedule_end_date":"2026-12-06","schedule_segment":{"signalling_id":"9I41","CIF_train_category":"OO","CIF_headcode":"","CIF_course_indicator":1,"CIF_train_service_code":"22215003","CIF_business_sector":"??","CIF_power_type":"EMU","CIF_timing_load":"378","CIF_speed":"075","CIF_operating_characteristics":"D","CIF_train_class":"S","CIF_sleepers":null,"CIF_reservations":null,"CIF_connection_indicator":null,"CIF_catering_code":null,"CIF_service_branding":"","schedule_location":[
{"location_type":"LO","tiploc_code":"HIGHBYE","departure":"0525","public_departure":"0525","platform":"1"},
{"location_type":"LI","tiploc_code":"CNNBELL","arrival":"0526H","public_arrival":"0527","departure":"0527","public_departure":"0527","platform":"2"},
{"location_type":"LI","tiploc_code":"ELLBNLL","pass":"0527H"},
{"location_type":"LI","tiploc_code":"DALS","arrival":"0529","public_arrival":"0529","departure":"0530","public_departure":"0530","platform":"4"},
"...(HAGGERS, HOXTON, SHRDHST, WCHAPEL, SHADWEL, WAPPING, RTHERHI, CNDAW, SURREYQ all follow the same LI stop pattern)...",
{"location_type":"LI","tiploc_code":"SURRQSJ","pass":"0549"},
{"location_type":"LI","tiploc_code":"CANALJ","pass":"0550"},
{"location_type":"LI","tiploc_code":"NEWXNJN","pass":"0551"},
{"location_type":"LT","tiploc_code":"NEWXGEL","arrival":"0552","public_arrival":"0555","platform":"1"}
]},"schedule_start_date":"2026-05-17","train_status":"P","transaction_type":"Create"}}
```
(trimmed for readability; full untrimmed record is in the fetched file, 18
calling points total — some elided above marked stops omitted for length,
none were pass-only)

**Important, concrete finding: this JSON variant has NO CIF-style "Activity"
code field at all.** Unioned every distinct key-set across all 9.5M
`schedule_location` rows (three shapes total, covering LO/LI/LT) — none
contain an `activity` key. CIF text format's two-character Activity codes
(`TB`, `TF`, `T `, `U `, etc.) are **not present in this JSON feed**. Instead,
stop-vs-pass must be **inferred**:
- `location_type` (`LO`=origin, `LI`=intermediate, `LT`=terminate) — always present.
- A real passenger stop has `public_arrival`/`public_departure` populated.
- A non-stopping pass-through junction/point has `pass` set and no public times
  (see `ELLBNLL`, `SURRQSJ`, `CANALJ`, `NEWXNJN` above — junctions the train
  runs through without stopping, `pass` time only).
- Working (non-public) times can exist without public times too (a technical
  stop with no passenger activity) — not seen in this specific example but
  structurally possible per the field set.

**This is a real trap for anyone building the parser from CIF documentation
without checking the JSON feed directly** — code written expecting an
`activity` field to read stop/pick-up/set-down semantics off will find it
simply isn't there in this feed; the location_type + pass/public-time
combination is the actual source of truth here.

---

## 2. STP/overlay resolution — real example, real scale, real trap

**STP indicator distribution** (all 626,260 schedule records):

| STP | Count |
|---|---|
| O (Overlay) | 193,689 |
| P (Permanent) | 192,398 |
| N (New) | 149,637 |
| C (Cancellation) | 90,536 |

**327,158 distinct `CIF_train_uid`s. 84,542 of them (25.8%) have more than one
schedule record. 80,767 (24.7% of ALL distinct UIDs) carry more than one
DIFFERENT STP indicator for the same UID.** This is common, not an edge case
— any resolver has to handle it on roughly 1 in 4 UIDs.

**Real example, `CIF_train_uid: C00045` (Heathrow Express), verbatim date/STP
sequence:**
```
stp=P start=2026-05-17 end=2026-12-06 days=0000001 (Sunday-only)   ← base pattern
stp=O start=2026-08-16 end=2026-08-16 days=0000001                 ← single-Sunday overlay
stp=O start=2026-08-23 end=2026-08-23 days=0000001
stp=O start=2026-08-30 end=2026-08-30 days=0000001
stp=O start=2026-09-13 end=2026-09-13 days=0000001
stp=O start=2026-09-27 end=2026-09-27 days=0000001
stp=O start=2026-10-04 end=2026-10-04 days=0000001
stp=O start=2026-10-11 end=2026-10-11 days=0000001
stp=O start=2026-10-18 end=2026-10-18 days=0000001
stp=O start=2026-11-01 end=2026-11-01 days=0000001
stp=O start=2026-11-08 end=2026-11-08 days=0000001
stp=O start=2026-11-15 end=2026-11-15 days=0000001
stp=O start=2026-11-22 end=2026-11-22 days=0000001
stp=C start=2026-11-29 end=2026-11-29 days=0000001                 ← this one Sunday is CANCELLED
stp=O start=2026-12-06 end=2026-12-06 days=0000001
```
(`2026-11-29` verified as a real Sunday via `date`, matching the `days_runs`
bit — the last character of the 7-char bitstring is Sunday.)

**This is the exact naive-implementation trap the task asked me to flag:**
a resolver that only loads the `P` record and checks `date ∈
[start,end]` + weekday-bit would say **C00045 runs on 2026-11-29** — it does
not; that specific Sunday is cancelled by a same-date `C` record. And on
almost every OTHER individual Sunday in the range, the actual calling
pattern/times to show are the single-date `O` record's, not the `P` record's
— a naive "just use the Permanent schedule" approach would silently show
wrong times on most Sundays in this range, not just the cancelled one.

**Confirmed real resolution rule** (standard priority order, verified against
this data's shape — not asserted from memory): for a given UID + calendar
date, collect every record whose `[schedule_start_date, schedule_end_date]`
covers the date AND whose `schedule_days_runs` bit for that weekday is `1`;
among matches, the correct schedule to use is the one with the
**highest-priority STP indicator: C > N > O > P**. A `C` match means the
train does not run that day at all, full stop — not "run using the P
schedule instead."

**Second trap, also real and directly observed:** `N`-indicator schedules
(`149,114` distinct UIDs are **entirely** `N`, no `P` counterpart at all —
genuine standalone additions, not overrides) can themselves be **split across
multiple non-contiguous date ranges under one UID**:
```
UID N58063:
  stp=N start=2026-05-17 end=2026-10-11 days=0000001
  stp=N start=2026-10-25 end=2026-12-06 days=0000001   ← gap: no 2026-10-18 coverage at all
```
So even without any STP-priority conflict, "one row per UID" is already a
wrong assumption — date-range segmentation has to be handled regardless of
whether overlays/cancellations are involved.

**This gives a solid, NROD-confirmed natural key for storage** (see §4): a
real `Delete` record from today's daily update (verbatim) carries *only*:
```json
{"JsonScheduleV1":{"CIF_stp_indicator":"P","CIF_train_uid":"G27350","schedule_start_date":"2026-05-17","transaction_type":"Delete"}}
```
i.e. NROD itself identifies a specific schedule row for deletion by exactly
`(train_uid, stp_indicator, schedule_start_date)` — no other field is needed
to uniquely address one. That's the real primary key, confirmed by NROD's own
protocol, not inferred from the spec.

---

## 3. TIPLOC coverage — TiplocV1 alone is not enough; naptan_stations already fills the gap

**TiplocV1 field set** (confirmed exhaustively, §1): `tiploc_code, crs_code,
stanox, nalco, description, tps_description, transaction_type`. **No
coordinates, ever** — TIPLOC/SCHEDULE data structurally cannot provide
lat/lon. Whatever holds geo data has to come from elsewhere.

**Fill rates, 12,070 TIPLOC records:**
- `crs_code` present: 3,575 (29.6%). Absent: 8,495 (70.4%) — mostly pure
  infrastructure (junctions, sidings, depots) with no passenger relevance.
- `description` present: 2,827 (23.4%) — `tps_description` (a terser
  TOPS-style name, e.g. `"AACHEN"` in the header example above where
  `description` was null) is the more reliably populated name field in
  practice.

**Cross-check against `naptan_stations` (2,637 rows, already live in the VPS
Postgres):**
- **2,633 / 2,637 (99.8%) of naptan_stations' tiplocs are found in SCHEDULE's
  TIPLOC list.** Only 4 missing: `ANGELRD`, `FROSTLY`, `WOLSHAM`, `ZZTYALS`.
  `ANGELRD` is very likely Angel Road — CLAUDE.md's historical-stations work
  already documents this station as closed/renamed (to Meridian Water); a
  closed station's TIPLOC legitimately not appearing in a *live* SCHEDULE
  extract is expected, not a bug. The other three weren't investigated
  further here — same likely explanation (closed/renamed/never had live
  services), worth a quick manual check before treating as suspicious.
- **12 CRS mismatches** between `naptan_stations.crs` and SCHEDULE's
  `crs_code` on tiplocs that DO match. Real examples: `HTRWAPT` →
  naptan says `LHR`, SCHEDULE says `HXX`; `RDNG4AB` → naptan `RDG`, SCHEDULE
  `RDZ`. These look like genuine **same-location, multiple-valid-CRS**
  situations (Heathrow has historically had several codes for different
  terminal groupings — `LHR`/`HXX`/`HAF`/`HWV`), not necessarily an error in
  either source — but a naive join that assumes one-CRS-per-tiploc will pick
  whichever side it joined from and silently disagree with the other. Worth
  deciding explicitly which source wins per field, not defaulting silently.
- **9,437 SCHEDULE TIPLOCs (78.2%) have no `naptan_stations` row at all.**
  Of those, 958 DO carry their own `crs_code` — real examples: `PENYWAUN
  BUS`, `ABINGDON (BUS)` (rail-replacement bus stops with NR-style pseudo-CRS
  codes), `ABERDEEN CLAYHILLS CAR.M.D` (carriage maintenance depot),
  `ABBOTSWOOD JN`/`ACTON T.C.` (junctions/technical points with
  `X`-prefixed internal pseudo-CRS codes — `XAY`, `XAX` — a real, standard NR
  convention for non-ticketed locations that still need a 3-letter system
  code). **This is not a naptan_stations coverage gap to fix** — that table
  was scoped to real passenger stations and correctly excludes these; the
  remaining 8,479 without even a `crs_code` are pure infrastructure
  (junctions/sidings) with no CRS concept at all.

**Bottom line: TiplocV1 alone is not a usable location reference on its own**
(no coordinates ever; a real human-readable name only ~1 in 4 of the time;
CRS present only ~30% of the time) — **but you don't need CORPUS to fix
this for the journey-planner's actual scope.** `naptan_stations` already
covers 99.8% of the passenger-relevant subset with name + lat/lon. CORPUS
would only add value for the ~958 non-passenger-but-CRS-bearing locations
(mostly bus substitutions and depots) — arguably out of scope for a
passenger journey planner regardless. Recommend: **skip CORPUS entirely**
unless a concrete future need for those non-passenger locations appears.

---

## 4. Storage proposal — schema design, same database, and a verified refresh mechanism

### Same database — yes, no real reason to split

Confirmed the existing schema style directly (`\d` on both live tables):
`darwin_movements` (bigint identity PK, plain `text`/`boolean`/`integer`/
`timestamptz` columns, tiploc-keyed, indexed on `(tiploc, received_at DESC)`,
**60,487,596 rows today**) and `naptan_stations` (`tiploc text PK, crs, name,
lat, lon`, 2,637 rows) both live in the single `postgres` database, `public`
schema, on the one PostGIS container in the `srhq-infra` Coolify project.
There's no operational reason to split SCHEDULE data into a separate
database — same box, same backup/connection story, and `naptan_stations` is
exactly what the new tables would join against for geo/name. Propose
extending the same database.

### Proposed tables (design only — not created)

**`tiplocs`** — mirrors `TiplocV1` 1:1:
```
tiploc_code       text PRIMARY KEY
crs_code          text
nalco             text
stanox            text
description       text
tps_description   text
updated_at        timestamptz not null default now()
```
No hard FK from `naptan_stations.tiploc` to this table — 4 known orphans
(closed stations, §3) mean it has to stay a soft/logical relationship, not
an enforced constraint that would reject legitimate historical rows.

**`schedules`** — one row per real STP-resolvable schedule variant, keyed
exactly the way NROD itself addresses one (confirmed via the real `Delete`
record shape in §2):
```
id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
train_uid            text not null
stp_indicator        text not null check (stp_indicator in ('P','O','C','N'))
schedule_start_date  date not null
schedule_end_date    date            -- null-safe: absent on a bare Delete
days_runs            text            -- keep the raw 7-char bitstring; cheap to interpret, no lossy int packing
atoc_code            text
train_category       text
power_type           text
speed                text
train_status         text
source_sequence      integer         -- Metadata.sequence off the file it came from; see refresh design below
updated_at           timestamptz not null default now()

UNIQUE (train_uid, stp_indicator, schedule_start_date)   -- the real NROD identity key
```

**`calling_points`** — the ordered stop list per schedule:
```
id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
schedule_id        bigint not null references schedules(id) on delete cascade
seq                smallint not null            -- position within the schedule, preserves order
tiploc_code        text not null                -- soft ref to tiplocs, not enforced (see above)
location_type      text not null                -- LO / LI / LT
arrival            text
departure          text
pass               text
public_arrival      text
public_departure    text
platform           text
line               text

UNIQUE (schedule_id, seq)
```
Index `calling_points(tiploc_code)` for "what schedules call here" queries —
the direction a journey planner actually needs.

Keep the raw `HHMM`/`HHMMH` time strings as `text` rather than normalizing to
a numeric/time type at this layer — the trailing `H` (half-minute) is part of
NROD's own representation and lossy to strip prematurely; normalize at query
time or in a later derived layer once the resolver logic is actually built.

**Not proposed here, flagged for later:** `JsonAssociationV1` (94,865
records — train joins/splits) wasn't asked for in this pass, but a correct
resolver eventually needs it (a portion-split changes what "connects" at a
station in a way calling_points alone can't represent). Same shape of table
when it's needed: `base_uid, assoc_uid, tiploc_code, dates, category, ...`.

**Sizing**: 626,260 `schedules` + 9,516,832 `calling_points` rows (current
snapshot) is comfortably inside what this Postgres already handles —
`darwin_movements` alone is already 60.5M rows on this box today. Total
storage for schedules+calling_points+indexes is plausibly in the low
single-digit GB — genuinely not the disk risk here (see below for what is).

### Refresh mechanism — verified live, not just documented

- **Full extract**: `type=CIF_ALL_FULL_DAILY&day=toc-full` → 302 → presigned
  S3 URL (fetch with **no** Basic Auth header). Confirmed today: **125.4MB
  compressed (131,467,553 bytes), 3.36GB uncompressed (3,363,760,043 bytes)**,
  newline-delimited JSON, `gunzip -t` clean.
- **Daily updates — real mechanism confirmed live, not inferred from docs**:
  `type=CIF_ALL_UPDATE_DAILY&day=toc-update-<mon|tue|wed|thu|fri|sat|sun>`.
  **All seven weekday-suffixed keys returned 200 when tested directly** — this
  is a **rolling 7-day retention window keyed by day-of-week**, not by
  calendar date. Today's (`thu`) file: 3.6MB compressed, 17,073
  `JsonScheduleV1` (11,318 `Create` / 5,755 `Delete`) + 1,023
  `JsonAssociationV1`, no `TiplocV1` today (TIPLOC changes are rare).
  A `Delete` record carries only the identity triple (§2) — nothing else to
  parse; a `Create` carries the full schedule, applied as an upsert.
- **Gap detection — confirmed possible, not just assumed**: every file's
  `JsonTimetableV1` header carries `Metadata.sequence` (today's full extract:
  `5204`; today's Thursday update: `5198`). This is the real signal to
  compare against the last-applied sequence — if the next update's sequence
  isn't the expected next value, that's a missed-update signal, and because
  retention is only 7 days, **the only real recovery path beyond a week of
  downtime is a fresh full extract**, not backfilling old updates (they're
  gone). Build the daily job assuming that's the normal fallback path, not a
  rare edge case.
- **No persistent connection needed** — this reconfirms what the previous
  report inferred from docs: both full and update feeds are periodic HTTP
  pulls, no STOMP/Kafka needed for SCHEDULE itself (that's what
  `darwin_movements`' *separate*, already-running Kafka consumer is for —
  real-time running data, a different product).

### Practical job shape (proposal, not built)

A cron-triggered job on the VPS (same operational pattern as the existing
Coolify-managed Darwin subscriber, just scheduled rather than long-running):
authenticate → fetch today's weekday-keyed update (or the full extract on
whatever cadence is chosen for periodic full refresh, e.g. weekly) → stream
it (`zcat | jq …`, exactly as done throughout this investigation) directly
into Postgres — `INSERT … ON CONFLICT (train_uid, stp_indicator,
schedule_start_date) DO UPDATE` for `Create`s, `DELETE FROM schedules WHERE
(train_uid, stp_indicator, schedule_start_date) = (...)` for `Delete`s
(cascades to `calling_points` via the FK) — **never writing the uncompressed
JSON to disk**. That's not just tidiness: at 15GB free (§0), a 3.36GB
uncompressed full extract sitting on disk during processing is a real
percentage of headroom, and doing it twice (e.g. a retry) would be
uncomfortably close to filling the disk. The compressed `.gz` files
themselves (125MB full / 3.6MB update) are trivial and don't need to be
retained after a successful load — the database is the durable copy, not the
downloaded file.

---

## Housekeeping

`/tmp/schedule_test.gz` (fresh 125MB full extract) and a handful of small
working CSV/TSV extracts are left in `/tmp` on this machine from the
analysis above — none of it was committed or written into the repo. Let me
know if you want them cleared.

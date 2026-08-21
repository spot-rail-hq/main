# CSA router — per-date connection graph caching

Router performance only, no live overlay, no UI, no schema changes, no
site-repo changes beyond this report and the router script copy
(`scratchpad/csa-router.py`, updated in place — same file as the prior
build report, not a new one).

---

## 1. Investigation — how does this router actually run?

**Confirmed: fully ephemeral, per-invocation, serverless-style. Not a
long-lived process.** Checked directly, not assumed:

- `docker ps -a` on the VPS shows no persistent container for this router —
  it only ever exists as a fresh `docker run --rm --network coolify
  --env-file ... -v /root/schedule-ingest:/app python:3.12-slim ...`
  invocation, one per search, exactly as it's been run every time in this
  investigation so far.
- No crontab (`no crontab for root`), no systemd timer tied to it (checked
  `systemctl list-timers --all` — nothing router-related).
- Each invocation starts a brand-new container, re-runs `pip install
  psycopg2-binary`, opens a fresh `psycopg2.connect()`, and exits — nothing
  in the container's own memory survives to the next call.

**This rules out an in-memory cache outright** — there is no process for it
to live in between searches. The only thing that *does* survive across
invocations is the bind-mounted host directory (`-v
/root/schedule-ingest:/app`, real files on the VPS filesystem) and Postgres
itself. Since schema changes are explicitly out of scope this round, the
materialized-graph approach lands on **a file-based cache on that mounted
directory** rather than a Postgres table — same effect (build once per
date, read fast on every later search), no `CREATE TABLE`.

**A second real finding, worth reporting even though it's outside this
task's direct scope**: the in-script `[perf]` timers from the previous
report only measured what happens *inside* the Python process. Timing the
*whole* `docker run` command end-to-end showed real wall-clock latency
noticeably higher than the script's own number:

```
script-reported total: 5.11s
real (whole docker run):     8.28s
```

The ~3.2s gap is container startup + the `pip install` running fresh every
time — invisible to the script's own timers, and not something per-date
caching touches. Flagging it here since it's part of what a user actually
waits for, but it's a separate optimization (e.g. a prebuilt image with
psycopg2 already installed) from the connection-graph caching asked for
this round.

## 2. Implementation

Added to `scratchpad/csa-router.py` (deployed to the VPS, replacing the
prior version in place):

- **`data_fingerprint(conn)`** — `SELECT count(*), max(id) FROM schedules`.
  Cheap, and robust to the one invalidation trigger that exists today (a
  fresh backfill): `id` is drawn from a sequence that only advances, so a
  re-ingest always produces new IDs even for logically-identical schedules,
  guaranteeing the fingerprint changes without needing any new tracking
  column. (Not tested against a real re-ingest in this pass — that's a
  ~10-minute re-run of the full backfill just to exercise invalidation, and
  wasn't asked for here — but the mechanism itself doesn't depend on
  anything backfill-specific, just on IDs never being reused.)
- **`get_connections_for_date(conn, date, fingerprint)`** — checks
  `cache/conns_<date>.pkl` next to the script; if it exists and its stored
  fingerprint matches the current one, unpickles and returns the
  already-built connection list directly (no `bulk_resolve`, no
  calling-points query, no day-rollover arithmetic). Otherwise builds it
  exactly as before and writes the result back (fingerprint + connections)
  via a temp-file-then-`os.replace` so a concurrent invocation can't observe
  a half-written cache file.
- `search()` now calls this once per date (search date and the following
  day, as before) instead of always rebuilding, and reports `HIT`/`MISS` per
  date in its perf line.

Nothing else changed — station resolution, the CSA scan itself, leg
merging, and output formatting are untouched.

## 3. Re-verification — same three cases, cache warm

All three re-run against the now-populated `2026-08-20`/`2026-08-21` cache.
**Identical itineraries to the pre-caching report, byte-for-byte on the
route content:**

```
Solihull -> Birmingham Moor Street
Leg 1: P69343 (LM)  SOLIHUL 08:11  ->  BHAMMRS 08:26
Total journey time: 0:15:00

Solihull -> Manchester
Leg 1: Y81130 (LM)  SOLIHUL 08:09  ->  DORIDGE 08:16
    change at DORIDGE, wait 0:16:00
Leg 2: L37406 (CH)  DORIDGE 08:32  ->  LMNGTNS 08:52
    change at LMNGTNS, wait 0:25:00
Leg 3: G00851 (XC)  LMNGTNS 09:17  ->  MNCRPIC 11:29
Total journey time: 3:20:00

WTB -> WDM
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
Total journey time: 6:12:00
```

Caching changed speed only, not results.

## 4. Real numbers — cold vs. warm

**Cold (`2026-08-20`/`2026-08-21`, cache empty, first search of the day):**

```
[perf] fingerprint check: 0.083s
[perf] connection graph (d0=MISS d1=MISS): 6.712s (564116 connections)
[perf] CSA scan: 0.709s
[perf] total (in-script): 7.504s
real (whole docker run):  10.492s
```

**Warm (same date, cache populated by the run above) — three separate
searches, different origin/destination each time, same date:**

```
                              in-script total   whole docker run
Solihull -> Moor Street            1.399s            4.642s
Solihull -> Manchester             1.507s            4.421s
Whitby -> Windermere                1.496s            4.607s
```

**In-script speedup: ~7.5s -> ~1.4-1.5s, roughly 5x.** The connection-graph
build step itself (the part actually being cached) drops from **6.7s to
~0.6s** — an 11x reduction on the piece this task targeted. The CSA scan
(~0.7-0.85s) is unchanged, as expected — caching doesn't touch it.

**Whole-command latency only drops from ~10.5s to ~4.5s (about 2.3x), not
5x** — because the ~3.2s container-startup/pip-install overhead identified
in §1 is untouched by this change and now makes up the majority of what's
left. That gap is real and worth fixing next, but it's a different problem
(container/dependency warm-start) from the one this task scoped: caching
the per-date connection graph, which is done and confirmed working.

**Disk cost**: each date's cache file is ~23MB (`conns_2026-08-20.pkl` =
23,863,919 bytes; `conns_2026-08-21.pkl` = 23,885,963 bytes) — negligible
against the 13GB free, but scales linearly with how many distinct dates get
queried over time with no eviction. Not an issue at today's scale; worth a
retention policy (e.g. keep only the last N days) before this runs
unattended for weeks.

---

## Explicitly not done, per scope

No live overlay, no UI, no Postgres schema changes (file cache used
instead, as reasoned in §1), no site-repo changes beyond this report and
the router script. Container-startup/pip-install overhead (§1, §4) is
reported, not fixed — separate problem. Cache eviction/retention policy not
implemented — flagged, not built.

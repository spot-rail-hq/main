# Persistent journey-search service — build report

Long-running process wrapping the CSA router, deployed as a standalone
service on `srhq-prod`. 2026-08-20. No public/site exposure, no Vercel↔VPS
auth, no UI, no schema changes — all as scoped. Reference copies:
`scratchpad/journey-search-service.py` (deployed as `service.py`) and
`scratchpad/Dockerfile.journey-search` (deployed as `Dockerfile`).

---

## 1. Deployment — what "same pattern as the subscriber" actually meant, and one deviation flagged

Checked the existing Darwin subscriber directly before deciding how to
deploy this: `docker ps` shows it as `o1498lzpzvgu85caebsnldob-222033158400`,
Coolify project `srhq-infra`, `coolify.managed: true`, a **Node.js** app
(`node index.js`) with `DARWIN_BOOTSTRAP_SERVER`/`DARWIN_CONSUMER_GROUP`/
`DARWIN_USERNAME`/`DARWIN_PASSWORD` env vars (confirming it's the Kafka
consumer) plus `COOLIFY_BRANCH`/`SOURCE_COMMIT` — i.e. Coolify built and
deployed it from a connected **git repository**, not a one-off `docker run`.

**I did not replicate that git-managed half of the pattern, and I'm
flagging it rather than quietly approximating it.** Doing so would need
either a git remote for this service (none exists, and creating one is a
real infrastructure decision beyond "wrap the router as a service") or
driving the Coolify dashboard directly (reachable at
`http://95.217.157.127:8000`, but no credentials for it exist in `.env` or
memory, and I'm not going to guess at credentials for an admin panel).

**What I did instead, matching the *operational* shape of the subscriber**
(a persistent container on the `coolify` Docker network, restarting on its
own):

- Built a real image (`docker build`) from a small, standalone
  `/root/journey-search/` directory (`Dockerfile` + `service.py` only — not
  built from `/root/schedule-ingest`, to keep the build context clean of the
  cache files and research scripts living there).
- Ran it via `docker run -d --name journey-search-svc --restart
  unless-stopped --network coolify --env-file /root/schedule-ingest/.env -v
  /root/schedule-ingest/cache:/app/cache -p 127.0.0.1:8090:8090
  journey-search:latest` — long-lived (no `--rm`), survives reboots
  (`unless-stopped`, confirmed via `docker inspect`), on the same Docker
  network as everything else, reusing the exact same on-disk cache
  directory the router script already populated.
- Published to **loopback only** (`127.0.0.1:8090`, not `0.0.0.0`) — reachable
  from the VPS's own shell for this verification, not from the public
  internet. Matches "standalone only," not wired to anything public.

**If you want it properly Coolify-managed** (dashboard-visible, git-deployed,
auto-redeploy on push) that's a real next step, not done here — say the word
and I'll either drive the dashboard (need credentials) or set up a git
remote for it.

## 2. The endpoint

`POST /journey-search` — JSON body `{"origin", "destination",
"depart_after"}` (`depart_after` as `"YYYY-MM-DD HH:MM"`, same format the
script took as a CLI arg). Returns the same itinerary shape as the script's
printed output, as JSON: `legs` (train UID, ATOC, origin/destination tiploc
+ time), `changes` (interchange tiploc + wait per change), `total_journey_time`,
plus a `perf` block reporting which cache tier (`memory`/`disk`/`build`)
served each of the two dates involved and the real timing breakdown. Also
added `GET /healthz` (not asked for, trivial, useful for confirming the
process is up and what it currently has cached — reports `cached_dates`).

## 3. Re-verification — all three cases, through the live endpoint

Real `curl -X POST` responses against the running container, immediately
after startup (so these came from the on-disk cache loaded into memory at
process start, not a fresh build):

**Solihull → Birmingham Moor Street** — identical to the script:
```
legs: [{"train_uid":"P69343","atoc_code":"LM","origin_tiploc":"SOLIHUL","origin_time":"2026-08-20 08:11","destination_tiploc":"BHAMMRS","destination_time":"2026-08-20 08:26"}]
changes: []
total_journey_time: "0:15:00"
```

**Solihull → Manchester** — identical to the script (2 changes, 3 legs):
```
legs: Y81130(LM) SOLIHUL 08:09->DORIDGE 08:16, L37406(CH) DORIDGE 08:32->LMNGTNS 08:52, G00851(XC) LMNGTNS 09:17->MNCRPIC 11:29
changes: [DORIDGE wait 0:16:00, LMNGTNS wait 0:25:00]
total_journey_time: "3:20:00"
```

**Whitby → Windermere** — identical to the script (5 changes, 6 legs):
```
legs: G86048(NT) WTBY 08:44->MDLSBRO 10:17, C32286(NT) MDLSBRO 10:26->DLTN 10:55,
      C02000(GR) DLTN 11:02->NWCSTLE 11:35, C31778(NT) NWCSTLE 11:53->CARLILE 13:20,
      W84888(TP) CARLILE 13:28->OXENHLM 14:06, G85384(NT) OXENHLM 14:39->WMER 14:56
changes: [MDLSBRO 0:09:00, DLTN 0:07:00, NWCSTLE 0:18:00, CARLILE 0:08:00, OXENHLM 0:33:00]
total_journey_time: "6:12:00"
```

All three byte-identical to the standalone script's output — deploying as a
service changed nothing about the results, exactly as it shouldn't.

## 4. Real latency — cold vs. warm, in the persistent process

All three re-verification calls above already came back served from
`cache_tier_d0`/`d1` = `"memory"` (the process loaded `2026-08-20`/
`2026-08-21`'s pickles at startup, since they already existed on disk from
the prior task), each taking **~0.72–0.81s total** — essentially all of
that is the CSA scan itself (~0.72–0.79s), not graph loading (~0.005–0.02s).

To show a genuine **first-ever** request for a date the process has never
seen (no memory entry, no disk file), I queried a date outside the existing
cache (`2026-08-25`) and then repeated it:

```
COLD  (2026-08-25, first request, tiers: build/build):
  build_seconds: 7.29   csa_seconds: 0.77   total_seconds: 8.06
  (curl wall time: 8.08s)

WARM  (2026-08-25, second request, different route, tiers: memory/memory):
  build_seconds: 0.0098  csa_seconds: 0.75   total_seconds: 0.76
  (curl wall time: 0.78s)
```

**This is the number that matters for the ask**: warm requests land at
**~0.76–0.81s**, well below the 4.5s per-invocation wall-time figure from
the fresh-container version — because the ~3.2s container-startup/pip-install
cost identified in that report is now paid exactly once at process start,
never per search, and the ~6.7s connection-graph build cost is paid exactly
once per new date, not per search. What's left (~0.72–0.79s) is the CSA
scan itself, which was never the slow part and isn't touched by any of this
caching work.

**Cold, first-ever request for a brand new date, is *slower* now (8.06s
in-process) than the old fresh-container cold path (7.5s in-script /
10.5s wall)** in absolute in-process terms — expected and not a regression:
it's paying the identical one-time connection-graph build cost, just
without a container/pip layer wrapped around it this time (there's nothing
to amortize on the very first hit). The entire point of moving to a
long-lived process is that this cost is now paid **once per date**, ever,
for as many searches as the service handles that day — not once **per
search**, which is what made the fresh-container version fundamentally
non-scaling.

## 5. Cache retention

`cleanup_cache()` runs once at process startup: keeps `cache/conns_<date>.pkl`
for today through today+3 (5 files max at any time, "current + next few
days" per the ask), deletes anything else. Verified against real files, not
just code review — before restart the cache directory held 4 files
(`2026-08-20`, `2026-08-21`, `2026-08-25`, `2026-08-26`, the latter two left
over from the cold-test above); a `docker restart journey-search-svc`
produced this in the logs:

```
[startup] cache retention: removed 2 stale file(s): ['conns_2026-08-26.pkl', 'conns_2026-08-25.pkl']
[startup] loaded 2 date(s) from disk cache into memory: ['2026-08-20', '2026-08-21']
```

Directory afterward: only `conns_2026-08-20.pkl` and `conns_2026-08-21.pkl`
remain. At ~23MB/date and a 5-day retention ceiling, disk cost from this
cache is now bounded at roughly ~115MB regardless of how long the service
runs unattended — a fixed cap instead of the unbounded growth flagged in
the prior report.

One honest limitation: **retention is enforced at process startup, not
continuously.** A date built during the day that falls outside the
today+3 window (like `2026-08-25` was, relative to `2026-08-20`) stays on
disk until the next restart — harmless at this scale (a handful of extra
~23MB files between restarts), but worth knowing if the service is expected
to run for very long unattended stretches without ever restarting.

---

## Explicitly not done, per scope

No public/site exposure, no Vercel↔VPS auth, no UI, no Postgres schema
changes. Not driven through Coolify's own dashboard/git pipeline (flagged
in §1, not actioned) — the service is deployed as a real long-running,
network-attached, restart-policy'd container, but outside Coolify's own
management UI. Container/pip-install overhead from the previous report is
irrelevant now (paid once at image build / container start, not per
request) and wasn't touched further.

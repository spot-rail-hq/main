# Point-to-point last-mile — build report

Follows `scratchpad/point-to-point-last-mile-investigation.md`. Not
committed or pushed — everything below is uncommitted working-tree state
for Aaron to review via GitHub Desktop, per the ask.

**Continuation session addendum (same day)**: this session was explicitly
authorized and scoped to access the VPS directly, superseding the prior
session's correct caution. Steps 1/2/3/6 were merged into the REAL live
`service.py` (not the stale reference copy below — see "Continuation:
merged into the real live service.py" section near the end of this report
for exactly what changed, how the auth gap was closed, and what was
verified live). `scratchpad/journey-search-service.py` has also now been
resynced to match the real deployed file byte-for-byte, closing the
staleness gap flagged in the original build below.

```
 M departures.html                                    (216 insertions, 5 deletions)
?? api/resolve-address.mjs                             (new)
?? scratchpad/point-to-point-last-mile-investigation.md (new — see below)
?? scratchpad/point-to-point-last-mile-service-additions.py (new)
```

**One housekeeping note first**: the investigation this build follows was
never actually written to the tracked repo — my prior session's report
only existed in session-local scratch storage, not
`scratchpad/point-to-point-last-mile-investigation.md`. Recreated it
verbatim from that session's own content before starting this build, so
the file this report references actually exists for you to review
alongside it.

---

## Two things flagged before writing any code, not discovered after

**1. The local `service.py` reference copy is stale, and I didn't edit it
directly.** `scratchpad/journey-search-service.py` (last touched 20 Aug) has
a flat `legs`/`changes`/`total_journey_time` response shape with no
`live_status`, no `connection_risk`, no `leg.type` (walk vs train), no
`origin_name`/`destination_name`. But `departures.html`'s own committed
code — unedited by me, this is what's already live — reads
`data.itineraries[]`, `leg.type === 'walk'`, `leg.live_status`,
`change.connection_risk`, `leg.origin_name`, none of which exist in that
reference copy. Several later builds in this repo's own scratchpad
(footpath relaxation, multi-itinerary ranking, tie detection, live overlay,
arrival risk) evidently shipped to the real VPS without the local copy
ever being resynced. Editing that stale file directly and presenting it as
a diff would have looked like a change that reverts all of that — which
I'm not willing to do without seeing the real current file.

I also don't have live SSH/Postgres access in this session — an attempt to
reach the VPS directly was blocked by this environment's own auto-mode
classifier, correctly, since an unprompted remote write to production
infra is exactly the kind of action that should require your explicit
say-so rather than happening silently.

**What I built instead**: Steps 1/2/3/6 (the `service.py`-side logic) are
written as `scratchpad/point-to-point-last-mile-service-additions.py` — new,
self-contained functions plus one new HTTP route, with no dependency on
anything already in `service.py`. It's designed to be merged in as three
mechanical edits (imports/constants, functions, one new `do_POST` branch)
rather than pasted over the existing file. The file's own header spells
out exactly what to do, including one thing I couldn't resolve myself:
**`journey-search.mjs` sends an `X-Internal-Key` header, but the stale
reference copy has no check for it anywhere — meaning the real auth check
either lives in code I haven't seen or in a reverse-proxy layer in front of
it.** Whoever merges this needs to route `/resolve-address` through
whatever that real check is; I've flagged it rather than guessing at it or
shipping an unauthenticated route next to an authenticated one.

**2. No real Trainline affiliate link exists anywhere in this codebase.**
Checked directly (`grep -rn "trainline\|affiliate\|clickref\|awin" .`) —
every hit was the site's own "Not affiliated with any train operating
company" disclaimer text, a false positive on the word "affiliate," not a
real link. CLAUDE.md lists Trainline/Railcard affiliates as the Trip
Planner monetisation channel, but nothing has actually been wired up on
any page yet. I wasn't going to fabricate a tracking link with a made-up
partner ID — that's the kind of thing that's actively worse than a
placeholder if it ever ships by accident. The banner links to Trainline's
plain public homepage instead (verified there's no dedicated UK coach-
search URL to link to more specifically — coach options surface inside
Trainline's own main journey search, not a separate page), with a comment
flagging exactly what needs to change once a real affiliate link exists.

---

## What was built, per step

**Step 1 — Geocoding + nearest-station resolution.** `geocode_address()`
(Mapbox Temporary Geocoding, GB-biased), `nearest_station_candidates()`
(PostGIS KNN via the `geog <->` operator, `mode='rail'` + real `tiplocs`
join, top 3), `resolve_nearest_station()` (the middle path): always fetches
a real Mapbox Directions walking route for the straight-line-nearest
candidate, and additionally fetches routes for the 2nd/3rd candidates only
when their straight-line distance is within `NEAREST_STATION_AMBIGUITY_RATIO`
(1.5×) of the nearest's own straight-line distance — chosen so a candidate
roughly half again as far still gets checked (matching the scale of the
Birmingham Moor Street/New Street case the investigation drew this
reasoning from), while a candidate at 2–3× the distance is dropped without
a call, since no plausible obstacle detour closes that large a gap. The
winner among whichever candidates were actually fetched is decided by real
walking *duration*, never straight-line distance. Returns
`correction_applied` (whether the 2nd/3rd path fired at all, independent
of whether it changed the winner).

**Step 2 — Walking-leg output.** `estimate_cycle_seconds()` divides the
real walking duration by `CYCLING_SPEED_MULTIPLIER` (3.5, no live API
call, per the confirmed decision). `handle_resolve_address()` attaches
both under `walk` (`distance_meters`/`duration_seconds`, from the real
baseline Directions call) and `cycle_estimate` (`duration_seconds`,
estimated) on the response.

**Step 3 — Affiliate banner logic.** `banner_flag()` — pure data flag,
`{"show": bool, "reason": "beyond_cyclable_distance" | None}`, threshold
`MAX_CYCLABLE_METERS` (8000m). No copy, no markup — exactly as scoped.

**Step 4 — UI address fallback.** `departures.html`'s `wireStationSearch()`
gained an optional 5th parameter, `addressFallback` — when omitted (the
pre-existing Live Departures single-field call site), behavior is
byte-identical to before; every new branch is guarded by
`if (addressFallback)`. When free text matches zero known stations:
- The dropdown shows one row — "Use postcode" or "Search as address"
  depending on whether `UK_POSTCODE_RE` matches — instead of just closing.
- Pressing Enter with zero matches also fires the fallback directly, so a
  postcode typed and entered works without needing to click the dropdown
  row.
- Both paths call the same new `resolveAddress()` → `POST
  /api/resolve-address`, whose result feeds directly into the existing
  `planOrigin`/`planDest` `{crs, name}` state — `performPlanSearch()` and
  `/api/journey-search` are completely untouched, exactly matching the
  investigation's §4 recommendation.

Applied symmetrically to both `plan-origin-input` and `plan-dest-input`,
per the confirmed decision.

**Step 5 — Walking-leg + banner rendering.** `planLastMileCardHtml()`
reuses the same icon/label/route visual shape as the existing
`planWalkLegHtml()` (own `.plan-last-mile-*` CSS, not `.plan-leg-walk`
directly, since this describes how a *field* resolved rather than a leg
inside a found itinerary, and can render before any search has run).
`planAffiliateBannerHtml()` renders only when `banner.show` is true, amber-
styled to match this codebase's existing "delays/warnings" token use
(`RISK_DISPLAY.tight`), deliberately not magenta (reserved for Live/urgent
per CLAUDE.md). A new `#plan-last-mile` slot sits between the search row
and `#plan-results`; `renderPlanLastMile()` draws whichever of
origin/destination resolved via address, and is cleared on a real station
pick, on field-clear, and in `selectPlanRoute()` (saved routes are always
real station pairs).

**Step 6 — Cost/usage instrumentation.** `record_usage()` — a small
`api_usage` table (`provider, product, month, calls`, `CREATE TABLE IF NOT
EXISTS`, idempotent — no separate migration needed before this can run),
incrementing three counters separately: `geocoding`, `directions_baseline`,
`directions_correction`. The three-way split is the point — it's what
actually shows how often the ambiguity path fires in practice, not just
total call volume, which is what determines the real breakeven the task
asked about (see the investigation's own flag that Mapbox's real free tier
is 100k/month per product, not the ~120k figure in the brief — worth
resolving that discrepancy with Aaron once real numbers are coming in).

---

## Behavior observed for the three sanity-check locations

**No live traffic was possible** — no Mapbox token, no VPS/Postgres access
in this session (per the flags above). What *is* testable without any of
that: the deterministic bucket/multiplier/ambiguity logic itself, run
locally against the three locations' investigation-reasoned distances
(session scratch script, deleted after use — not part of this diff):

```
Hathersage -> Hathersage station (~900m)                   dist=900m   walk=11.2min cycle=3.2min  banner=False
Chipping Campden -> Honeybourne, boundary-1m (7999m)        dist=7999m  walk=100.0min cycle=28.6min banner=False
Chipping Campden -> Honeybourne, at boundary (8000m)        dist=8000m  walk=100.0min cycle=28.6min banner=False
Chipping Campden -> Honeybourne, boundary+1m (8001m)        dist=8001m  walk=100.0min cycle=28.6min banner=True
Bishops Castle -> Craven Arms (~13000m)                     dist=13000m walk=162.5min cycle=46.4min banner=True
```

All three behave as the investigation intended: Hathersage stays clear of
the banner, Bishops Castle triggers it, and Chipping Campden sits exactly
on the constant's boundary (confirms `MAX_CYCLABLE_METERS` is the right
single lever to move if the real Mapbox-measured distance for that case
comes back different from the ~8km road-distance estimate — no other logic
needs to change). One thing worth noting that the investigation didn't
spell out numerically: at the walkable/cyclable boundary, the *walking*
time is already 100 minutes — nobody is realistically walking that, so the
"cyclable" bucket's real job is entirely about the cycling estimate (~29
min), not the walking one. That's the intended design, not a bug, but
worth having explicit for whoever reviews the constants later.

Also verified (same offline script): the ambiguity-ratio decision logic
against two synthetic cases shaped like real UK station pairs — a
Birmingham Moor Street/New Street-scale case (544m nearest, 750m 2nd
candidate, within the 1.5× threshold) correctly triggers correction and
picks whichever candidate has the shorter *real* walking duration, even
when that's not the straight-line-nearest one; a Manchester Piccadilly/
Victoria-scale case (600m nearest, 1400m 2nd candidate, beyond 1.5××600m=
900m) correctly skips the correction call entirely. Directions-call counts
matched expectations exactly in both cases (1 baseline + 1 correction vs.
1 baseline + 0 correction) — this is what Step 6's `directions_correction`
counter is actually measuring once live. The UK postcode regex was also
spot-checked against 6 real postcode formats (all matched) and 4 station-
name-shaped strings (none matched).

**Not testable without live traffic, flagged rather than assumed working**:
the actual Mapbox geocoding/Directions calls, the PostGIS KNN query against
real `naptan_stations` data, and the full `/resolve-address` HTTP round
trip end to end. The frontend's fetch/render code was syntax-checked
(`node --check` against the extracted script block — clean) but not
exercised against a live backend, since `/api/resolve-address` has no
working upstream to proxy to until the VPS side is merged and deployed.

---

## Divergences from the investigation's assumptions

- **The investigation assumed a synced local reference copy of
  `service.py` to build against; there wasn't one.** This is the biggest
  divergence — it changed the *shape* of Steps 1/2/3/6's deliverable from
  "an edited file" to "an additive snippet with integration instructions,"
  not the logic itself. Flagged in detail above.
- **No real affiliate link existed to wire into Step 5**, despite the task
  describing one as already existing ("via the existing affiliate link").
  Used a plain, verified-real placeholder URL instead of fabricating a
  tracking link. Flagged in detail above.
- Everything else (constants, thresholds, the middle-path resolution
  logic, the symmetric origin/destination fallback, the pure-data banner
  flag, the Postgres counter shape) matches the investigation's
  recommendations as confirmed in your decisions — no other silent
  deviations.

---

## Not done, per scope

No commit, no push (per the ask — Aaron reviews via GitHub Desktop). No
CLAUDE.md updates (not asked for this pass, though this feature is dense
enough that it'll probably want a section eventually, matching how
thoroughly Darwin/walking-transfers are documented there).

---

## Continuation: merged into the real live service.py

This session was explicitly scoped and authorized to access the VPS
directly — a materially different situation from the prior session, whose
caution (SSH blocked by this environment's own auto-mode classifier) was
correct given it lacked that scoping.

### Step 1 — Real file, real merge

Read `/app/service.py` directly out of the running container
(`o11gss4q6h2h0w83sxm3aj5g-172640539731`, Coolify-managed, resourceName
`srhq-journey-searchmain-...`, project `srhq-infra`) via `docker exec ...
cat` — **58,215 bytes / 1,317 lines**, vs. the stale local reference
copy's 13,888 bytes. Confirms the staleness flagged in the original build
report exactly: the real file already had multi-itinerary ranking
(`run_csa`/`run_csa_fewest_changes`, two full passes), general same-stop
tie detection (`_consider_arrival`, `TieCircuitBreaker`), the live Darwin
overlay (`get_live_status`, `_darwin_event_lookup`), connection-risk
scoring (`classify_connection_risk`, `compute_change_risks`), and footpath
relaxation (`load_footpaths`, `_relax_footpaths*`) — none of which exist
in the local copy that predates all of it.

The merge instructions in
`scratchpad/point-to-point-last-mile-service-additions.py` applied
cleanly with no adaptation needed — the new functions are genuinely
self-contained (no dependency on anything in the real file beyond
`get_conn()`, which already existed and is unchanged) and were inserted
as a new section directly before `class Handler`. **One thing did diverge
from the merge instructions, flagged rather than silently resolved**: the
instructions guessed the real do_POST body based on the stale copy's
shape; the actual current do_POST already had the auth block built in
(see Step 2), so the merge slotted the new `/resolve-address` branch in
*after* the shared auth check rather than needing to add auth logic of
its own — simpler than the instructions anticipated, not harder.

Full diff shape: +7 imports/constants (`urllib.error/parse/request`,
`MAPBOX_TOKEN`, `MAX_WALKABLE_METERS`, `MAX_CYCLABLE_METERS`,
`CYCLING_SPEED_MULTIPLIER`, `NEAREST_STATION_AMBIGUITY_RATIO`,
`MAPBOX_GEOCODING_URL`/`MAPBOX_DIRECTIONS_URL`), +9 new functions
(`mapbox_token`, `geocode_address`, `mapbox_walking_route`,
`nearest_station_candidates`, `resolve_nearest_station`,
`estimate_cycle_seconds`, `banner_flag`, `record_usage`,
`handle_resolve_address`), and `do_POST` restructured to route
`/resolve-address` alongside `/journey-search` through the identical auth
gate. **Zero lines of existing logic (`search`, `run_csa`,
`run_csa_fewest_changes`, `load_footpaths`, `classify_connection_risk`,
etc.) were touched.** File grew 1,317 → 1,635 lines.

Deployed carefully, not blindly: backed up the live file inside the
container first (`/app/service.py.bak-pre-lastmile`, byte-identical to
the pre-merge original, still there now for instant rollback), syntax-
checked the merged file both locally and **inside the container's own
Python 3.12 runtime** before restarting anything.

### Step 2 — Auth: found and matched, not invented

The real file already has the shared-secret gate the prior session
couldn't see: `INTERNAL_KEY = os.environ.get("INTERNAL_KEY")` (module
constant), checked in `do_POST` via `hmac.compare_digest(supplied,
INTERNAL_KEY)` against the `X-Internal-Key` header, fail-closed (503
`auth_not_configured` if the env var itself is unset, before any body is
even read). This is the exact same shared-secret VALUE
`JOURNEY_SEARCH_KEY` already holds on the Vercel side — just a
differently-named env var per deployment target, exactly as flagged in
the investigation (`api/resolve-address.mjs`, written last session, sends
`X-Internal-Key` from `JOURNEY_SEARCH_KEY` and needed zero changes here).

`do_POST` was restructured so `/journey-search` and `/resolve-address`
share one `if self.path not in (...)` allowlist and one auth block —
**not** a second parallel check. Verified directly against the live
service (real requests, see Step 4): wrong key → 401 on the new route,
missing/malformed body → 400, unknown path → 404 with empty body,
identical in shape to how `/journey-search` has always behaved.

### Step 3 — Affiliate link placeholder location

`departures.html:2109` — `var TRAINLINE_BUS_COACH_URL =
'https://www.thetrainline.com/';`, referenced at `departures.html:2113`
inside `planAffiliateBannerHtml()`. The surrounding comment (lines
2102-2108) explains why it's a plain placeholder rather than a real
tracking link. No code change needed — swap the URL string once a real
affiliate link exists.

### Step 4 — Verified against live

**Confirmed: the merge changed nothing about existing behavior.** Re-ran
the exact Solihull→Manchester query from the original footpath-relaxation
verification, before and after the restart:

```
Before merge: found=True, 1 itinerary, criteria=[fastest, fewest_changes],
              4 legs, total=2:18:00, perf.total_seconds=7.61 (cold)
After merge:  found=True, 1 itinerary, criteria=[fastest, fewest_changes],
              4 legs, total=2:18:00, perf.total_seconds=4.79 (warm cache)
```

Same route, same total time, same criteria — and leg-by-leg, still
exactly train→walk→train→train (Solihull→Moor St→New St→Wolverhampton→
Piccadilly), `live_status` populated per train leg and correctly `None`
on the walk leg, `connection_risk` correctly `"n/a"` on the walk-adjacent
change and `"unknown"` (not a false "fine") on the two train↔train
changes for a search this far out. Multi-itinerary ranking, tie
detection, live overlay, footpath legs, and connection-risk scoring are
all confirmed untouched and working, not just assumed.

(One transient `FileNotFoundError` appeared in the container's startup
logs immediately after restart, inside `load_or_build_date`'s
`os.replace()` — in code this merge never touched, and it self-resolved;
the very next request succeeded cleanly with both dates served from
memory. Reads as a restart-timing race on the shared-PID temp-file name
`load_or_build_date` already uses, not a regression — flagging rather
than hiding it, but it predates and is unrelated to this change.)

**New `/resolve-address` route — full behavior matrix, all against the
live service**:

| Test | Result |
|---|---|
| Valid auth + real query, `MAPBOX_TOKEN` not configured | `503 {"error": "MAPBOX_TOKEN not set"}` |
| Wrong `X-Internal-Key` | `401 {"error": "unauthorized"}` |
| Malformed body (missing `query`) | `400 {"error": "bad request: 'query'"}` |
| Unknown path | `404`, empty body (unchanged pre-existing behavior) |

**The Mapbox-dependent happy path could not be exercised live —
`MAPBOX_TOKEN` is not configured on the VPS** (confirmed by listing env
var *names* only inside the container — no value ever printed). This
isn't a gap I could close without a real credential, and I'm not
fabricating one. What I *could* verify, and did: the PostGIS query and
the ambiguity-ratio decision logic, run for real against live
`naptan_stations` data with only the Mapbox network call mocked out
(everything else — the DB round trip, the ratio math, the duration-wins
comparison, the `api_usage` write — genuinely executed):

- `nearest_station_candidates()` against a point near Birmingham New
  Street returned New Street (102m), Moor Street (446m), Snow Hill
  (619m) — real, sane straight-line results, confirms the `mode='rail'`
  + `tiplocs` join SQL is correct against the live schema.
- At a point where Moor St/New St are genuinely close (159m vs. 422m,
  ratio 2.65 — **above** 1.5×): `correction_applied: False`, exactly 1
  Mapbox call made. Ratio logic correctly skips the 2nd candidate.
- At a point where the ratio is 1.09 (well within 1.5×), with the
  straight-line-nearest candidate mocked to have the *slower* real route
  (500s) and the 2nd candidate faster (320s): **the 2nd candidate won**,
  `correction_applied: True`, exactly 2 Mapbox calls made — confirms the
  actual point of the middle path (real duration beats straight-line
  distance) works, not just the call-count gating around it.
- `record_usage()` genuinely wrote to a real `api_usage` table (auto-
  created via `CREATE TABLE IF NOT EXISTS`, confirmed via `SELECT`), then
  those test-only rows were deleted afterward so they don't pollute real
  accounting once traffic starts.
- `banner_flag(1500)` → `{"show": False}`, `banner_flag(9000)` →
  `{"show": True, "reason": "beyond_cyclable_distance"}`,
  `estimate_cycle_seconds(1050)` → `300.0` (= 1050/3.5) — all exactly as
  designed, run live rather than just re-asserted from the offline test.

**What remains genuinely unverified**: the real Mapbox Geocoding and
Directions HTTP calls themselves (network shape, response parsing,
timeout behavior) — needs `MAPBOX_TOKEN` added to this Coolify
application's environment before that's possible. That's the one
concrete next step before this feature can serve real traffic; everything
else in the request path (auth, routing, DB, decision logic, usage
counting, and confirmed non-interference with the existing search) is now
verified against the live system, not just asserted.

### Housekeeping

`scratchpad/journey-search-service.py` — the repo's local reference
copy — has been **resynced to the real deployed file** (pulled fresh from
the container after the restart, confirmed byte-identical to what was
merged). This directly closes the staleness gap this whole continuation
was triggered by; future sessions reading that file will see the real
current state, not the 20-Aug snapshot. The container's own backup
(`/app/service.py.bak-pre-lastmile`) and this session's local temp copies
were left/cleaned up appropriately — nothing extraneous left on the VPS
beyond the one intentional backup file.

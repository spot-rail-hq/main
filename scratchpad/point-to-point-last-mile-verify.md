# Point-to-point last-mile — live Mapbox verification report

Follows `point-to-point-last-mile-investigation.md` and `-build.md`. Verify-only
pass per the ask — no commits, no pushes, no architectural decisions made.

## Blocker found in Step 6 — blocks everything downstream of it

**`https://srhq.uk/api/resolve-address` returns `503 {"error":"upstream_unavailable"}`
on every request**, confirmed with both a free-text address and a real postcode
(`SW1A 1AA`). That 503 is `api/resolve-address.mjs`'s own short-circuit
(`if (!upstreamUrl || !internalKey) return res.status(503)...`) — it fires
**before any network call leaves Vercel**, so no Mapbox call, no VPS call, no DB
call ever happens for real traffic through this endpoint today.

Isolated which of the two env vars it is: the sibling endpoint
`/api/journey-search` (reads `JOURNEY_SEARCH_URL` + the same `JOURNEY_SEARCH_KEY`
resolve-address.mjs uses) works correctly — POSTing to it reaches the real
upstream `service.py` and gets a genuine validation error back
(`{"error": "bad request: 'depart_after'"}`, HTTP 400). Since `JOURNEY_SEARCH_KEY`
is proven present and correct (shared by both files, and journey-search's own
call got past auth to reach real request validation), **`JOURNEY_SEARCH_RESOLVE_URL`
is the missing piece** — it was apparently never added to Vercel's production
env when `api/resolve-address.mjs` was written/deployed.

This is an infra/config gap, not a code bug — I don't have Vercel dashboard
access to add it, and I'm not going to guess at the upstream URL value.

## Session access constraints (checked, not assumed)

- No SSH config, no docker daemon reachable, no Coolify/VPS credentials
  anywhere in this environment — checked `~/.ssh/config`, `~/.ssh/known_hosts`,
  `docker ps`, env vars, the `.vercel/` project config. This session was **not**
  scoped/authorized for direct VPS access the way the prior "continuation
  session" in the build report was.
- Outbound internet access from this session works fine (`curl https://srhq.uk/`
  → 200), so the one live path actually available to me was the public
  `/api/resolve-address` endpoint itself — which is the blocked one above.
- No `MAPBOX_TOKEN`, `JOURNEY_SEARCH_KEY`, or `JOURNEY_SEARCH_RESOLVE_URL`
  values available to me anywhere (correctly — they're not supposed to be in
  a repo or scratch file).

**Net effect: none of Steps 1 (live confirmation)/2/3/4/5/7/8/9 could actually
be executed against live Mapbox or live service.py in this session.** Step 6
was executed and failed at the proxy layer, which is itself the finding.

## What I could still verify: local git repo is stale vs. what's actually deployed

`/Users/chaaaron/Documents/GitHub/srhq-journey-search` (the tracked git repo)
has **no Mapbox code at all** — `service.py` there is 1,317 lines, predates the
last-mile feature entirely (confirmed: zero matches for `mapbox`, `geocod`,
`api_usage`, case-insensitive). The build report already flagged this: the
merge was applied directly to the running container via `docker exec`, never
committed to git. `scratchpad/journey-search-service.py` in *this* repo is the
resynced reference copy (1,635 lines) and does have all of it.

This was already known/flagged in the build report, so not a new finding, but
worth restating as a live risk: **if the VPS container is ever rebuilt/redeployed
from the git repo as it stands, the entire last-mile feature disappears**,
since it exists nowhere in version control. Not mine to fix (git push to that
repo is Aaron's call), just flagging it's still true today.

## Code review of the Mapbox integration (static, since live testing was blocked)

Read `mapbox_token`, `geocode_address`, `mapbox_walking_route`,
`nearest_station_candidates`, `resolve_nearest_station`, `estimate_cycle_seconds`,
`banner_flag`, `record_usage`, `handle_resolve_address`, and the `do_POST`
routing in `scratchpad/journey-search-service.py` end to end, specifically
checking the things Steps 1/3 asked about:

- **Env var name**: `os.environ.get("MAPBOX_TOKEN")` — matches the name the
  task says was set in Coolify exactly. No typo on the code side. (Can't
  independently confirm the Coolify dashboard's variable is actually spelled
  the same, or actually attached to this app, without VPS/Coolify access.)
- **Geocoding URL/params**: `https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json?access_token=...&country=gb&limit=1` —
  correct v5 endpoint shape; `lon, lat = features[0]["center"]` matches Mapbox's
  real `[lon, lat]` center ordering.
- **Directions URL/params**: `https://api.mapbox.com/directions/v5/mapbox/walking/{lon1},{lat1};{lon2},{lat2}?access_token=...&overview=false` —
  correct v5 walking-profile shape and coordinate order (Mapbox takes
  `lon,lat`, not `lat,lon` — the code gets this right on both ends).
- **Units**: no `units` param is passed, so Mapbox defaults to metric — the
  code's own field names (`distance_meters`, `duration_seconds`) match that
  default with no conversion needed. No meters-vs-miles or seconds-vs-minutes
  mismatch found in the code as written.
- **Error handling**: a real zero-match geocode returns Mapbox `200` with
  `features: []`, which `geocode_address` turns into a clean `None` →
  `{"found": False, "error": "No address/postcode match for '<query>'"}` (still
  records one geocoding usage call). An actual Mapbox HTTP error or network
  failure raises `urllib.error.URLError`, caught in `do_POST` as a distinct
  `502 {"error": "mapbox request failed: ..."}`. Both are graceful, not a raw
  crash — this looks correct by inspection, but "a nonsense address that won't
  geocode" specifically needs a live call to confirm Mapbox really does return
  `200`+empty rather than a `422`/`400` for some malformed inputs, which I
  couldn't do.
- **No bugs found** in this code on read-through — lat/lon ordering, units,
  ambiguity-ratio gating, usage-counter increments, and the fail-closed auth/
  token/network error shapes all look internally consistent with the build
  report's description of what was built and verified with the Mapbox call
  itself mocked out.

## Bottom line

| Step | Result |
|---|---|
| 1 — token loaded | Code-side name matches; **live confirmation blocked** |
| 2 — real geocoding | **Blocked** |
| 3 — real Directions | **Blocked** |
| 4 — 3 sanity-check locations, live | **Blocked** |
| 5 — ambiguity correction, live | **Blocked** |
| 6 — real `/resolve-address` end-to-end | **FAIL** — `503 upstream_unavailable`, `JOURNEY_SEARCH_RESOLVE_URL` appears missing from Vercel prod env |
| 7 — bad-input error handling, live | **Blocked** (code reviewed, looks correct) |
| 8 — Mapbox scope/permission errors | **Blocked** (no call was ever reached) |
| 9 — `api_usage` counters incrementing from real traffic | **Blocked** |

No code changes made — nothing in the Mapbox integration itself looked broken
on inspection, and I'm not going to touch Vercel env vars or guess at the
missing URL value. This needs either (a) `JOURNEY_SEARCH_RESOLVE_URL` added to
Vercel's production env so the proxy path works, or (b) direct VPS/Coolify
access granted to this session the way the prior continuation session had it,
so service.py can be exercised directly instead of through the proxy.

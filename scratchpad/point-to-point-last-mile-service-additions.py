"""Point-to-point last-mile — additive service.py functions, NOT a full file.

READ THIS BEFORE MERGING ANYTHING BELOW INTO THE REAL service.py.

This is deliberately NOT a modified copy of scratchpad/journey-search-
service.py. That local reference copy is stale relative to what's actually
deployed: it predates several features departures.html's own committed code
already depends on today (data.itineraries / multi-itinerary ranking,
leg.live_status, change.connection_risk, leg.type == 'walk' footpath legs,
origin_name/destination_name resolved names — none of these exist in the
20-Aug reference copy, all of them are read directly by departures.html's
current planLegHtml()/planInterchangeHtml()/planItineraryHtml()). Presenting
a "full file" edit against that stale copy would look like a diff that
regresses those already-shipped features, which I'm not willing to do
without seeing the real current file. I also don't have live SSH/Postgres
access in this session to pull it directly (blocked by this environment's
own auto-mode classifier for an unprompted remote connection, correctly —
that's not something to route around without you explicitly saying so).

So: everything below is new, self-contained code — new imports, new module-
level constants, new standalone functions, and ONE new HTTP route. None of
it reads or depends on run_csa()/search()/merge_legs() or anything else
already in service.py. Merging it in is three mechanical steps:

  1. Add the imports and constants near the top of service.py (with the
     existing DATABASE_URL/MIN_TRANSFER_MINUTES-style module constants).
  2. Add the functions below as a new section, anywhere at module scope.
  3. Add ONE new branch to the real do_POST — see "HTTP ROUTE" at the
     bottom. It's written as an `elif`/early-return so it doesn't require
     understanding the rest of do_POST's current routing, but you need to
     paste it in as the FIRST check (before whatever `self.path !=
     "/journey-search"` 404 guard exists now), the same shape as this
     stale copy already used for its own single route.

  **Auth, flagged explicitly**: journey-search.mjs sends an X-Internal-Key
  header, but the stale reference copy I read has NO header check anywhere
  in do_POST — meaning either the real current service.py checks it (added
  after this copy was taken and not reflected here) or there's a reverse-
  proxy/Coolify layer in front of it that does. I don't know which, because
  I can't see the real file. **Don't just paste the /resolve-address branch
  in as an unauthenticated route sitting next to an authenticated one** —
  find wherever the real auth check happens for /journey-search today and
  make sure /resolve-address goes through the identical path. This is the
  one integration step I can't fully hand you pre-solved, because it
  depends on code I haven't seen.

  **MAPBOX_TOKEN — VPS env file, not Vercel.** Per the investigation's §5:
  this reads process.env-equivalent (`os.environ`) from wherever service.py
  actually runs (the VPS, via --env-file per the existing deployment
  pattern), NOT a Vercel project environment variable — DARWIN_LDBWS_KEY
  and friends are Vercel-side because Vercel functions read them; this
  token is VPS-side because service.py reads it. Different deployment
  target, same "env var, never hardcoded" principle.

  **api_usage table**: CREATE TABLE IF NOT EXISTS, additive and idempotent
  — safe to run on every request, no separate migration step needed before
  this can go live. Real per-repo migration tracking for this table (if
  ever wanted) is a separate, reviewed step, matching how naptan_stations/
  walking_transfers were tracked after the fact rather than up front.
"""

import urllib.error
import urllib.parse
import urllib.request

# ── Constants — named per the brief, values per the investigation's §1/§2 ──

# Nearest-station distance/time buckets (investigation §2). Sanity-checked
# against Hathersage (~900m, walkable), Chipping Campden→Honeybourne
# (~8km, the genuine boundary case), and Bishops Castle→Craven Arms
# (~13km, clearly beyond — a real bus route already covers exactly this
# gap). Flagged in the investigation as reasoned from known geography, not
# measured against a live Mapbox call — re-verify the 8km boundary
# specifically against real Directions output once this is live.
MAX_WALKABLE_METERS = 2000
MAX_CYCLABLE_METERS = 8000

# Cycling time is ESTIMATED from the real walking duration, not a second
# Directions call (confirmed decision). 3.5x walking pace: the middle of
# the commonly-cited 3-4x range for UK cycling vs walking speed — picked
# over the optimistic end since a rural last-mile walk is as likely to be
# an unlit lane or a real climb as a segregated cycle path. Flagged: this
# has no elevation model in either direction (neither this multiplier nor
# Mapbox's own walking-duration estimate accounts for gradient), so a
# station reachable only via a real climb will read faster than it is.
CYCLING_SPEED_MULTIPLIER = 3.5

# Middle-path nearest-station correction (confirmed decision). The 2nd/3rd
# straight-line-nearest candidate gets its own Directions call ONLY when
# it's within this ratio of the 1st candidate's own straight-line
# distance — i.e. "genuinely close enough that a river/obstacle could
# plausibly make it the real faster walk", not "close in some absolute
# sense". 1.5x: chosen so that a candidate roughly half again as far in
# straight-line terms still gets checked (matching the scale of the
# Birmingham Moor Street/New Street case this reasoning is drawn from —
# 544m straight-line, flagged in walking-transfer-graph-phaseA.md as a
# plausible candidate for exactly this obstacle-correction problem), while
# a candidate meaningfully further out (2x, 3x) is dropped without a call
# — at that gap, no plausible obstacle detour closes it, so spending a
# second Directions call there is pure cost with no realistic chance of
# changing the answer. This is a threshold on the CHEAP pre-filter
# distance (straight-line), used only to decide whether to spend a real
# Directions call — the actual winner is still always decided by real
# walking DURATION (see resolve_nearest_station below), never by this
# ratio directly.
NEAREST_STATION_AMBIGUITY_RATIO = 1.5

MAPBOX_GEOCODING_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places/{}.json"
MAPBOX_DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/walking/{},{};{},{}"


def mapbox_token():
    """Read at call time, not import time — a missing token should 503 the
    one new endpoint that needs it, not crash the whole service (which
    also serves the pre-existing, unrelated /journey-search route) at
    startup. Same distinct-error-shape principle as api/journey-search.mjs's
    own upstream_unavailable: never guess, never silently proceed."""
    token = os.environ.get("MAPBOX_TOKEN")
    if not token:
        raise RuntimeError("MAPBOX_TOKEN not set")
    return token


def geocode_address(query):
    """Mapbox Temporary Geocoding API. Returns (lat, lon) or None if no
    match. country=gb — this service only ever resolves to a GB
    naptan_stations row, so biasing (not hard-restricting, in case of a
    near-border query) to GB avoids wasting the top result slot on a
    same-named place elsewhere."""
    token = mapbox_token()
    encoded = urllib.parse.quote(query.strip())
    url = (
        MAPBOX_GEOCODING_URL.format(encoded)
        + "?"
        + urllib.parse.urlencode({"access_token": token, "country": "gb", "limit": 1})
    )
    with urllib.request.urlopen(url, timeout=8) as resp:
        data = json.loads(resp.read())
    features = data.get("features") or []
    if not features:
        return None
    lon, lat = features[0]["center"]
    return (lat, lon)


def mapbox_walking_route(lat1, lon1, lat2, lon2):
    """Real Mapbox Directions (walking profile) distance/duration between
    two points. Returns (distance_meters, duration_seconds), or None if
    Mapbox reports no route (e.g. genuinely unreachable on foot)."""
    token = mapbox_token()
    url = (
        MAPBOX_DIRECTIONS_URL.format(lon1, lat1, lon2, lat2)
        + "?"
        + urllib.parse.urlencode({"access_token": token, "overview": "false"})
    )
    with urllib.request.urlopen(url, timeout=8) as resp:
        data = json.loads(resp.read())
    routes = data.get("routes") or []
    if not routes:
        return None
    return (routes[0]["distance"], routes[0]["duration"])


def nearest_station_candidates(conn, lat, lon, limit=3):
    """PostGIS KNN pre-filter — straight-line nearest, GiST-indexed via the
    <-> operator (idx_naptan_stations_geog). Filtered to real, resolvable
    NR stations only: mode='rail' (excludes non-NR rows sharing this table,
    e.g. the Newcastle Airport Metro case already documented from Phase A)
    and a real tiplocs join (the same 99.8% coverage already verified in
    the walking-transfer Phase A investigation) — so every candidate
    returned is guaranteed usable by the CSA search this feeds into, not
    just geographically close."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT n.tiploc, n.crs, n.name, n.lat, n.lon,
               ST_Distance(
                 n.geog,
                 ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography
               ) AS straight_line_m
        FROM naptan_stations n
        WHERE n.mode = 'rail'
          AND EXISTS (SELECT 1 FROM tiplocs t WHERE t.tiploc_code = n.tiploc)
        ORDER BY n.geog <-> ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography
        LIMIT %(limit)s
        """,
        {"lon": lon, "lat": lat, "limit": limit},
    )
    return [
        {"tiploc": r[0], "crs": r[1], "name": r[2], "lat": r[3], "lon": r[4], "straight_line_m": r[5]}
        for r in cur.fetchall()
    ]


def resolve_nearest_station(conn, lat, lon, usage):
    """Middle-path nearest-station resolution (investigation §1, confirmed
    as the middle path over both extremes). `usage` is a dict this function
    increments in place (directions_baseline / directions_correction keys)
    so the caller can record real call counts regardless of how this
    function returns.

    Real Mapbox Directions is ALWAYS fetched for the single straight-line-
    nearest candidate (the baseline cost — needed regardless, to show a
    real walking time at all). The 2nd/3rd candidates ONLY get their own
    Directions call when they're within NEAREST_STATION_AMBIGUITY_RATIO of
    the nearest's straight-line distance — see that constant's own comment
    for the reasoning. Among whichever candidates were actually fetched,
    the winner is the one with the shortest REAL walking duration, never
    the shortest straight-line distance — that's the whole point of
    fetching real routes at all.

    Returns (station_dict, walk_distance_m, walk_duration_s,
    correction_applied) or None if no candidate resolves to a real route.
    """
    candidates = nearest_station_candidates(conn, lat, lon, limit=3)
    if not candidates:
        return None

    nearest = candidates[0]
    route = mapbox_walking_route(lat, lon, nearest["lat"], nearest["lon"])
    usage["directions_baseline"] = usage.get("directions_baseline", 0) + 1
    if route is None:
        return None
    best = {"station": nearest, "distance_m": route[0], "duration_s": route[1]}

    ambiguity_threshold_m = nearest["straight_line_m"] * NEAREST_STATION_AMBIGUITY_RATIO
    correction_applied = False
    for cand in candidates[1:]:
        if cand["straight_line_m"] > ambiguity_threshold_m:
            continue  # not genuinely close -- straight-line gap alone rules it out, no call spent
        correction_applied = True
        cand_route = mapbox_walking_route(lat, lon, cand["lat"], cand["lon"])
        usage["directions_correction"] = usage.get("directions_correction", 0) + 1
        if cand_route is None:
            continue
        if cand_route[1] < best["duration_s"]:  # real walking DURATION decides, never straight-line distance
            best = {"station": cand, "distance_m": cand_route[0], "duration_s": cand_route[1]}

    return (best["station"], best["distance_m"], best["duration_s"], correction_applied)


def estimate_cycle_seconds(walk_duration_s):
    """No live Directions call — estimated from the walking leg's own real
    duration via CYCLING_SPEED_MULTIPLIER (confirmed decision)."""
    return walk_duration_s / CYCLING_SPEED_MULTIPLIER


def banner_flag(walk_distance_m):
    """Pure data flag — banner copy/rendering is departures.html's own
    concern (Step 5), not this service's. Buckets per MAX_WALKABLE_METERS/
    MAX_CYCLABLE_METERS above."""
    if walk_distance_m > MAX_CYCLABLE_METERS:
        return {"show": True, "reason": "beyond_cyclable_distance"}
    return {"show": False, "reason": None}


def record_usage(conn, geocoding=0, directions_baseline=0, directions_correction=0):
    """Per-month Mapbox call counters (investigation §6) — tracked
    separately for geocoding / baseline directions / correction directions
    specifically so how often the ambiguity path actually fires in
    practice is visible, not just total call volume. Postgres, not a file
    counter: this service runs as an ephemeral container per
    csa-router-caching.md's own finding (no guaranteed durable local disk
    beyond the bind-mounted cache dir), so a counter needs to live
    somewhere durable across restarts — Postgres already is that, for
    everything else this service touches.

    CREATE TABLE IF NOT EXISTS — additive and idempotent, safe to run on
    every call; not a substitute for a real tracked migration if this
    table is ever formalized, same as naptan_stations/walking_transfers
    were both applied directly first and tracked in schema.sql afterward."""
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS api_usage (
          provider text NOT NULL,
          product  text NOT NULL,
          month    date NOT NULL,
          calls    integer NOT NULL DEFAULT 0,
          PRIMARY KEY (provider, product, month)
        )
        """
    )
    month = datetime.utcnow().date().replace(day=1)
    for product, count in (
        ("geocoding", geocoding),
        ("directions_baseline", directions_baseline),
        ("directions_correction", directions_correction),
    ):
        if count <= 0:
            continue
        cur.execute(
            """
            INSERT INTO api_usage (provider, product, month, calls)
            VALUES ('mapbox', %s, %s, %s)
            ON CONFLICT (provider, product, month)
            DO UPDATE SET calls = api_usage.calls + EXCLUDED.calls
            """,
            (product, month, count),
        )
    conn.commit()


def handle_resolve_address(conn, query):
    """Orchestrates Steps 1-3: geocode -> nearest-station middle-path
    resolution -> cycling estimate -> banner flag -> usage recording.
    Returns the full JSON-ready response dict, or a {"found": False, ...}
    shape on any failure — never raises for an ordinary no-match, only for
    a missing MAPBOX_TOKEN (RuntimeError, handled by the HTTP route below
    as a 503, matching journey-search.mjs's own upstream_unavailable
    shape)."""
    usage = {"directions_baseline": 0, "directions_correction": 0}
    coords = geocode_address(query)
    # One geocode call is spent whether or not it finds a match -- a real
    # request was made either way, so it's recorded either way.
    if coords is None:
        record_usage(conn, geocoding=1)
        return {"found": False, "error": "No address/postcode match for '%s'" % query}
    lat, lon = coords

    resolved = resolve_nearest_station(conn, lat, lon, usage)
    record_usage(
        conn,
        geocoding=1,
        directions_baseline=usage["directions_baseline"],
        directions_correction=usage["directions_correction"],
    )
    if resolved is None:
        return {"found": False, "error": "No usable station found near that location"}

    station, distance_m, duration_s, correction_applied = resolved
    cycle_s = estimate_cycle_seconds(duration_s)
    banner = banner_flag(distance_m)

    return {
        "found": True,
        "query": query,
        "station": {"tiploc": station["tiploc"], "crs": station["crs"], "name": station["name"]},
        # Needed for Step 6's per-request instrumentation visibility and for
        # any future UI/debugging use — the counting itself already happened
        # above via the `usage` dict regardless of whether this field is
        # ever read by a caller.
        "correction_applied": correction_applied,
        "walk": {"distance_meters": round(distance_m), "duration_seconds": round(duration_s)},
        "cycle_estimate": {"duration_seconds": round(cycle_s)},
        "banner": banner,
    }


# ── HTTP ROUTE ──────────────────────────────────────────────────────────
# Paste as the FIRST branch inside the real do_POST, before its existing
# routing — see this file's own header for the auth caveat (find wherever
# /journey-search's real request is authenticated today and apply the
# identical check here; the block below intentionally does NOT include an
# auth check of its own, since I don't have the real current code to know
# what it looks like).
#
#     def do_POST(self):
#         if self.path == "/resolve-address":
#             length = int(self.headers.get("Content-Length", 0))
#             body = self.rfile.read(length)
#             try:
#                 payload = json.loads(body)
#                 query = payload["query"]
#             except (json.JSONDecodeError, KeyError) as e:
#                 self.send_response(400)
#                 self.send_header("Content-Type", "application/json")
#                 self.end_headers()
#                 self.wfile.write(json.dumps({"error": "bad request: %s" % e}).encode())
#                 return
#             conn = get_conn()
#             try:
#                 result = handle_resolve_address(conn, query)
#             except RuntimeError as e:  # MAPBOX_TOKEN not set
#                 self.send_response(503)
#                 self.send_header("Content-Type", "application/json")
#                 self.end_headers()
#                 self.wfile.write(json.dumps({"error": str(e)}).encode())
#                 return
#             except urllib.error.URLError as e:  # Mapbox request itself failed
#                 self.send_response(502)
#                 self.send_header("Content-Type", "application/json")
#                 self.end_headers()
#                 self.wfile.write(json.dumps({"error": "mapbox request failed: %s" % e}).encode())
#                 return
#             finally:
#                 conn.close()
#             self.send_response(200)
#             self.send_header("Content-Type", "application/json")
#             self.end_headers()
#             self.wfile.write(json.dumps(result).encode())
#             return
#         # ... existing /journey-search routing continues unchanged below ...

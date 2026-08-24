#!/usr/bin/env python3
"""Long-running journey-search HTTP service wrapping the CSA router.

Same algorithm as csa-router.py: bulk STP resolution (verified equivalent to
resolve_schedule()), earliest-arrival CSA, day-rollover handling for
midnight-crossing schedules. The difference is the per-date connection
graph is now held in an in-memory dict for the life of this process --
seeded from the on-disk pickle cache at startup when the data fingerprint
still matches, built fresh (and cached to both memory and disk) the first
time a new date is actually requested. Standalone only: not wired to the
public site, no auth, internal endpoint only.
"""
import hmac
import json
import os
import pickle
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

import psycopg2

DATABASE_URL = os.environ["DATABASE_URL"]
# Shared-secret gate: the domain being reachable at all doesn't mean the
# endpoint is open. Required on every /journey-search request, checked
# before the request body is even parsed -- a bad/missing key never gets
# anywhere near get_conn() or the database. Fails closed: if the env var
# itself isn't set, every request is rejected (503), never silently open.
INTERNAL_KEY = os.environ.get("INTERNAL_KEY")
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
RETENTION_DAYS_AHEAD = 3  # keep today .. today+3 (a few days); see cleanup_cache()
MIN_TRANSFER_MINUTES = 5

# Walking-transfer graph (Phase A step 3, part 2a). Hard exclusion, not a
# penalty: any walking_transfers edge longer than this is dropped from the
# footpath graph entirely at load time (see load_footpaths()) -- e.g.
# Manchester Piccadilly<->Victoria (1,316s) never enters the graph at all,
# rather than being a present-but-losing candidate run_csa() has to beat.
MAX_FOOTPATH_SECONDS = 900  # 15 minutes

# Multi-itinerary ranked search (ranked-itinerary build). Pass 2 ("fewest
# changes") only considers itineraries arriving within this many seconds of
# Pass 1's own fastest arrival -- same named-constant pattern as
# MAX_FOOTPATH_SECONDS above. 1800s (30 min) is a first guess, not measured
# against real results yet -- flagged in the delivery report as worth
# revisiting once real searches are seen.
TRANSFER_SEARCH_SLACK_SECONDS = 1800  # 30 minutes

# General same-stop tie detection (supersedes the narrow destination-
# tiploc-only tiebreak). Two arrivals at the same stop within this many
# seconds of each other are treated as a genuine tie -- both kept, neither
# silently discarded -- rather than requiring bit-for-bit equality. See
# run_csa()/_consider_arrival() and the tie-detection investigation report
# for the full reasoning; first guess, not yet tuned against a wide sweep
# of real results beyond the itineraries in the delivery report.
TIE_TOLERANCE_SECONDS = 120  # 2 minutes

# Circuit breaker, NOT a pruning cap (explicit instruction: real tied
# alternatives are never capped or silently dropped up to this point).
# Bounds both a single stop's tied-candidate list (checked in
# _consider_arrival) and total reconstruction work across every tied
# itinerary (checked in _reconstruct_all_chains) -- see TieCircuitBreaker.
# Chosen from real measurement (delivery report, Step 2): the busiest
# station in the whole schedules table (London Waterloo, ~24k distinct
# schedules) produced a real observed maximum far below this.
TIE_CIRCUIT_BREAKER_LIMIT = 1000
PORT = int(os.environ.get("PORT", 8090))

# All schedule/calling-point times are the CIF/Darwin local (Europe/London)
# wall-clock convention -- never UTC. darwin_movements.received_at is a real
# timestamptz, so any comparison against it must go through this zone
# (handles the BST/GMT offset correctly by date, not a hardcoded +1h).
LONDON = ZoneInfo("Europe/London")

# Live-overlay absence classification, per the darwin_movements
# characterization report (scratchpad/darwin-movements-live-overlay-
# characterization.md in the site repo): measured real activation leads
# ranged from -1 min to 4h with no fixed constant, so this is a 3-tier
# read, not a hard cutoff reused from an unrelated system (explicitly not
# the LDBWS +-120/119 min figure -- that governs a different product).
LIVE_OVERLAY_HORIZON_HOURS = 4

# Connection-risk threshold. Reuses MIN_TRANSFER_MINUTES (5) rather than a
# new arbitrary number: that's already this codebase's own stated minimum
# realistic changeover time (the CSA itself refuses to offer any change with
# less than 5 minutes' wait in the first place -- see run_csa()). So every
# "wait" a leg ever reports is >= 5 minutes with zero delay; the question a
# risk flag has to answer is how much of that built-in floor survives once
# the incoming leg's real delay is subtracted. Checked against the real
# waits this router has actually produced so far (Solihull->Manchester: 16,
# 25 min; Whitby->Windermere: 9, 7, 18, 8, 33 min) -- several sit only 2-4
# minutes above the 5-minute floor even at zero delay, which is exactly the
# real-world "tight interchange" case this flag needs to catch:
#   buffer = wait_minutes - incoming_delay_minutes
#   buffer < 0            -> "at_risk"   (would already have missed it)
#   0 <= buffer < 5        -> "tight"     (makes it, but below the assumed
#                                          minimum safe changeover time)
#   buffer >= 5            -> "fine"
CONNECTION_RISK_BUFFER_MINUTES = MIN_TRANSFER_MINUTES

# Point-to-point last-mile (see scratchpad/point-to-point-last-mile-
# investigation.md and -build.md in the site repo for the full reasoning
# behind each of these).
MAPBOX_TOKEN = os.environ.get("MAPBOX_TOKEN")  # read at call time, not here -- see mapbox_token()

# Distance/time buckets for the affiliate banner, sanity-checked against
# Hathersage (~900m, walkable), Chipping Campden->Honeybourne (~8km, the
# genuine boundary case), and Bishops Castle->Craven Arms (~13km, clearly
# beyond -- a real bus route already covers exactly this gap). Reasoned
# from known geography, not measured against a live Mapbox call -- the
# 8km boundary specifically is flagged as worth re-verifying once this is
# live.
MAX_WALKABLE_METERS = 2000
MAX_CYCLABLE_METERS = 8000

# Cycling time is ESTIMATED from the real walking duration, not a second
# Directions call. 3.5x walking pace: the middle of the commonly-cited
# 3-4x range for UK cycling vs walking speed -- picked over the
# optimistic end since a rural last-mile walk is as likely to be an
# unlit lane or a real climb as a segregated cycle path. No elevation
# model in either direction (neither this multiplier nor Mapbox's own
# walking-duration estimate accounts for gradient).
CYCLING_SPEED_MULTIPLIER = 3.5

# Middle-path nearest-station correction. The 2nd/3rd straight-line-
# nearest candidate gets its own Directions call ONLY when it's within
# this ratio of the 1st candidate's own straight-line distance -- i.e.
# "genuinely close enough that a river/obstacle could plausibly make it
# the real faster walk", not "close in some absolute sense". 1.5x:
# matches the scale of the Birmingham Moor Street/New Street case this
# reasoning is drawn from (544m straight-line, already a real corridor
# this service's own footpath graph above resolves via walking_transfers)
# while dropping a candidate at 2-3x the distance without spending a
# call, since no plausible obstacle detour closes that large a gap. This
# is a threshold on the CHEAP pre-filter distance, used only to decide
# whether to spend a real Directions call -- the actual winner is always
# decided by real walking DURATION (see resolve_nearest_station), never
# by this ratio directly.
NEAREST_STATION_AMBIGUITY_RATIO = 1.5

MAPBOX_GEOCODING_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places/{}.json"
MAPBOX_DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/walking/{},{};{},{}"

STP_ORDER_SQL = "CASE stp_indicator WHEN 'C' THEN 0 WHEN 'N' THEN 1 WHEN 'O' THEN 2 WHEN 'P' THEN 3 END"
BULK_RESOLVE_SQL = f"""
    SELECT DISTINCT ON (train_uid) id, train_uid, atoc_code, stp_indicator
    FROM schedules
    WHERE schedule_start_date <= %(d)s AND schedule_end_date >= %(d)s
      AND substring(days_runs FROM extract(isodow FROM %(d)s::date)::int FOR 1) = '1'
    ORDER BY train_uid, {STP_ORDER_SQL}
"""

_lock = threading.Lock()
_mem_cache = {}  # date isoformat -> connections list
_fingerprint = None


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def data_fingerprint(conn):
    cur = conn.cursor()
    cur.execute("SELECT count(*), max(id) FROM schedules")
    return cur.fetchone()


def resolve_stations(conn, query):
    cur = conn.cursor()
    q = query.strip().upper()
    if len(q) == 3:
        cur.execute("SELECT tiploc_code, name, crs FROM tiplocs WHERE crs = %s", (q,))
        rows = cur.fetchall()
        if rows:
            return rows
    cur.execute(
        "SELECT tiploc_code, name, crs FROM tiplocs WHERE crs IS NOT NULL AND name ILIKE %s ORDER BY name",
        (q + "%",),
    )
    return cur.fetchall()


def tiploc_names(conn, codes):
    """tiploc_code -> human-readable name, straight from tiplocs.name (the
    same table resolve_stations() already queries for the CRS/name search --
    real NROD reference data, not something the frontend needs a second
    source for). Falls back to the code itself for anything not found
    (there is no gap in practice -- checked live against every tiploc in
    the three verification itineraries, 12/12 had a real name -- but never
    crash a response over a missing display label)."""
    codes = list(set(codes))
    if not codes:
        return {}
    cur = conn.cursor()
    cur.execute("SELECT tiploc_code, name FROM tiplocs WHERE tiploc_code = ANY(%s)", (codes,))
    found = dict(cur.fetchall())
    return {c: (found.get(c) or c) for c in codes}


def bulk_resolve(conn, date_str):
    cur = conn.cursor()
    cur.execute(BULK_RESOLVE_SQL, {"d": date_str})
    return cur.fetchall()


def fetch_calling_points(conn, schedule_ids):
    if not schedule_ids:
        return {}
    cur = conn.cursor()
    cur.execute(
        """
        SELECT cp.schedule_id, cp.seq, cp.tiploc_code,
               COALESCE(cp.public_arrival, cp.arrival) AS arr,
               COALESCE(cp.public_departure, cp.departure) AS dep
        FROM calling_points cp
        WHERE cp.schedule_id = ANY(%s) AND cp.is_stop = true
        ORDER BY cp.schedule_id, cp.seq
        """,
        (list(schedule_ids),),
    )
    by_schedule = defaultdict(list)
    for schedule_id, seq, tiploc, arr, dep in cur.fetchall():
        by_schedule[schedule_id].append((seq, tiploc, arr, dep))
    return by_schedule


def hhmm_to_minutes(s):
    return int(s[:2]) * 60 + int(s[2:4])


def _darwin_event_lookup(conn, tiploc, event_type, sched_aware):
    """The only real join to darwin_movements: tiploc + scheduled-time
    proximity, never a direct key (there isn't one -- see the join
    investigation). darwin_movements is append-only, so among rows matching
    this exact scheduled event, prefer any is_actual=true row (a confirmed
    actual) over a forecast, and take the latest received_at within
    whichever group wins -- `ORDER BY is_actual DESC, received_at DESC`
    does both in one pass.

    The +-window bounds the scan to the received_at index (60M+ row table,
    no index on rid) rather than filtering discovery on the whole history.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT rid, expected_or_actual, is_actual, delay_minutes, source, received_at
        FROM darwin_movements
        WHERE tiploc = %s AND event_type = %s
          AND replace(scheduled, ':', '') = %s
          AND received_at BETWEEN %s AND %s
        ORDER BY is_actual DESC, received_at DESC
        LIMIT 1
        """,
        (
            tiploc,
            event_type,
            sched_aware.strftime("%H%M"),
            sched_aware - timedelta(hours=12),
            sched_aware + timedelta(hours=2),
        ),
    )
    return cur.fetchone()


def get_live_status(conn, tiploc, event_type, sched_dt_local, now=None):
    """Live overlay for one scheduled calling-point event (a leg's origin
    departure, in current usage -- see search()). sched_dt_local is a naive
    datetime whose H:M is the real local (Europe/London) scheduled time,
    exactly as carried throughout the router's own connection-graph
    arithmetic (never UTC-converted internally).

    Returns a dict; never raises on "no data", since absence is an expected,
    classified outcome here, not an error.
    """
    sched_aware = sched_dt_local.replace(tzinfo=LONDON)
    now = now or datetime.now(timezone.utc)

    row = _darwin_event_lookup(conn, tiploc, event_type, sched_aware)
    if row is not None:
        rid, expected_or_actual, is_actual, delay_minutes, source, received_at = row
        return {
            "status": "actual" if is_actual else "forecast",
            "scheduled": sched_dt_local.strftime("%H:%M"),
            "expected_or_actual": expected_or_actual,
            "delay_minutes": delay_minutes,
            "source": source,
            "rid": rid,
            "received_at": received_at.isoformat(),
        }

    # No record -- classify per the characterization report's 3-tier read.
    # Measured real activation leads ranged from -1 min to 4h with no fixed
    # constant, so treat 4h as the point past which absence stops being
    # routine and starts being genuinely uncertain, and the scheduled time
    # itself as the only real hard deadline (no case in that investigation
    # showed a legitimate first-appearance after departure).
    time_until = sched_aware - now
    if time_until > timedelta(hours=LIVE_OVERLAY_HORIZON_HOURS):
        return {
            "status": "not_yet_available",
            "scheduled": sched_dt_local.strftime("%H:%M"),
            "note": f"routine -- more than {LIVE_OVERLAY_HORIZON_HOURS}h before scheduled time, no live data expected yet",
        }
    elif time_until > timedelta(0):
        return {
            "status": "uncertain",
            "scheduled": sched_dt_local.strftime("%H:%M"),
            "note": f"within {LIVE_OVERLAY_HORIZON_HOURS}h of scheduled time with no record yet -- genuinely unknown, not guessed either way",
        }
    else:
        return {
            "status": "expected_but_absent",
            "scheduled": sched_dt_local.strftime("%H:%M"),
            "note": (
                "scheduled time has passed with no darwin_movements record -- "
                "possible unreported disruption; this is NOT a confirmed "
                "cancellation (that case was never actually observed in the "
                "underlying investigation, so it isn't asserted as proven "
                "behavior here)"
            ),
        }


def classify_connection_risk(incoming_arrival_status, wait_minutes):
    """Connection-risk for one interchange, given the incoming leg's arrival
    live_status (from get_live_status) and the scheduled wait in minutes.

    Never assumes "fine" from absent/uncertain data -- only a genuinely
    confirmed actual arrival (status == "actual") produces a real risk
    value; anything else (forecast, uncertain, not_yet_available,
    expected_but_absent) returns "unknown" with a reason naming which.
    """
    status = incoming_arrival_status.get("status")
    if status != "actual":
        return {
            "risk": "unknown",
            "reason": f"incoming arrival status is '{status}', not a confirmed actual -- never assumed fine from this",
        }

    delay = incoming_arrival_status["delay_minutes"]
    buffer_minutes = wait_minutes - delay
    if buffer_minutes < 0:
        risk = "at_risk"
    elif buffer_minutes < CONNECTION_RISK_BUFFER_MINUTES:
        risk = "tight"
    else:
        risk = "fine"

    return {
        "risk": risk,
        "arrival_delay_minutes": delay,
        "wait_minutes": wait_minutes,
        "buffer_minutes": buffer_minutes,
    }


def build_connections_for_date(conn, meta_by_id, base_date):
    cp_by_schedule = fetch_calling_points(conn, meta_by_id.keys())
    connections = []
    for schedule_id, stops in cp_by_schedule.items():
        train_uid, atoc_code = meta_by_id[schedule_id]
        day_offset = 0
        prev_minutes = None
        resolved_stops = []
        for seq, tiploc, arr, dep in stops:
            for kind, val in (("arr", arr), ("dep", dep)):
                if not val:
                    continue
                mins = hhmm_to_minutes(val)
                if prev_minutes is not None and mins < prev_minutes - 60:
                    day_offset += 1
                prev_minutes = mins
            arr_dt = None
            dep_dt = None
            if arr:
                m = hhmm_to_minutes(arr)
                arr_dt = base_date + timedelta(days=day_offset, minutes=m)
            if dep:
                m = hhmm_to_minutes(dep)
                dep_dt = base_date + timedelta(days=day_offset, minutes=m)
            resolved_stops.append((tiploc, arr_dt, dep_dt))

        for i in range(len(resolved_stops) - 1):
            dep_tiploc, _, dep_dt = resolved_stops[i]
            arr_tiploc, arr_dt, _ = resolved_stops[i + 1]
            if dep_dt is None or arr_dt is None:
                continue
            connections.append(
                {
                    "schedule_id": schedule_id,
                    "train_uid": train_uid,
                    "atoc_code": atoc_code,
                    "dep_tiploc": dep_tiploc,
                    "dep_dt": dep_dt,
                    "arr_tiploc": arr_tiploc,
                    "arr_dt": arr_dt,
                }
            )
    return connections


def load_footpaths(conn):
    """tiploc -> [(neighbor_tiploc, walk_seconds, walk_meters), ...],
    direction-resolved from walking_transfers (see scratchpad/walking-
    transfer-phaseA-step2*.md in the site repo for how that table was built
    and verified). Symmetric by default (walk_seconds_reverse NULL);
    walk_seconds_reverse overrides only for the handful of confirmed
    genuinely-asymmetric elevation-driven pairs. MAX_FOOTPATH_SECONDS is
    applied here, per direction independently -- an edge over the ceiling
    in either direction is dropped from the graph on that side, not
    truncated or penalized later, so it can never surface downstream as a
    present-but-losing candidate.

    walk_meters has no reverse column at all (distance was never found
    meaningfully asymmetric across the dataset -- see that same report), so
    the same value is carried for both directions of a pair. Previously
    dropped here entirely (this function used to return only
    (neighbor, walk_seconds) pairs) -- fixed so walk distance survives
    alongside walk time, the same way walk_seconds already does, per the
    investigation report's flagged gap.
    """
    cur = conn.cursor()
    cur.execute("SELECT tiploc_a, tiploc_b, walk_seconds, walk_seconds_reverse, walk_meters FROM walking_transfers")
    footpaths = defaultdict(list)
    for tiploc_a, tiploc_b, walk_seconds, walk_seconds_reverse, walk_meters in cur.fetchall():
        reverse_seconds = walk_seconds if walk_seconds_reverse is None else walk_seconds_reverse
        if walk_seconds <= MAX_FOOTPATH_SECONDS:
            footpaths[tiploc_a].append((tiploc_b, walk_seconds, walk_meters))
        if reverse_seconds <= MAX_FOOTPATH_SECONDS:
            footpaths[tiploc_b].append((tiploc_a, reverse_seconds, walk_meters))
    return dict(footpaths)


class TieCircuitBreaker(Exception):
    """Raised when tie-tracking accumulates more than
    TIE_CIRCUIT_BREAKER_LIMIT tied candidates at one stop, OR more than
    that many total steps while reconstructing every tied itinerary --
    NOT a normal pruning mechanism (real, legitimate ties are never capped
    or silently dropped, per explicit instruction), a safety valve against
    genuinely pathological/runaway growth. When this fires, the caller
    must fail the whole request loudly (see search()) rather than return
    any partial or truncated result -- a truncated tied-candidate set
    would be silently WRONG (it could exclude the actual best-by-risk
    itinerary), which is worse than a clear error.
    """
    def __init__(self, stop, size):
        super().__init__(
            f"tie-tracking circuit breaker tripped at stop {stop!r}: "
            f"{size} (limit {TIE_CIRCUIT_BREAKER_LIMIT}) -- likely a runaway "
            f"walk-graph cycle or a genuinely pathological interchange, not "
            f"a normal result"
        )
        self.stop = stop
        self.size = size


def _consider_arrival(stop, candidate_dt, candidate_entry, earliest_arrival, predecessor, origin_tiplocs):
    """The three-way outcome for a candidate path reaching `stop` at
    candidate_dt, shared by the main scan loop (for scheduled connections)
    and _relax_footpaths (for walks) so both use identical tie logic.

    - Strictly better than the current best by more than
      TIE_TOLERANCE_SECONDS: replaces the tied list outright (the old
      entries are now genuinely dominated, not just narrowly beaten).
    - Within TIE_TOLERANCE_SECONDS of the current best: a genuine tie,
      APPENDED alongside the existing tied list, never dropped in favor of
      it. earliest_arrival[stop] still always tracks the true minimum
      among whatever's tied -- if this candidate is a new true minimum
      (though still within tolerance of the old one), the tolerance window
      re-centers on it, and any previously-tied entry that no longer
      qualifies under the NEW minimum is dropped (the window follows the
      true best, not a stale anchor).
    - Otherwise: ignored.

    origin_tiplocs stops are NEVER touched here, on purpose -- an origin's
    state is fixed by the search itself (depart_after), not something a
    walk or connection should ever revise. The old strict "<" comparison
    got this for free (a non-negative-duration walk back to an origin can
    never be STRICTLY earlier than depart_after, so it never fired); once
    ties also count, "arrives back at the origin at exactly depart_after
    via a round-trip walk" would otherwise both corrupt reconstruction (a
    spurious predecessor entry on a stop that's supposed to have none) and
    -- found while implementing this -- risk unbounded growth, since two
    stops connected by a near-zero-cost round-trip walk (3 real ~0s pairs
    exist in this data) could otherwise tie each other back and forth
    forever. This guard, plus only ever re-triggering propagation on a
    genuinely new state (see `propagate` below, not on a pure tie with the
    anchor unchanged), together close that off. See the delivery report
    for the full reasoning -- this was not anticipated by the investigation.

    Returns whether `stop` reached genuinely NEW state that's worth
    propagating outward from (brand new, or the true minimum improved) --
    a pure tie (anchor unchanged) is recorded but does not re-trigger
    relaxation from `stop`, both because it cannot discover anything the
    anchor's own already-triggered relaxation didn't already cover, and
    because allowing it to re-trigger is exactly the infinite-loop hazard
    above.
    """
    if stop in origin_tiplocs:
        return False

    cur_best = earliest_arrival[stop]
    tolerance = timedelta(seconds=TIE_TOLERANCE_SECONDS)

    if cur_best is None:
        earliest_arrival[stop] = candidate_dt
        predecessor[stop] = [candidate_entry]
        return True

    if candidate_dt < cur_best - tolerance:
        earliest_arrival[stop] = candidate_dt
        predecessor[stop] = [candidate_entry]
        return True

    if candidate_dt <= cur_best + tolerance:
        tied = predecessor.setdefault(stop, [])
        tied.append(candidate_entry)
        propagate = candidate_dt < cur_best
        if propagate:
            earliest_arrival[stop] = candidate_dt
            tied[:] = [e for e in tied if e["arr_dt"] <= candidate_dt + tolerance]
        if len(tied) > TIE_CIRCUIT_BREAKER_LIMIT:
            raise TieCircuitBreaker(stop, len(tied))
        return propagate

    return False


def _relax_footpaths(stop, footpaths, earliest_arrival, predecessor, origin_tiplocs):
    """Improvement-AND-tie fixed-point relaxation outward from `stop`
    across footpath edges, via the shared _consider_arrival() above (same
    tie logic as the main scan loop). Only re-queues a neighbor when
    _consider_arrival reports genuinely new state -- see its own
    docstring for why a pure tie must not re-trigger this, and why
    origin_tiplocs are never touched.

    Unpacks footpaths' 3-tuples (neighbor, walk_seconds, walk_meters).
    """
    if not footpaths:
        return
    stack = [stop]
    while stack:
        cur = stack.pop()
        cur_time = earliest_arrival[cur]
        if cur_time is None:
            continue
        for neighbor, walk_seconds, walk_meters in footpaths.get(cur, ()):
            candidate_dt = cur_time + timedelta(seconds=walk_seconds)
            candidate_entry = {
                "type": "walk",
                "dep_tiploc": cur,
                "dep_dt": cur_time,
                "arr_tiploc": neighbor,
                "arr_dt": candidate_dt,
                "walk_seconds": walk_seconds,
                "walk_meters": walk_meters,
            }
            if _consider_arrival(neighbor, candidate_dt, candidate_entry, earliest_arrival, predecessor, origin_tiplocs):
                stack.append(neighbor)


def _reconstruct_all_chains(stop, origin_tiplocs, predecessor, circuit_breaker_state, visited):
    """Yields every distinct chain (origin -> `stop`) implied by the
    tied-predecessor lists recorded during the scan -- explores every tie
    point along the WHOLE path, not just at the final destination, so a
    genuine tie at an intermediate stop that later reconverges onto the
    same onward service still produces two real, distinct alternatives.

    `visited` is the set of stops already used in the current path being
    built, refused on revisit -- a correctness-critical cycle guard, not
    an optimization: the walk graph has real, confirmed near-zero-cost
    round trips, and even though _consider_arrival's origin-guard and
    propagate-only-on-improvement rule already prevent the SCAN itself
    from growing without bound, nothing about the recorded data otherwise
    guarantees a predecessor chain can't loop back on itself. This makes
    reconstruction itself provably terminating regardless.

    circuit_breaker_state is a shared {"count": int} across the whole
    reconstruction (all destination stops, not per-stop) -- incremented
    once per predecessor-edge explored, which bounds total RECURSION WORK
    (a stronger, earlier bound than just capping final chain count, since
    work done is always >= chains produced).
    """
    if stop in origin_tiplocs or stop not in predecessor:
        yield []
        return
    if stop in visited:
        return
    visited = visited | {stop}
    for c in predecessor[stop]:
        circuit_breaker_state["count"] += 1
        if circuit_breaker_state["count"] > TIE_CIRCUIT_BREAKER_LIMIT:
            raise TieCircuitBreaker(stop, circuit_breaker_state["count"])
        for sub_chain in _reconstruct_all_chains(c["dep_tiploc"], origin_tiplocs, predecessor, circuit_breaker_state, visited):
            yield sub_chain + [c]


def run_csa(connections, origin_tiplocs, dest_tiplocs, depart_after, footpaths=None):
    """Pass 1 ("fastest"). Returns a LIST of every itinerary tied for best
    (within TIE_TOLERANCE_SECONDS) across ALL of dest_tiplocs, or None if
    unreachable -- a real contract change from the single-chain return this
    function used to have (confirmed acceptable: no external callers of
    this function exist today, per the investigation report). Reconciling
    which of the returned chains to actually use is the caller's job (see
    search(), which reuses Step 3's existing risk-scoring machinery
    unchanged for that) -- this function's job is only to find every
    genuinely tied path, not to pick among them.

    earliest_arrival[stop] stays a single scalar throughout -- confirmed in
    the investigation this does not reintroduce Pareto: a tie is two paths
    sharing one value, not two incomparable label values, so there is
    still exactly one correct "best arrival time" per stop. Only
    predecessor[stop] becomes a list.

    Superseded by this: the old per-destination-tiploc re-scan trick
    (resolve_fastest_ties(), removed) -- since every dest_tiploc's true
    arrival is already computed in this SAME scan, checking which ones tie
    the true best is now free, no extra scans needed.
    """
    connections = sorted(connections, key=lambda c: c["dep_dt"])

    earliest_arrival = defaultdict(lambda: None)
    predecessor = {}
    trip_reached = set()

    for t in origin_tiplocs:
        earliest_arrival[t] = depart_after
    if footpaths:
        for t in origin_tiplocs:
            _relax_footpaths(t, footpaths, earliest_arrival, predecessor, origin_tiplocs)

    for c in connections:
        dep_ok = False
        if c["schedule_id"] in trip_reached:
            dep_ok = True
        else:
            ea = earliest_arrival[c["dep_tiploc"]]
            if ea is not None:
                is_origin = c["dep_tiploc"] in origin_tiplocs and ea == depart_after
                buffer_ = timedelta(0) if is_origin else timedelta(minutes=MIN_TRANSFER_MINUTES)
                if ea + buffer_ <= c["dep_dt"]:
                    dep_ok = True
        if not dep_ok:
            continue
        trip_reached.add(c["schedule_id"])
        if _consider_arrival(c["arr_tiploc"], c["arr_dt"], c, earliest_arrival, predecessor, origin_tiplocs):
            if footpaths:
                _relax_footpaths(c["arr_tiploc"], footpaths, earliest_arrival, predecessor, origin_tiplocs)

    best_time = None
    for t in dest_tiplocs:
        ea = earliest_arrival[t]
        if ea is not None and (best_time is None or ea < best_time):
            best_time = ea

    if best_time is None:
        return None

    tolerance = timedelta(seconds=TIE_TOLERANCE_SECONDS)
    circuit_breaker_state = {"count": 0}
    chains = []
    for t in dest_tiplocs:
        ea = earliest_arrival[t]
        if ea is None or ea > best_time + tolerance:
            continue
        # _reconstruct_all_chains already yields chains in forward
        # (origin -> destination) chronological order -- it builds each
        # one as `sub_chain + [c]` with the recursion into earlier stops
        # evaluated first, unlike the old single-chain reconstruction
        # (which walked backward from the destination and needed an
        # explicit .reverse() at the end). No reversal needed here.
        for chain in _reconstruct_all_chains(t, origin_tiplocs, predecessor, circuit_breaker_state, set()):
            if chain:
                chains.append(chain)

    return chains or None


def _relax_footpaths_fewest_changes(stop, footpaths, best_label, predecessor, arrival_deadline):
    """Pass 2's footpath relaxation. best_label[stop] is (transfer_count,
    arrival_dt) instead of Pass 1's bare arrival_dt -- compared
    lexicographically (fewer transfers wins; arrival_dt only breaks ties),
    same improvement-only fixed-point shape as _relax_footpaths() above.
    Walking never changes transfer_count (only boarding a NEW scheduled
    service does -- see run_csa_fewest_changes()), so a walk always
    propagates the CURRENT transfer_count unchanged, just a later arrival.
    arrival_deadline (Pass 1's own fastest arrival +
    TRANSFER_SEARCH_SLACK_SECONDS) gates every candidate here too -- a walk
    landing after it is not explored, mirroring the deadline check in the
    main loop below.
    """
    if not footpaths:
        return
    stack = [stop]
    while stack:
        cur = stack.pop()
        cur_label = best_label[cur]
        if cur_label is None:
            continue
        cur_transfers, cur_time = cur_label
        for neighbor, walk_seconds, walk_meters in footpaths.get(cur, ()):
            candidate_time = cur_time + timedelta(seconds=walk_seconds)
            if candidate_time > arrival_deadline:
                continue
            candidate = (cur_transfers, candidate_time)
            neighbor_label = best_label[neighbor]
            if neighbor_label is None or candidate < neighbor_label:
                best_label[neighbor] = candidate
                predecessor[neighbor] = {
                    "type": "walk",
                    "dep_tiploc": cur,
                    "dep_dt": cur_time,
                    "arr_tiploc": neighbor,
                    "arr_dt": candidate_time,
                    "walk_seconds": walk_seconds,
                    "walk_meters": walk_meters,
                }
                stack.append(neighbor)


def run_csa_fewest_changes(connections, origin_tiplocs, dest_tiplocs, depart_after, arrival_deadline, footpaths=None):
    """Pass 2 ("fewest changes"). Same single-pass connection-scan SHAPE as
    run_csa() (Pass 1, "fastest", left completely unchanged) -- same sort,
    same one-pass iteration, same boarding-buffer rule, same footpath-
    relaxation trick -- but the label tracked per stop is (transfer_count,
    arrival_dt), compared lexicographically: fewer train-to-train changes
    wins outright, arrival time only breaks a tie between two options with
    the SAME transfer count. Every candidate is gated by arrival_deadline
    (Pass 1's own best arrival time + TRANSFER_SEARCH_SLACK_SECONDS) -- an
    itinerary arriving later than that is not a "fewest changes" candidate
    at all, it's just a slower one; this is what keeps this pass bounded
    rather than searching the whole remaining graph for arbitrarily long,
    slow, low-change itineraries nobody would want.

    transfer_count counts DISTINCT SCHEDULED-SERVICE BOARDINGS only -- a
    walk transfer never increments it (walking between stations isn't
    "boarding a service"; see _relax_footpaths_fewest_changes() above).
    This is the classic CSA-literature definition of "number of changes",
    and is DELIBERATELY NOT the same thing as this service's own `changes`
    JSON array length downstream (search()'s change_json/data.changes),
    which counts every adjacent-leg boundary including walk-adjacent ones.
    Flagged in the delivery report as a real, chosen distinction: a walk
    between two trains is one interchange effort in the human sense, not
    two, even though it produces two entries in the displayed `changes`
    list (arrival-then-start-walk, walk-end-then-board). Ranking uses the
    train-boarding count; the displayed change list is unaffected by this
    choice and unchanged in shape.

    trip_transfer_count (schedule_id -> the transfer_count value in effect
    when that schedule was FIRST boarded) is new state Pass 1 never needed:
    Pass 1's trip_reached global set is safe there because a bare arrival
    time has no separate identity to lose track of, but Pass 2 tracks a
    COUNT that must stay tied to the specific physical trip being ridden.
    Without this, a later connection continuing an already-boarded trip
    could read best_label[dep_tiploc] (to learn "how many transfers to
    propagate forward") and pick up an unrelated, coincidentally-better
    label some OTHER path left at that same intermediate calling point --
    silently corrupting this trip's own transfer count. This was found
    while implementing this step, not anticipated in the investigation
    report (which flagged the analogous global-set hazard for full Pareto
    multi-label, but didn't note that even single-label two-pass needs a
    small parallel fix once a count, not just a timestamp, is being
    tracked) -- reported here as new ambiguity surfaced by implementation,
    per the brief.
    """
    connections = sorted(connections, key=lambda c: c["dep_dt"])

    best_label = defaultdict(lambda: None)  # stop -> (transfer_count, arrival_dt)
    predecessor = {}
    trip_reached = set()
    trip_transfer_count = {}  # schedule_id -> transfer_count at first boarding

    for t in origin_tiplocs:
        best_label[t] = (0, depart_after)
    if footpaths:
        for t in origin_tiplocs:
            _relax_footpaths_fewest_changes(t, footpaths, best_label, predecessor, arrival_deadline)

    for c in connections:
        if c["arr_dt"] > arrival_deadline:
            continue  # cheap, conservative prune -- not a true admissible bound, but a real one
        continuing = c["schedule_id"] in trip_reached
        dep_ok = False
        boarding_transfers = None
        if continuing:
            dep_ok = True
            boarding_transfers = trip_transfer_count[c["schedule_id"]]
        else:
            dep_label = best_label[c["dep_tiploc"]]
            if dep_label is not None:
                dep_transfers, dep_time = dep_label
                is_origin = c["dep_tiploc"] in origin_tiplocs and dep_time == depart_after
                buffer_ = timedelta(0) if is_origin else timedelta(minutes=MIN_TRANSFER_MINUTES)
                if dep_time + buffer_ <= c["dep_dt"]:
                    dep_ok = True
                    boarding_transfers = dep_transfers + 1
        if not dep_ok:
            continue
        trip_reached.add(c["schedule_id"])
        trip_transfer_count.setdefault(c["schedule_id"], boarding_transfers)
        candidate = (boarding_transfers, c["arr_dt"])
        cur_label = best_label[c["arr_tiploc"]]
        if cur_label is None or candidate < cur_label:
            best_label[c["arr_tiploc"]] = candidate
            predecessor[c["arr_tiploc"]] = c
            if footpaths:
                _relax_footpaths_fewest_changes(c["arr_tiploc"], footpaths, best_label, predecessor, arrival_deadline)

    best_dest = None
    best_value = None
    for t in dest_tiplocs:
        label = best_label[t]
        if label is not None and (best_value is None or label < best_value):
            best_value = label
            best_dest = t

    if best_dest is None:
        return None

    # Identical reconstruction shape to run_csa() -- confirmed safe for
    # two-pass in the investigation report, since this pass stays
    # single-label internally (one (transfers, arrival) tuple per stop, one
    # predecessor per stop) exactly like Pass 1, just optimizing a
    # different comparison key.
    chain = []
    cur = best_dest
    while cur in predecessor:
        c = predecessor[cur]
        chain.append(c)
        cur = c["dep_tiploc"]
        if cur in origin_tiplocs:
            break
    chain.reverse()
    return chain


def merge_legs(chain):
    """A walk-tagged entry (entry.get("type") == "walk", see
    _relax_footpaths()) is never merged into a neighbor, in either
    direction: only two entries that are BOTH real scheduled connections
    (no "type" key) sharing the same schedule_id continue the same trip.
    Checking `.get("type")` on both sides first (rather than indexing
    "schedule_id" directly) also avoids a KeyError -- a walk entry has no
    schedule_id at all.
    """
    legs = []
    for c in chain:
        prev = legs[-1] if legs else None
        same_trip = (
            prev is not None
            and prev.get("type") != "walk"
            and c.get("type") != "walk"
            and prev.get("schedule_id") == c.get("schedule_id")
        )
        if same_trip:
            prev["arr_tiploc"] = c["arr_tiploc"]
            prev["arr_dt"] = c["arr_dt"]
        else:
            legs.append(dict(c))
    return legs


def load_or_build_date(conn, date_obj):
    """memory -> disk (if fingerprint matches) -> fresh DB build. Returns (connections, tier)."""
    key = date_obj.isoformat()
    with _lock:
        if key in _mem_cache:
            return _mem_cache[key], "memory"

    cache_path = os.path.join(CACHE_DIR, f"conns_{key}.pkl")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "rb") as f:
                cached_fp, conns = pickle.load(f)
            if cached_fp == _fingerprint:
                with _lock:
                    _mem_cache[key] = conns
                return conns, "disk"
        except (EOFError, pickle.UnpicklingError):
            pass

    resolved = bulk_resolve(conn, key)
    meta = {row[0]: (row[1], row[2]) for row in resolved}
    conns = build_connections_for_date(conn, meta, datetime.combine(date_obj, datetime.min.time()))

    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp_path = cache_path + f".tmp{os.getpid()}"
    with open(tmp_path, "wb") as f:
        pickle.dump((_fingerprint, conns), f)
    os.replace(tmp_path, cache_path)

    with _lock:
        _mem_cache[key] = conns
    return conns, "build"


def cleanup_cache(today):
    """Retention: keep today .. today+RETENTION_DAYS_AHEAD cache files only."""
    keep = {(today + timedelta(days=i)).isoformat() for i in range(0, RETENTION_DAYS_AHEAD + 1)}
    if not os.path.isdir(CACHE_DIR):
        return []
    removed = []
    for fname in os.listdir(CACHE_DIR):
        if not (fname.startswith("conns_") and fname.endswith(".pkl")):
            continue
        date_part = fname[len("conns_"):-len(".pkl")]
        if date_part not in keep:
            os.remove(os.path.join(CACHE_DIR, fname))
            removed.append(fname)
    return removed


# ── Shared risk computation (used both for the final response and for
# Step 3's bounded tied-candidate scoring below -- one implementation,
# not two copies that could drift) ──

def compute_leg_statuses(conn, legs, now):
    """Same shape/reasoning as before this pass: None for a walk leg,
    explicitly -- never a get_live_status() call for one. A walk's
    dep_dt/arr_dt are synthetic (a train's real arrival time, or an earlier
    walk's own arrival time, plus walk_seconds), not a real scheduled
    Darwin event: worse than simply finding no data, _darwin_event_lookup()
    matches on tiploc + event_type + scheduled HH:MM string within a
    +-window, so a walk's fabricated time landing on the same HH:MM as some
    unrelated real service at that station would silently attach that
    train's live status to the walk. Skipped entirely, not just discarded
    after the fact.
    """
    return [
        None if leg.get("type") == "walk" else {
            "departure": get_live_status(conn, leg["dep_tiploc"], "departure", leg["dep_dt"], now=now),
            "arrival": get_live_status(conn, leg["arr_tiploc"], "arrival", leg["arr_dt"], now=now),
        }
        for leg in legs
    ]


def compute_change_risks(legs, leg_statuses):
    """One connection_risk dict per adjacent leg pair. Factored out of the
    old inline change_json closure so Step 3's tie-break scoring (below)
    can reuse the EXACT same logic on a candidate chain before it's chosen,
    not a second, potentially-drifting copy of it.
    """
    def last_real_arrival_status(i):
        while i >= 0 and legs[i].get("type") == "walk":
            i -= 1
        return leg_statuses[i]["arrival"] if i >= 0 else None

    risks = []
    for i in range(len(legs) - 1):
        cur_leg, next_leg = legs[i], legs[i + 1]
        wait_minutes = round((next_leg["dep_dt"] - cur_leg["arr_dt"]).total_seconds() / 60)
        if next_leg.get("type") == "walk":
            # Nothing to miss: a walk has no scheduled departure, so a
            # delay on the incoming leg can never cause you to miss it --
            # you simply start walking whenever you actually arrive.
            risks.append({
                "risk": "n/a",
                "reason": "next leg is a walk transfer, not a scheduled service -- there is no departure to miss",
            })
        elif cur_leg.get("type") == "walk":
            incoming_status = last_real_arrival_status(i)
            if incoming_status is None:
                risks.append({
                    "risk": "unknown",
                    "reason": "no preceding scheduled service before this walk -- nothing live to check delay against",
                })
            else:
                risks.append(classify_connection_risk(incoming_status, wait_minutes))
        else:
            risks.append(classify_connection_risk(leg_statuses[i]["arrival"], wait_minutes))
    return risks


def risk_score(risks):
    """Ordinal score for comparing two tied candidates' overall connection
    risk: (count of at_risk changes, count of tight changes), lower is
    better/sorts first. "unknown"/"n/a"/"fine" are all treated as equally
    non-risky here -- this service already refuses to claim "fine" from
    absent live data elsewhere (classify_connection_risk's own stated
    philosophy), so "unknown" isn't penalized in this scoring either, only
    a genuinely CONFIRMED risk is. Not spelled out in the brief beyond
    "prefer the lower-risk itinerary" -- this is the concrete definition
    chosen to implement that; revisit if a different weighting is wanted.
    """
    at_risk = sum(1 for r in risks if r["risk"] == "at_risk")
    tight = sum(1 for r in risks if r["risk"] == "tight")
    return (at_risk, tight)


def chain_arrival(chain):
    return chain[-1]["arr_dt"]


def chain_transfer_count(chain):
    """Number of distinct scheduled-service boardings in a chain, via the
    same merge_legs() used everywhere else -- a walk-tagged leg never
    counts (see run_csa_fewest_changes()'s own docstring for why this is
    deliberately not the same number as len(changes) downstream)."""
    legs = merge_legs(chain)
    return sum(1 for leg in legs if leg.get("type") != "walk")


def route_signature(chain):
    """Ordered sequence of (leg type, dep_tiploc, arr_tiploc, schedule_id)
    across the chain's MERGED legs -- built from merge_legs()'s own output
    shape (the existing itinerary data shape) rather than a new
    representation. schedule_id is included (not just the station
    sequence) so two itineraries that happen to visit the same stations
    but via genuinely different services are never treated as the same
    route; a walk leg's schedule_id is always None (it has no
    schedule_id key), which is fine -- two walk legs between the same two
    stations are the same walk regardless.
    """
    legs = merge_legs(chain)
    return tuple(
        (leg.get("type", "train"), leg["dep_tiploc"], leg["arr_tiploc"], leg.get("schedule_id"))
        for leg in legs
    )


# ── Pass 2's own bounded destination-tiploc tie-break (unchanged, still
# narrow) ──
#
# This build (general same-stop tie detection) is scoped to run_csa()
# (Pass 1) only, per the brief. run_csa_fewest_changes() (Pass 2) still
# only ever keeps ONE label per stop, so resolve_fewest_changes_ties()
# below -- the same per-destination-tiploc re-scan trick Pass 1 used to
# rely on too, before this build -- remains exactly as it was: a real,
# but narrower, tiebreak than Pass 1 now has. A deliberate asymmetry, not
# an oversight -- generalizing Pass 2 the same way was out of scope here.

def resolve_fewest_changes_ties(connections, origin_tiplocs, dest_tiplocs, depart_after, arrival_deadline, footpaths, winning_chain):
    if len(dest_tiplocs) <= 1:
        return [winning_chain]
    target_transfers = chain_transfer_count(winning_chain)
    winning_dest = winning_chain[-1]["arr_tiploc"]
    candidates = [winning_chain]
    for t in dest_tiplocs:
        if t == winning_dest:
            continue
        chain = run_csa_fewest_changes(connections, origin_tiplocs, {t}, depart_after, arrival_deadline, footpaths=footpaths)
        if chain is not None and chain_transfer_count(chain) == target_transfers:
            candidates.append(chain)
    return candidates


def pick_lowest_risk(conn, candidates, now):
    """Step 3's actual tiebreak, given a small (bounded) list of tied
    candidate chains: compute connection-risk for each (never during the
    main scan loop -- only here, on this already-bounded set) and prefer
    the one with fewer at_risk/tight interchanges. A single candidate
    (the overwhelmingly common case) skips all of this, including any
    Darwin lookups beyond what the final chosen itinerary needs anyway.
    """
    if len(candidates) == 1:
        return candidates[0]
    scored = []
    for chain in candidates:
        legs = merge_legs(chain)
        leg_statuses = compute_leg_statuses(conn, legs, now)
        risks = compute_change_risks(legs, leg_statuses)
        scored.append((risk_score(risks), chain))
    scored.sort(key=lambda pair: pair[0])
    return scored[0][1]


def build_itinerary_json(conn, chain, criteria, now):
    """One itinerary's full JSON shape (legs + changes + total_journey_time
    + which criteria it won), reusing compute_leg_statuses/
    compute_change_risks -- the same functions the tie-break above already
    used. tiploc_names() is called separately by search() (once, across
    BOTH itineraries) rather than per-itinerary, so a station appearing in
    both keeps costing one lookup, not two.
    """
    legs = merge_legs(chain)
    leg_statuses = compute_leg_statuses(conn, legs, now)
    risks = compute_change_risks(legs, leg_statuses)

    def leg_json(i, leg, names):
        base = {
            "origin_tiploc": leg["dep_tiploc"],
            "origin_name": names[leg["dep_tiploc"]],
            "origin_time": leg["dep_dt"].strftime("%Y-%m-%d %H:%M"),
            "destination_tiploc": leg["arr_tiploc"],
            "destination_name": names[leg["arr_tiploc"]],
            "destination_time": leg["arr_dt"].strftime("%Y-%m-%d %H:%M"),
        }
        if leg.get("type") == "walk":
            base["type"] = "walk"
            base["walk_seconds"] = leg["walk_seconds"]
            base["walk_meters"] = leg["walk_meters"]
        else:
            base["type"] = "train"
            base["train_uid"] = leg["train_uid"]
            base["atoc_code"] = leg["atoc_code"]
            base["live_status"] = leg_statuses[i]
        return base

    def change_json(i, names):
        cur_leg, next_leg = legs[i], legs[i + 1]
        return {
            "interchange_tiploc": cur_leg["arr_tiploc"],
            "interchange_name": names[cur_leg["arr_tiploc"]],
            "wait": str(next_leg["dep_dt"] - cur_leg["arr_dt"]),
            "connection_risk": risks[i],
        }

    return legs, leg_json, change_json


def search(conn, origin_q, dest_q, depart_after_str):
    t0 = time.time()
    origin_rows = resolve_stations(conn, origin_q)
    dest_rows = resolve_stations(conn, dest_q)
    if not origin_rows:
        return {"found": False, "error": f"No station found for origin '{origin_q}'"}
    if not dest_rows:
        return {"found": False, "error": f"No station found for destination '{dest_q}'"}

    origin_tiplocs = {r[0] for r in origin_rows}
    dest_tiplocs = {r[0] for r in dest_rows}

    depart_after = datetime.strptime(depart_after_str, "%Y-%m-%d %H:%M")
    d0 = depart_after.date()
    d1 = d0 + timedelta(days=1)

    conns_d0, tier0 = load_or_build_date(conn, d0)
    conns_d1, tier1 = load_or_build_date(conn, d1)
    t_build = time.time()
    all_conns = conns_d0 + conns_d1

    # load_footpaths() measured at ~4ms against the live table (1,038 rows)
    # -- part 2b's own timing investigation, cheap enough to call per
    # request rather than needing its own cache tier like the connections
    # graph does.
    footpaths = load_footpaths(conn)

    # Pass 1 ("fastest") -- run_csa() now returns every itinerary tied for
    # best across dest_tiplocs (general same-stop tie detection), not a
    # single chain. TieCircuitBreaker is a safety valve against
    # pathological/runaway tie growth (see that class's own docstring),
    # NOT a normal outcome -- caught here and turned into an explicit,
    # visible error response. Never silently truncated or returned as a
    # partial/wrong result: a truncated tied set could exclude the actual
    # best-by-risk itinerary, which is worse than a clear failure.
    def _perf_so_far(t_last, **extra):
        perf = {
            "cache_tier_d0": tier0,
            "cache_tier_d1": tier1,
            "build_seconds": round(t_build - t0, 4),
        }
        perf.update(extra)
        perf["total_seconds"] = round(t_last - t0, 4)
        return perf

    try:
        fastest_candidates = run_csa(all_conns, origin_tiplocs, dest_tiplocs, depart_after, footpaths=footpaths)
    except TieCircuitBreaker as e:
        t_pass1 = time.time()
        return {
            "found": False,
            "origin_query": origin_q,
            "destination_query": dest_q,
            "depart_after": depart_after_str,
            "error": f"internal: {e}",
            "perf": _perf_so_far(t_pass1, csa_seconds_fastest=round(t_pass1 - t_build, 4)),
        }
    t_pass1 = time.time()

    if fastest_candidates is None:
        return {
            "found": False,
            "origin_query": origin_q,
            "destination_query": dest_q,
            "depart_after": depart_after_str,
            "perf": _perf_so_far(t_pass1, csa_seconds_fastest=round(t_pass1 - t_build, 4)),
        }

    now = datetime.now(timezone.utc)

    chain_fastest = pick_lowest_risk(conn, fastest_candidates, now)
    t_tiebreak1 = time.time()

    fastest_arrival = chain_arrival(chain_fastest)
    arrival_deadline = fastest_arrival + timedelta(seconds=TRANSFER_SEARCH_SLACK_SECONDS)

    # Pass 2 ("fewest changes"). Pass 1's own itinerary always arrives by
    # fastest_arrival <= arrival_deadline, so it is always itself a valid
    # Pass-2 candidate -- chain_fewest_raw should never legitimately come
    # back None here. The fallback below is a defensive safety net against
    # an actual bug in this new pass, not an expected outcome; if it ever
    # fires in practice that's worth investigating, not treating as normal.
    chain_fewest_raw = run_csa_fewest_changes(
        all_conns, origin_tiplocs, dest_tiplocs, depart_after, arrival_deadline, footpaths=footpaths
    )
    if chain_fewest_raw is None:
        chain_fewest_raw = chain_fastest
    t_pass2 = time.time()

    fewest_candidates = resolve_fewest_changes_ties(
        all_conns, origin_tiplocs, dest_tiplocs, depart_after, arrival_deadline, footpaths, chain_fewest_raw
    )
    chain_fewest = pick_lowest_risk(conn, fewest_candidates, now)
    t_tiebreak2 = time.time()

    # Step 4: route-signature dedup. If Pass 1 and Pass 2 landed on the
    # literal same itinerary (common whenever the fastest route also
    # happens to have the fewest changes), show it once, labeled with both
    # criteria, rather than the same result twice.
    if route_signature(chain_fastest) == route_signature(chain_fewest):
        itinerary_specs = [(["fastest", "fewest_changes"], chain_fastest)]
    else:
        itinerary_specs = [(["fastest"], chain_fastest), (["fewest_changes"], chain_fewest)]

    # One bulk tiploc_names() lookup across every leg of every surviving
    # itinerary -- same "never more than a station appears" batching
    # principle as before, just extended across however many itineraries
    # are being returned instead of assuming exactly one.
    all_legs_by_itinerary = [merge_legs(chain) for _, chain in itinerary_specs]
    all_tiplocs = [t for legs in all_legs_by_itinerary for leg in legs for t in (leg["dep_tiploc"], leg["arr_tiploc"])]
    names = tiploc_names(conn, all_tiplocs)

    itineraries_json = []
    for (criteria, chain), legs in zip(itinerary_specs, all_legs_by_itinerary):
        _, leg_json, change_json = build_itinerary_json(conn, chain, criteria, now)
        itineraries_json.append({
            "criteria": criteria,
            "legs": [leg_json(i, leg, names) for i, leg in enumerate(legs)],
            "changes": [change_json(i, names) for i in range(len(legs) - 1)],
            "total_journey_time": str(legs[-1]["arr_dt"] - legs[0]["dep_dt"]),
        })

    t_end = time.time()
    perf = {
        "cache_tier_d0": tier0,
        "cache_tier_d1": tier1,
        "build_seconds": round(t_build - t0, 4),
        "csa_seconds_fastest": round(t_pass1 - t_build, 4),
        "tiebreak_seconds_fastest": round(t_tiebreak1 - t_pass1, 4),
        "csa_seconds_fewest_changes": round(t_pass2 - t_tiebreak1, 4),
        "tiebreak_seconds_fewest_changes": round(t_tiebreak2 - t_pass2, 4),
        "response_build_seconds": round(t_end - t_tiebreak2, 4),
        "total_seconds": round(t_end - t0, 4),
    }

    return {
        "found": True,
        "origin_query": origin_q,
        "destination_query": dest_q,
        "origin_tiplocs": sorted(origin_tiplocs),
        "destination_tiplocs": sorted(dest_tiplocs),
        "depart_after": depart_after_str,
        "itineraries": itineraries_json,
        "perf": perf,
    }


# ── Point-to-point last-mile ──────────────────────────────────────────

def mapbox_token():
    """Read at call time, not import time -- a missing token should fail
    just the /resolve-address request (503), not crash the whole service
    (which also serves the pre-existing, unrelated /journey-search route)
    at startup. Same fail-closed, distinct-error-shape principle as
    INTERNAL_KEY's own auth_not_configured above."""
    if not MAPBOX_TOKEN:
        raise RuntimeError("MAPBOX_TOKEN not set")
    return MAPBOX_TOKEN


def geocode_address(query):
    """Mapbox Temporary Geocoding API. Returns (lat, lon) or None if no
    match. country=gb -- this service only ever resolves to a GB
    naptan_stations row, so biasing (not hard-restricting) to GB avoids
    wasting the top result slot on a same-named place elsewhere."""
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
    """PostGIS KNN pre-filter -- straight-line nearest, GiST-indexed via
    the <-> operator (idx_naptan_stations_geog). Filtered to real,
    resolvable NR stations only: mode='rail' (excludes non-NR rows
    sharing this table, e.g. the Newcastle Airport Metro case) and a real
    tiplocs join (the same coverage this service already relies on for
    resolve_stations()/load_footpaths() above), so every candidate
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
    """Middle-path nearest-station resolution. `usage` is a dict this
    function increments in place (directions_baseline /
    directions_correction keys) so the caller can record real call counts
    regardless of how this function returns.

    Real Mapbox Directions is ALWAYS fetched for the single straight-line-
    nearest candidate (the baseline cost -- needed regardless, to show a
    real walking time at all). The 2nd/3rd candidates ONLY get their own
    Directions call when they're within NEAREST_STATION_AMBIGUITY_RATIO of
    the nearest's straight-line distance -- see that constant's own
    comment above for the reasoning. Among whichever candidates were
    actually fetched, the winner is the one with the shortest REAL
    walking duration, never the shortest straight-line distance.

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
    """No live Directions call -- estimated from the walking leg's own
    real duration via CYCLING_SPEED_MULTIPLIER."""
    return walk_duration_s / CYCLING_SPEED_MULTIPLIER


def banner_flag(walk_distance_m):
    """Pure data flag -- banner copy/rendering is departures.html's own
    concern, not this service's."""
    if walk_distance_m > MAX_CYCLABLE_METERS:
        return {"show": True, "reason": "beyond_cyclable_distance"}
    return {"show": False, "reason": None}


def record_usage(conn, geocoding=0, directions_baseline=0, directions_correction=0):
    """Per-month Mapbox call counters, tracked separately for geocoding /
    baseline directions / correction directions specifically so how often
    the ambiguity path actually fires in practice is visible, not just
    total call volume. Postgres, not a file counter: this service's own
    connection-graph cache (load_or_build_date above) already establishes
    that durable state here belongs in either Postgres or the bind-mounted
    cache dir, never assumed to survive in bare process/container memory
    alone -- Postgres is the simpler fit for a monotonic counter than a
    file would be.

    CREATE TABLE IF NOT EXISTS -- additive and idempotent, safe to run on
    every call; not a substitute for a real tracked migration if this
    table is ever formalized, same as naptan_stations/walking_transfers
    were both applied directly first and tracked in schema.sql
    afterward."""
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
    """Orchestrates geocode -> nearest-station middle-path resolution ->
    cycling estimate -> banner flag -> usage recording. Returns the full
    JSON-ready response dict, or a {"found": False, ...} shape on any
    ordinary no-match -- only raises for a missing MAPBOX_TOKEN
    (RuntimeError) or a failed Mapbox request itself (urllib.error.URLError),
    both handled by do_POST below with their own distinct HTTP status."""
    usage = {"directions_baseline": 0, "directions_correction": 0}
    coords = geocode_address(query)
    # One geocode call is spent whether or not it finds a match -- a real
    # request was made either way, so it's recorded either way.
    if coords is None:
        record_usage(conn, geocoding=1)
        return {"found": False, "error": f"No address/postcode match for '{query}'"}
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
        "correction_applied": correction_applied,
        "walk": {"distance_meters": round(distance_m), "duration_seconds": round(duration_s)},
        "cycle_estimate": {"duration_seconds": round(cycle_s)},
        "banner": banner,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        # /resolve-address (point-to-point last-mile) added alongside the
        # pre-existing /journey-search -- same route-allowlist shape, same
        # shared auth gate below (applied identically to both, not a
        # parallel mechanism), same fail-closed principle throughout.
        if self.path not in ("/journey-search", "/resolve-address"):
            self.send_response(404)
            self.end_headers()
            return

        if not INTERNAL_KEY:
            # Fail closed -- never treat a missing configured secret as "no
            # auth required".
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "auth_not_configured"}).encode())
            return

        supplied = self.headers.get("X-Internal-Key", "")
        if not hmac.compare_digest(supplied, INTERNAL_KEY):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "unauthorized"}).encode())
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if self.path == "/resolve-address":
            try:
                payload = json.loads(body)
                query = payload["query"]
            except (json.JSONDecodeError, KeyError) as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"bad request: {e}"}).encode())
                return

            conn = get_conn()
            try:
                result = handle_resolve_address(conn, query)
            except RuntimeError as e:  # MAPBOX_TOKEN not set
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
                return
            except urllib.error.URLError as e:  # Mapbox request itself failed
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"mapbox request failed: {e}"}).encode())
                return
            finally:
                conn.close()

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return

        # /journey-search -- unchanged from before this feature.
        try:
            payload = json.loads(body)
            origin = payload["origin"]
            destination = payload["destination"]
            depart_after = payload["depart_after"]
        except (json.JSONDecodeError, KeyError) as e:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"bad request: {e}"}).encode())
            return

        conn = get_conn()
        try:
            result = search(conn, origin, destination, depart_after)
        finally:
            conn.close()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            with _lock:
                cached = sorted(_mem_cache.keys())
            self.wfile.write(json.dumps({"status": "ok", "cached_dates": cached}).encode())
            return
        self.send_response(404)
        self.end_headers()


def main():
    global _fingerprint
    conn = get_conn()
    _fingerprint = data_fingerprint(conn)
    print(f"[startup] data fingerprint: {_fingerprint}", flush=True)

    today = datetime.utcnow().date()
    removed = cleanup_cache(today)
    print(f"[startup] cache retention: removed {len(removed)} stale file(s): {removed}", flush=True)

    loaded = []
    if os.path.isdir(CACHE_DIR):
        for i in range(0, RETENTION_DAYS_AHEAD + 1):
            d = today + timedelta(days=i)
            path = os.path.join(CACHE_DIR, f"conns_{d.isoformat()}.pkl")
            if os.path.exists(path):
                try:
                    with open(path, "rb") as f:
                        cached_fp, conns = pickle.load(f)
                    if cached_fp == _fingerprint:
                        _mem_cache[d.isoformat()] = conns
                        loaded.append(d.isoformat())
                except (EOFError, pickle.UnpicklingError):
                    continue
    print(f"[startup] loaded {len(loaded)} date(s) from disk cache into memory: {loaded}", flush=True)
    conn.close()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[startup] listening on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

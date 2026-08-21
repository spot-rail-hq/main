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
import json
import os
import pickle
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg2

DATABASE_URL = os.environ["DATABASE_URL"]
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
RETENTION_DAYS_AHEAD = 3  # keep today .. today+3 (a few days); see cleanup_cache()
MIN_TRANSFER_MINUTES = 5
PORT = int(os.environ.get("PORT", 8090))

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


def run_csa(connections, origin_tiplocs, dest_tiplocs, depart_after):
    connections = sorted(connections, key=lambda c: c["dep_dt"])

    earliest_arrival = defaultdict(lambda: None)
    predecessor = {}
    trip_reached = set()

    for t in origin_tiplocs:
        earliest_arrival[t] = depart_after

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
        cur_ea = earliest_arrival[c["arr_tiploc"]]
        if cur_ea is None or c["arr_dt"] < cur_ea:
            earliest_arrival[c["arr_tiploc"]] = c["arr_dt"]
            predecessor[c["arr_tiploc"]] = c

    best_dest = None
    best_time = None
    for t in dest_tiplocs:
        ea = earliest_arrival[t]
        if ea is not None and (best_time is None or ea < best_time):
            best_time = ea
            best_dest = t

    if best_dest is None:
        return None

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
    legs = []
    for c in chain:
        if legs and legs[-1]["schedule_id"] == c["schedule_id"]:
            legs[-1]["arr_tiploc"] = c["arr_tiploc"]
            legs[-1]["arr_dt"] = c["arr_dt"]
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
    t_d0 = time.time()
    conns_d1, tier1 = load_or_build_date(conn, d1)
    t_build = time.time()
    all_conns = conns_d0 + conns_d1

    chain = run_csa(all_conns, origin_tiplocs, dest_tiplocs, depart_after)
    t_csa = time.time()

    perf = {
        "cache_tier_d0": tier0,
        "cache_tier_d1": tier1,
        "build_seconds": round(t_build - t0, 4),
        "csa_seconds": round(t_csa - t_build, 4),
        "total_seconds": round(t_csa - t0, 4),
    }

    if chain is None:
        return {
            "found": False,
            "origin_query": origin_q,
            "destination_query": dest_q,
            "depart_after": depart_after_str,
            "perf": perf,
        }

    legs = merge_legs(chain)
    return {
        "found": True,
        "origin_query": origin_q,
        "destination_query": dest_q,
        "origin_tiplocs": sorted(origin_tiplocs),
        "destination_tiplocs": sorted(dest_tiplocs),
        "depart_after": depart_after_str,
        "legs": [
            {
                "train_uid": leg["train_uid"],
                "atoc_code": leg["atoc_code"],
                "origin_tiploc": leg["dep_tiploc"],
                "origin_time": leg["dep_dt"].strftime("%Y-%m-%d %H:%M"),
                "destination_tiploc": leg["arr_tiploc"],
                "destination_time": leg["arr_dt"].strftime("%Y-%m-%d %H:%M"),
            }
            for leg in legs
        ],
        "changes": [
            {
                "interchange_tiploc": legs[i]["arr_tiploc"],
                "wait": str(legs[i + 1]["dep_dt"] - legs[i]["arr_dt"]),
            }
            for i in range(len(legs) - 1)
        ],
        "total_journey_time": str(legs[-1]["arr_dt"] - legs[0]["dep_dt"]),
        "perf": perf,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        if self.path != "/journey-search":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
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

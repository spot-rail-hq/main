#!/usr/bin/env python3
"""Earliest-arrival CSA journey router over the SCHEDULE backfill.

Structural pathfinding only: no live Darwin overlay, no UI. Every candidate
schedule is resolved through the exact same STP precedence as the real
resolve_schedule() SQL function before being used to build connections --
implemented as one bulk set-based query per search date (see
bulk_resolve_sql) rather than one round-trip per train_uid, for performance,
but verified equivalent to resolve_schedule() on a real sample (see
verify_bulk_resolve_matches_function()).
"""
import argparse
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]

MIN_TRANSFER_MINUTES = 5

STP_ORDER_SQL = "CASE stp_indicator WHEN 'C' THEN 0 WHEN 'N' THEN 1 WHEN 'O' THEN 2 WHEN 'P' THEN 3 END"

BULK_RESOLVE_SQL = f"""
    SELECT DISTINCT ON (train_uid) id, train_uid, atoc_code, stp_indicator
    FROM schedules
    WHERE schedule_start_date <= %(d)s AND schedule_end_date >= %(d)s
      AND substring(days_runs FROM extract(isodow FROM %(d)s::date)::int FOR 1) = '1'
    ORDER BY train_uid, {STP_ORDER_SQL}
"""


def resolve_stations(conn, query):
    """Real passenger stations only (crs IS NOT NULL) matching a CRS code or name."""
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
    return cur.fetchall()  # [(schedule_id, train_uid, atoc_code, stp_indicator), ...]


def verify_bulk_resolve_matches_function(conn, date_str, sample_size=200):
    """Cross-check the bulk query against real resolve_schedule() calls."""
    cur = conn.cursor()
    cur.execute(
        "SELECT DISTINCT train_uid FROM schedules TABLESAMPLE SYSTEM (0.5) LIMIT %s",
        (sample_size,),
    )
    uids = [r[0] for r in cur.fetchall()]

    bulk = {row[1]: row[0] for row in bulk_resolve(conn, date_str)}

    mismatches = []
    checked = 0
    for uid in uids:
        cur.execute("SELECT id FROM resolve_schedule(%s, %s)", (uid, date_str))
        row = cur.fetchone()
        fn_id = row[0] if row else None
        bulk_id = bulk.get(uid)
        checked += 1
        if fn_id != bulk_id:
            mismatches.append((uid, fn_id, bulk_id))
    return checked, mismatches


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
    """meta_by_id: {schedule_id: (train_uid, atoc_code)}. Returns list of connection dicts."""
    cp_by_schedule = fetch_calling_points(conn, meta_by_id.keys())
    connections = []
    for schedule_id, stops in cp_by_schedule.items():
        train_uid, atoc_code = meta_by_id[schedule_id]
        day_offset = 0
        prev_minutes = None
        resolved_stops = []  # (tiploc, arr_dt or None, dep_dt or None)
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
    connections.sort(key=lambda c: c["dep_dt"])

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
            legs.append(
                {
                    "schedule_id": c["schedule_id"],
                    "train_uid": c["train_uid"],
                    "atoc_code": c["atoc_code"],
                    "dep_tiploc": c["dep_tiploc"],
                    "dep_dt": c["dep_dt"],
                    "arr_tiploc": c["arr_tiploc"],
                    "arr_dt": c["arr_dt"],
                }
            )
    return legs


def search(conn, origin_q, dest_q, depart_after_str, verbose=True):
    t0 = time.time()
    origin_rows = resolve_stations(conn, origin_q)
    dest_rows = resolve_stations(conn, dest_q)
    if not origin_rows:
        print(f"No station found for origin '{origin_q}'")
        return
    if not dest_rows:
        print(f"No station found for destination '{dest_q}'")
        return

    origin_tiplocs = {r[0] for r in origin_rows}
    dest_tiplocs = {r[0] for r in dest_rows}

    depart_after = datetime.strptime(depart_after_str, "%Y-%m-%d %H:%M")
    d0 = depart_after.date()
    d1 = d0 + timedelta(days=1)

    resolved_d0 = bulk_resolve(conn, d0.isoformat())
    resolved_d1 = bulk_resolve(conn, d1.isoformat())

    meta_d0 = {row[0]: (row[1], row[2]) for row in resolved_d0}
    meta_d1 = {row[0]: (row[1], row[2]) for row in resolved_d1}

    conns_d0 = build_connections_for_date(conn, meta_d0, datetime.combine(d0, datetime.min.time()))
    conns_d1 = build_connections_for_date(conn, meta_d1, datetime.combine(d1, datetime.min.time()))
    all_conns = conns_d0 + conns_d1

    t_build = time.time()

    chain = run_csa(all_conns, origin_tiplocs, dest_tiplocs, depart_after)

    t_csa = time.time()

    if verbose:
        print(f"[perf] origin/dest resolve + bulk_resolve + connection build: {t_build - t0:.2f}s "
              f"({len(resolved_d0)} + {len(resolved_d1)} resolved schedules, {len(all_conns)} connections)")
        print(f"[perf] CSA scan: {t_csa - t_build:.2f}s")
        print(f"[perf] total: {t_csa - t0:.2f}s")

    if chain is None:
        print(f"No itinerary found: {origin_q} -> {dest_q} after {depart_after_str}")
        return

    legs = merge_legs(chain)

    print(f"\n{origin_q} -> {dest_q}, depart after {depart_after_str}")
    print(f"Origin tiplocs considered: {sorted(origin_tiplocs)}")
    print(f"Destination tiplocs considered: {sorted(dest_tiplocs)}")
    print("-" * 70)
    for i, leg in enumerate(legs):
        print(f"Leg {i+1}: {leg['train_uid']} ({leg['atoc_code']})  "
              f"{leg['dep_tiploc']} {leg['dep_dt']:%H:%M}  ->  "
              f"{leg['arr_tiploc']} {leg['arr_dt']:%H:%M}")
        if i < len(legs) - 1:
            nxt = legs[i + 1]
            wait = nxt["dep_dt"] - leg["arr_dt"]
            print(f"    change at {leg['arr_tiploc']}, wait {wait}")
    print("-" * 70)
    print(f"Total journey time: {legs[-1]['arr_dt'] - legs[0]['dep_dt']}")
    return legs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("origin")
    ap.add_argument("destination")
    ap.add_argument("depart_after")  # "YYYY-MM-DD HH:MM"
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    conn = psycopg2.connect(DATABASE_URL)

    if args.verify:
        checked, mismatches = verify_bulk_resolve_matches_function(conn, args.depart_after.split(" ")[0])
        print(f"Verified bulk_resolve against resolve_schedule() for {checked} real train_uids: "
              f"{len(mismatches)} mismatches")
        for m in mismatches[:10]:
            print("  MISMATCH:", m)

    search(conn, args.origin, args.destination, args.depart_after)


if __name__ == "__main__":
    main()

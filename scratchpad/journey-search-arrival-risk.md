# Live overlay — arrival status + connection-risk flag

Status only, no build/deploy beyond what's described. All changes are local
to `~/Documents/GitHub/srhq-journey-search/service.py` (not committed, not
pushed, not redeployed). The live Coolify-deployed container was never
touched; verification ran against a separate, throwaway test directory on
the VPS, now deleted.

---

## 1. Arrival status per leg — restructured, as agreed

`live_status` per leg is now `{departure: {...}, arrival: {...}}`, both
built from the same `get_live_status()` / `_darwin_event_lookup()` added
last time, called a second time against the leg's destination
tiploc/time/`'arrival'`. Computed once per leg and reused for both the
leg's own `live_status.arrival` and the following interchange's risk flag,
so each event is only queried once.

## 2. Connection-risk flag — threshold, and why

```
buffer_minutes = wait_minutes - incoming_arrival_delay_minutes
buffer < 0        -> "at_risk"
0 <= buffer < 5    -> "tight"
buffer >= 5        -> "fine"
```

The 5-minute line isn't a new arbitrary number — it's `MIN_TRANSFER_MINUTES`,
already this exact codebase's own stated minimum realistic changeover time
(the CSA itself won't offer a change with less than 5 minutes' wait at
all — see `run_csa()`). That has a real consequence worth stating plainly:
**every wait this router has ever produced is already >= 5 minutes at zero
delay**, so the honest question a risk flag can answer isn't "is the wait
long," it's "how much of that already-thin built-in floor survives once the
incoming train's real delay is subtracted." Reusing the same constant keeps
the risk flag consistent with what the router itself already treats as the
minimum safe changeover, rather than inventing a second, unrelated number.

Checked against the real waits this router has actually produced across
both this pass and the last one — 16, 25 (Solihull→Manchester), 9, 7, 18, 8,
33 (Whitby→Windermere), and this pass's new candidates: 20, 6, 7, 15, 15
(York→Aberdeen), 4 (Dundee→Aberdeen). Several sit only 1-3 minutes above the
5-minute floor even at zero delay (Dalton 7 min, Newcastle 18 min against a
7-min recorded delay, Arbroath 4 min) — exactly the real tight-interchange
shape this flag needs to catch, and evidence the threshold isn't drawn in
an empty part of the distribution.

**Never assumed fine from absent/uncertain data**, exactly as asked: any
arrival status other than `"actual"` — `forecast`, `uncertain`,
`not_yet_available`, `expected_but_absent` — returns `"risk": "unknown"`
with a `reason` naming which one, never a guessed "fine".

## 3. Verification — real, current data, actual values

Ran the modified `service.py` directly (not the deployed service) from a
disposable throwaway directory on the VPS, deleted afterward.

### Original three itineraries — additive, not regressive

All previously-verified fields (`train_uid`, `atoc_code`, times, `wait`,
`total_journey_time`) came back byte-identical to both prior passes. New
fields only add:

- **Solihull → Moor Street**: single leg, both `departure` and `arrival`
  now `"actual"`, 0 delay (rid `202608208069343`) — no change, so no
  `connection_risk` to report.
- **Solihull → Manchester**: see below, in full.
- **Whitby → Windermere**: 5 changes, all now carrying real
  `connection_risk` — MDLSBRO (`fine`, arrival delay -3, wait 9, buffer 12),
  DLTN (`fine`, -2/7/9), NWCSTLE (`fine`, +7/18/11), CARLILE (`fine`, 0/8/8),
  OXENHLM (`unknown` — incoming arrival status `expected_but_absent`, the
  `W84888` leg genuinely has no darwin_movements record at all as of this
  run).

### Solihull → Manchester, in full — real values, as asked

**Dorridge leg** (`Y81130`, Solihull→Dorridge, scheduled arrival 08:16 on
2026-08-20 — now yesterday relative to today, 2026-08-21): **arrival status
is `expected_but_absent`** — genuinely no `darwin_movements` record for this
specific working, checked directly, not assumed.
→ **Connection risk at Dorridge (16-min wait): `"unknown"`**, reason:
`"incoming arrival status is 'expected_but_absent', not a confirmed actual
-- never assumed fine from this"`.

**Leamington Spa leg** (`L37406`, Dorridge→Leamington Spa, scheduled arrival
08:52): **arrival status is `"actual"`**, `expected_or_actual: "08:50"`,
**`delay_minutes: -2`** (2 minutes early), rid `202608207637406`, source
`TD`.
→ **Connection risk at Leamington Spa (25-min wait): `"fine"`** —
`arrival_delay_minutes: -2, wait_minutes: 25, buffer_minutes: 27`.

### Search for a real large-delay-relative-to-wait case

Ran 7 additional real OD pairs through the actual router today (early
departures, so results are settled): Durham→Berwick, York→Aberdeen (6
legs/5 changes), Inverness→Edinburgh, Dundee→Aberdeen, Glasgow Queen
St→Dundee, Fort William→Glasgow Queen St. Across every confirmed-actual
interchange produced, delays ranged from **-5 to +7 minutes** — every one
came back `"fine"`; several others correctly came back `"unknown"` (mix of
`forecast` and `expected_but_absent` reasons, e.g. Haymarket and
Inverkeithing on the York→Aberdeen itinerary, both `forecast`-status
incoming arrivals).

**No `"at_risk"` or `"tight"` case turned up through the router itself.**
Genuinely large real delays do exist in today's raw `darwin_movements` —
checked directly: Caledonian Sleeper legs at Dalmuir/Dumbarton (+204/+205
min, rid `202608216704576`), Inverness +158 min (08:45 scheduled), Euston
+139 min (08:00 scheduled) — but none of these specific delayed workings
happened to be the train the CSA actually selected for any of the OD pairs
tried; earliest-arrival routing doesn't necessarily pass through whichever
train is currently having a bad day elsewhere on the network. Deliberately
picking an OD pair engineered to force one of those specific trains into an
itinerary would cross into constructing an artificial test case, which
wasn't done — same standard as last time. **This case is verified as
correctly implemented (the threshold logic itself, checked by hand against
the formula), but not yet observed in practice through a real router
output** — worth knowing plainly rather than papering over.

---

## Explicitly not done

No UI. No commit, no push, no redeploy — `service.py` in
`~/Documents/GitHub/srhq-journey-search` is the only file changed, staged
for your own review via GitHub Desktop.

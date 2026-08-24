# Point-to-point last-mile — investigation report

Investigation only, per the ask. No code changes, no commits. Grounded
against the actual repo state (not assumed): `api/journey-search.mjs`,
`departures.html`'s Plan a Journey tab, and the `scratchpad/walking-transfer-*`
/ `scratchpad/journey-search-migrations-*` reports describing the live VPS
Postgres schema and the existing `srhq-journey-search` (`service.py`)
architecture. Live Mapbox pricing was fetched directly, not assumed.

---

## 1. Nearest-station lookup design

**Confirmed schema** (`naptan_stations`, via the Alembic baseline
introspection): `tiploc, crs, name, lat, lon, geog, mode, network` — PK
`tiploc`, `geog geography(Point,4326)` with a GiST index
(`idx_naptan_stations_geog`), populated with real `mode`/`network`
classification (the earlier gap found in Phase A — no mode column, Newcastle
Airport Metro sitting undistinguished among real NR stations — has already
been closed by the time of this report).

**Where this query has to run.** Checked directly: no `api/` file in this
repo connects to Postgres at all (`DATABASE_URL` appears nowhere in `api/`).
The only thing with DB access is `service.py` on the VPS. A PostGIS nearest-
station query is therefore not something a new Vercel function can do on its
own — it has to happen where the DB connection already lives. This is a
hard constraint that shapes §4 below, not just a note.

**Return top-3, not top-1 — and here's why, checked against this repo's own
prior finding rather than asserted from first principles.** The
`walking-transfer-graph-phaseA.md` investigation already ran into exactly
the failure mode you're asking about, for the station-to-station case:
straight-line distance is flagged there as "known-unreliable... a river, a
rail cutting, or a one-way pedestrian system... can make the real walk
substantially longer than the straight-line figure implies," and the
pattern that investigation settled on was **straight-line as a cheap
pre-filter, a real routing call for the actual value — never straight-line
as the final answer.**

Recommended shape, reusing that same two-stage pattern:
1. PostGIS KNN (`geog <-> :point`, GiST-indexed, cheap) for the 3 nearest
   candidates, filtered to `mode = 'rail'` and `EXISTS (SELECT 1 FROM
   tiplocs WHERE tiploc_code = naptan_stations.tiploc)` — the same coverage
   join Phase A already verified at 99.8%, so every candidate returned is
   guaranteed resolvable by the CSA router's own station resolution, not
   just geographically close.
2. Mapbox Directions (walking profile) on those 3 candidates, pick the
   station with the shortest *real* walking duration as "nearest" — not the
   shortest straight-line one.

**Flagging the real trade-off, not deciding it silently:** this is 3
Directions calls per address search instead of 1, a genuine 3x cost
increase on the more expensive of the two Mapbox products, on top of the
"no caching" decision already confirmed. Whether that's worth it — versus
shipping top-1 straight-line-nearest for v1 and revisiting only if a real
river/obstacle case gets reported — is a real product decision, not a
technical one. I'd lean toward top-3-with-correction as the safer default
given this codebase already has one documented case (Birmingham Moor
Street↔New Street, 544m straight-line) explicitly flagged as "a plausible
candidate to check for exactly this," but it's Aaron's call on the cost
side.

A secondary, smaller question folds into this: should the UI ever surface
more than one candidate station to the user (e.g. "or start from Little
Bytham" when two stations are both plausible), or should the backend always
collapse to a single winner? Left open here since it's really a §3 UX
question, not a backend one — noting it so it isn't lost.

---

## 2. Distance/time bucketing for the affiliate banner

**Cycling estimate multiplier: 3.5×** walking speed. Reasoning: UK
transport-planning literature commonly cites cycling at roughly 3–4×
walking pace once real terrain (not flat, not always with dedicated
infrastructure) is accounted for — I'm picking the middle of that range
rather than the optimistic end, since a rural NaPTAN-adjacent walk to a
station is much more likely to be an unlit lane or a hill than a segregated
cycle path. **Flagging explicitly, since you asked to flag anything where
real UK terrain data might suggest otherwise**: this is a flat-pace
estimate with no elevation model — a village at the bottom of a valley with
its nearest station up a real climb (not uncommon in, say, the Pennines or
the Marches) will be meaningfully slower to cycle than 3.5× implies, and
Mapbox's own walking-duration estimate doesn't model gradient either, so
neither leg of this estimate corrects for it. Not fixable within the
"estimate from walking data, no second Directions call" constraint already
confirmed — just flagging it as a known source of error rather than letting
it pass silently.

**Proposed buckets**, based on real walking distance/duration returned by
Mapbox (path-following, not straight-line — an improvement over §1's
pre-filter stage even though it still doesn't model gradient):

| Bucket | Real walking distance | Walking time (~80m/min) | Behaviour |
|---|---|---|---|
| Walkable | ≤ ~2 km | ≤ ~25 min | No banner — walking is the default expectation |
| Cyclable | ~2–8 km | ~25 min–1h walk / up to ~14 min cycled at 3.5× | Soft note, not a hard affiliate push — walking is still viable for some users |
| Requires other transport | > ~8 km | — | Affiliate banner ("search coach/bus options") |

**Sanity-checked against real UK cases, per the instruction not to pick
round numbers in the abstract** — reasoned from known geography, since I
have no way to call live Mapbox Directions inside this investigation
(flagging that limitation directly rather than presenting these as
measured):

- **Hathersage (Peak District village centre) → Hathersage station**: the
  station sits at the edge of the village it serves, on the order of
  800m–1km on foot. Squarely **walkable** — exactly the common case this
  bucket needs to get right without over-triggering the banner.
- **Chipping Campden (Cotswolds market town, no station) → Honeybourne**:
  road distance on the order of 8km. This lands right on the walkable/
  cyclable boundary I've proposed — real cyclists do this route regularly,
  but it's genuinely the edge case that determines whether the boundary is
  in the right place. **This is the one figure in this section I'd most
  want spot-checked against live Mapbox output before shipping** — if the
  real walking-route distance comes back meaningfully different from the
  8km road-distance estimate (rivers/field boundaries can lengthen a
  footpath route relative to a road route, same class of problem as §1),
  the boundary should move with it.
- **Bishops Castle (Shropshire market town, no railway) → Craven Arms**: on
  the order of 13km. Clearly beyond comfortable cycling-with-luggage range
  — and notably, a real bus route already connects these two towns
  specifically for this gap, which is exactly the shape the affiliate
  banner is meant to surface, not invent.

None of these three are measured against a live Mapbox call — they're
reasoned from known geography as a sanity check on bucket placement, the
same way the task asked for, but the actual boundary (especially the 8km
one) should be re-verified against real Directions output once the
integration exists, not shipped on my geography alone.

---

## 3. UI integration point

Read `departures.html`'s Plan a Journey tab directly before proposing
anything, per the instruction. Current shape (`.plan-search-row`): origin
text input with station-only autocomplete (`#plan-origin-input` /
`#plan-origin-ac-list`), an identical destination field, a
`datetime-local` depart-after field, and a Search button. **There is no
free-text/address affordance anywhere in this row today** — both fields are
dedicated station search boxes ported from `map.html`'s own
`searchStations()`, filtered to CRS-bearing stations only (a station with
no CRS can't have a Darwin board, so departures.html's candidate pool is
narrower than map.html's on purpose, per CLAUDE.md's station-search-ranking
section).

**This is a genuine three-way UX decision, not something to pick silently —
flagging exactly as instructed:**

1. **Alternate input mode** — a toggle inside (or beside) the origin field
   that swaps it between "station" and "address/postcode" behaviour,
   keeping the same visual slot in the row.
2. **Fallback on zero station matches** — the existing station-input box
   stays exactly as-is; if what the user typed doesn't match any station in
   the current autocomplete, geocode it instead of showing an empty
   dropdown. Least new UI to build, most discoverable (nobody has to learn
   a new control — they type what they know and get *something* useful
   either way).
3. **A separate entry point entirely** — kept structurally apart from the
   core station-to-station flow (e.g. surfaced from `map.html`'s "my
   location" affordance instead, or a distinct "plan from an address" link
   elsewhere on the page).

**I'd lean toward (2)**, but it has a real, concrete tension worth naming
rather than glossing over: it makes station-name matching and postcode/
address matching compete inside the same input, and while a UK postcode has
a distinctive enough shape to detect reliably (regex-level, not "just try
both and see what returns"), a short free-text address fragment doesn't —
the failure mode is a query that matches nothing in the station list *and*
doesn't look like a postcode, which needs its own explicit "try geocoding
anyway" or "no matches" behaviour, not an assumption that one of the two
paths will always claim it. Also unresolved: the task describes this as an
input feature without saying whether it applies to the **origin** field
only, the **destination** field only, or both — (2) as a fallback would
most naturally apply symmetrically to both fields once built, but that's an
assumption on my part, not something stated in the brief. Confirm with
Aaron before building either the toggle or the fallback logic.

---

## 4. Backend integration shape

**`api/journey-search.mjs` is explicitly documented, in its own header
comment, as "Pure proxy... No logic, no reshaping: the request body goes
upstream unchanged, the upstream response comes back unchanged."** That's
not incidental — it's the file's stated contract, and it's the only Vercel
function this feature would naturally touch on the request path.

Combined with §1's finding (no Vercel function has direct Postgres access;
only `service.py` on the VPS does), this isn't really an open design
question so much as a fact that resolves it: **geocoding + nearest-station
resolution can't live as a new pre-flight Vercel endpoint that does the
full job**, because the nearest-station half of that job needs a DB
connection Vercel doesn't have. The only two real shapes are:

- Extend `service.py` itself with a new pre-step — accept an optional
  `origin_address` (or `destination_address`) field alongside the existing
  `origin`/`destination` station strings, geocode it via Mapbox, run the
  PostGIS nearest-station query (+ optional top-3 Directions correction per
  §1) *inside the same VPS request*, resolve to a tiploc, then fall through
  into the exact same CSA search path a station-name query already uses.
  `journey-search.mjs` needs zero changes — its "goes upstream unchanged"
  contract holds exactly as documented, since the new field is just more
  request-body content it already forwards blindly.
- Or: a separate Vercel pre-flight endpoint that does *only* the Mapbox
  geocoding call (stateless, no DB needed) and returns raw coordinates to
  the frontend, which then still has to get those coordinates to the VPS
  for the nearest-station half anyway — which just re-adds a network hop
  for no benefit, since the VPS ends up doing the DB-dependent half either
  way.

**The first option is the one that actually matches this codebase's
existing low-blast-radius pattern** (the footpath-relaxation work added a
new additive `"type"` field to leg JSON rather than restructuring anything;
`journey-search.mjs`'s whole design point is that Vercel never grows
station-to-station logic). Recommend that shape; flagging the second as a
real alternative I considered and ruled out, not an unconsidered option.

**One operational note worth surfacing here rather than leaving implicit**:
the VPS is the same shared box already documented (in
`walking-transfer-graph-phaseA.md`) as tight on headroom — 3.7GB RAM, no
swap, already running Postgres + journey-search + darwin-subscriber. A live
per-request Mapbox round trip (1 geocode + up to 3 directions calls per
§1) adds outbound-HTTP latency to every address-based search on top of the
CSA router's own dominant cost (~4.4s cold connection-graph build,
documented in `csa-router-caching.md`). Not a proven problem — just worth
instrumenting once live, since it's a new external dependency in the
critical path of a feature that's supposed to feel interactive.

---

## 5. Credential handling

**Confirmed pattern, checked directly against every existing integration**:
every external key in this codebase is read via `process.env.<NAME>` at
call time, never hardcoded, never committed —
`STADIA_API_KEY`/`RTT_API_KEY`/`DARWIN_LDBWS_KEY`/`DARWIN_SERVICE_KEY`/
`DARWIN_NEXT_DEPARTURES_KEY`/`KNOWLEDGEBASE_API_KEY`/`ANTHROPIC_API_KEY`/
`GOOGLE_MAPS_API_KEY`/`JOURNEY_SEARCH_KEY` all follow this shape, confirmed
against the actual `api/*.js`/`.mjs` source and the real key names present
in `.env`.

Mapbox should follow the same shape — but **"matching the existing
pattern" needs one precise correction, not a literal copy**, given §4's
finding: `DARWIN_LDBWS_KEY` etc. are Vercel project environment variables,
because the code that reads them runs in a Vercel function. The Mapbox
token, per §4's recommendation, is read inside `service.py` on the VPS —
so it belongs in that VPS's own env-file (the same deployment mechanism
`DATABASE_URL`/`JOURNEY_SEARCH_KEY` already use there), **not** in Vercel's
environment-variables panel. Same principle (env var, not hardcoded, not
committed), different deployment target. Worth being explicit about this
now so it isn't discovered as "why doesn't the key work" after being added
to the wrong project's env settings.

**Confirmed: `api/config.js` is the one place in this codebase that
deliberately relays a server-side key to the client** (`STADIA_API_KEY`,
because MapLibre needs it directly for tile requests from the browser).
Given the explicit instruction that Mapbox stays backend-only with no
Mapbox-branded UI, the Mapbox token should get **no equivalent treatment**
— nothing should add it to `/api/config`'s response or any other
client-facing payload. This is worth stating plainly since `config.js`'s
existing precedent could otherwise look like "the pattern" to follow for
any map-adjacent third-party key, when here it's specifically the wrong
one.

---

## 6. Cost/usage instrumentation

**No existing per-request usage counter for any external API in this
codebase** — checked directly; every `api/*.js`/`.mjs` file logs failures
(`console.error`) but none count successful calls. This would be new
infrastructure, not an extension of an existing mechanism.

**Live Mapbox pricing, fetched directly rather than assumed**: free tier is
**100,000 requests/month for the Temporary Geocoding API, and separately
100,000/month for the Directions API** — two independent 100k pools, not
one shared allowance. **Flagging a discrepancy rather than quietly
adopting the brief's number**: the task states "the ~120,000/month
threshold," which doesn't match what Mapbox's own pricing page currently
says. Worth clarifying with Aaron whether 120k referred to something else
(a blended/rounded estimate, a different account tier, a number from a
sales conversation not reflected on the public page) before instrumentation
gets built around a ceiling that may not be the real one — and worth
noting the two products don't share a pool, so "requests/month" needs to
specify which one if a single number is going to be tracked against.

**Proposed instrumentation, matching this codebase's existing lightweight-
persistence conventions rather than introducing new infrastructure**: since
§4 puts the actual Mapbox calls inside `service.py` on the VPS, and that
VPS already has Postgres sitting right there as the durable store for
everything else this service touches, a small table is the natural fit —
more durable than a file counter would be, given the caching report's own
finding that this router runs as fresh, ephemeral `docker run --rm`
containers per invocation (a file counter would need the same bind-mount
durability the per-date connection-graph cache already relies on; Postgres
sidesteps that by design):

```sql
-- PROPOSAL ONLY, matching walking-transfer-graph-phaseA.md's own
-- "proposed, not created" convention for schema sketches in this report
CREATE TABLE api_usage (
  provider text NOT NULL,
  product  text NOT NULL,     -- 'geocoding' | 'directions'
  month    date NOT NULL,     -- first-of-month, one row per provider+product+month
  calls    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, product, month)
);
```

One `UPDATE ... SET calls = calls + 1` per real Mapbox call, in the same
code path that makes the call — negligible load next to the CSA scan's own
per-search cost. Surface the running total in whatever log line already
exists per search (matching the `[perf]` line precedent already used in
`service.py`), so usage is visible without standing up a dashboard, and
treat crossing 80% of whichever confirmed threshold as the trigger to flag
Aaron directly. The actual alerting mechanism (log-watching, email, etc.)
isn't designed here — out of scope for an investigation-only pass.

---

## A precedent worth surfacing before this gets built

Not one of the six questions asked, but directly relevant to all of them:
**this codebase already has a working walking-time/directions integration
for the station-to-station case — `walking_transfers` (1,038 rows,
`walk_seconds`/`walk_meters`, `source = 'routes_api'`) — and it was built
against Google's Routes API, not Mapbox.** That's a different provider than
the one specified for this task, for what is structurally a very similar
problem (real-world walking distance between two points, one of which is
always a `naptan_stations` row). Not raising this to relitigate the Mapbox
choice — the task states it as a confirmed decision — but flagging it
because it means this feature will introduce a **second** live geocoding/
directions provider into a system that already has one wired up, with its
own separate key (`GOOGLE_MAPS_API_KEY`, already in `.env`) and its own
separate free-tier accounting. Worth being a deliberate choice (e.g.
temporary/cheap-tier evaluation of Mapbox specifically, per the brief) and
not an accidental one that emerges from not checking what's already there.

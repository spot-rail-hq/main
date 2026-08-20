# Real train-only journey planner — scoping report

Investigation only, no build. 2026-08-20.

---

## 1. Current routing graph — what it actually models

**Precise mechanism** (`scripts/build-routing-graph.mjs`, `scripts/build-graph-bridges.mjs`, `map.html` lines ~2543–2662, 7357+):

- The graph is built from `scripts/output/line-segments.json` (Phase 2 OSM-derived physical track segments, per-operator) + `station-graph-links.json` (Phase 3: each station snapped to a point on a segment). `build-routing-graph.mjs` slices segments at station attachment points into sub-edges and writes `data/routing-graph.json` — a flat adjacency list, `nodeId -> [{to, length_m, edge}]`, ~7,100 nodes / 8,669 edges.
- `map.html` fetches this file client-side and runs a hand-rolled binary-heap Dijkstra (`dijkstra()`, line 2584) directly in the browser. No server round-trip.
- Edge weight is **real physical track length in metres** (haversine sum along the OSM way geometry). That's it. Shortest path = shortest physical distance over connected track.
- `build-graph-bridges.mjs` patches OSM node-ID mismatches at station throats (places where track is physically continuous but two OSM ways don't share a node) using **operator/mode matching** — "does the track either side belong to the same mode (heavy rail vs. tram/metro)?" — plus a distance threshold (150m) and a manual waiver list for known real junctions the OSM extract never captured (e.g. Barking).

**Direct answer to your question: topology only, zero service-pattern awareness.** There is:
- No timetable, no trip, no stop-time, no calendar/day-of-week data anywhere in this graph or its build pipeline.
- No concept of transfer time, dwell time, or wait time at an interchange.
- No distinction between a station two trains both *call at* and a station two lines merely *pass through* or *cross* without stopping.

**"Interchange" = physical track co-location, not a scheduled connection.** A node in the graph is a place where segments (possibly from different operators/lines) share a coordinate — either a real OSM-shared node, or a station's snapped attachment point, or (for the ~40 bridged islands) a manually-verified nearby node pair. Nothing checks whether any real train timetable ever actually connects those two lines at that point. The graph would happily route a journey "via" a station where, in reality, the two services in question never overlap, run on different days, or have a 6-hour gap between them — as long as track is physically continuous and the mode matches. This is architecturally identical to routing a road trip by minimizing distance with no traffic-light or one-way-street awareness: correct about geography, silent about whether the maneuver is actually possible at the time you'd need it.

**Practical implication for a "real" journey planner:** this graph cannot be incrementally upgraded into a timetable-aware planner — it has nothing to layer service-pattern data onto (no trip/route concept, no way to say "these two edges are only walkable together if a train exists that traverses both within a compatible time window"). A real journey planner is a different data model and different algorithm class entirely (see §4), not an extension of Dijkstra-over-distance.

---

## 2. NROD SCHEDULE feed access — **could not be confirmed; no credentials exist in this session's reach**

**You asked me to confirm existing registered NROD credentials can pull the SCHEDULE feed. I can't — and this is a hard blocker on the premise, not a formality:**

- Grepped the entire repo, `.env`, and the persistent memory store: **zero footprint of NROD anywhere** — no `NROD_*` env var, no STOMP client code, no reference to `data.nrod.rail.co.uk` / `datafeeds.networkrail.co.uk` / `opendata.nationalrail.co.uk` in any file, script, doc, or memory record. `.env` has only `GOOGLE_MAPS_API_KEY` and the three Darwin LDBWS keys.
- I have no way to test authenticated access from this sandbox (no STOMP client, no ability to log into an NROD/RDM account) — this can only be confirmed by whoever actually holds the account, against the real credentials.

**If "existing registered NROD credentials" is real but lives outside this repo/session** (e.g. only in your head, or in a password manager, or on the target VPS — see §3), that's fine, but it means step 2 of this investigation is currently unverified fact, not verified fact. Treat everything below as documentation research, not confirmed access.

**From public documentation** (Open Rail Data Wiki, Rail Delivery Group pages):
- SCHEDULE is a static ITPS timetable extract, offered as **JSON** (recommended, newer) or **CIF** (legacy, more parsing work). Full-extract endpoint pattern: `CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full`; auth via login/HTTP basic, 302-redirects to a time-limited S3 URL.
- JSON full extract generated overnight, ready ~06:00; CIF ready ~01:00.
- Reported gzipped JSON full-extract size in the **~85–87MB** range, from specific historical runs — expect drift, don't treat as a current fixed number. **No reliable uncompressed figure found** — don't state one as fact until verified against a real pull.
- **STOMP confirmed as a genuinely separate product family** — it's real-time push for TRUST (actual train movement reports, after the fact) and TD (berth-level describer data). SCHEDULE itself is a periodic HTTP pull/download product, not STOMP-based. This separation is real and matters: **you do not need a persistent STOMP connection to keep a timetable current**, only for live running/delay data (which this planner doesn't need if it's timetable-only, not live-departures-aware).
- Daily-update file structure, strict-sequencing requirements, and the recovery procedure if one is missed: **could not find an explicit citation.** Plausible by pattern (full snapshot + sequential CIF/JSON diffs, re-pull full extract if a gap is detected) but unverified — don't build update-sequencing logic on an assumption here; confirm against the actual feed spec once real access exists.
- **Migration status is murky and worth resolving before committing to NROD as the integration target**: the National Rail Data Portal is slated for retirement "early 2026" in favour of Rail Data Marketplace (the same RDM family this repo's Darwin LDBWS keys already come from — see CLAUDE.md's Darwin section). An RDM product possibly named "NWR Working Timetable Data" may be SCHEDULE's new home, but its page is JS-rendered and couldn't be fetched to confirm. The original `datafeeds.networkrail.co.uk` NROD host still appears indexed/live but current registration status is unconfirmed. **Given this repo has already been through exactly this migration once for Darwin (Huxley2 → RTT → Darwin LDBWS on RDM, documented in CLAUDE.md), it would be a mistake to build against legacy NROD without first checking whether RDM already has the successor product** — that's a five-minute check against a real RDM account, not a research question.

**Bottom line for the build/no-build call:** the architecture assumption (periodic pull, no persistent connection needed) is solid. Everything else — credentials, exact file sizes, update mechanics, migration state — needs five minutes against a real account before this becomes a real plan rather than a documentation summary.

---

## 3. VPS / pipeline inventory — **no evidence this exists in any repo-visible form**

You asked me to report what's running on "the Hetzner VPS today (the 'Darwin subscriber' referenced in project notes)."

**I searched the repo (all `.md`/`.mjs`/`.js`/`.json` files), `.env`, and the full persistent memory store for `hetzner`, `vps`, `subscriber`, `ssh`, `deploy`, `docker`, `infra` — zero hits beyond one unrelated markdown filename match (`LINE-COLORING-RUNBOOK.md`).** There is no Dockerfile, no docker-compose, no systemd unit, no infra/ or deploy/ directory, nothing in CLAUDE.md, and no memory record anywhere describing a Hetzner VPS or a "Darwin subscriber" service.

What the repo and its memory *do* establish, clearly and repeatedly: **srhq.uk runs entirely on Vercel** — a static site with serverless functions in `api/`, auto-deploying from `main` (`project_srhq_site` memory, CLAUDE.md throughout). Darwin LDBWS is called directly from `api/darwin-departures.js` per-request, with no subscriber/caching layer in front of it. There is no persistent-process component anywhere in this project as it currently exists.

**I'm flagging this rather than guessing or fabricating an inventory**, per your own instruction elsewhere in this codebase's history to surface conflicts rather than paper over them. Possibilities, in rough likelihood order:
1. The VPS is real infrastructure that exists outside this repo's visibility (not IaC'd, not documented in memory) — plausible, but I have no way to inventory it without SSH access or you describing what's on it.
2. "Darwin subscriber" is a mental model or plan, not a thing that's been built yet — in which case this section of the investigation is really "what would a SCHEDULE-download-and-parse job need," not an audit of an existing service.
3. There's a naming mismatch and this refers to something documented under different words I haven't matched.

**This matters directly for §5** (shared architecture) and the build decision: a timetable-aware router needs *somewhere* to hold a parsed, periodically-refreshed timetable in memory and answer queries fast — that's fundamentally a persistent-process shape, not a Vercel serverless-function shape (cold starts would force re-parsing tens of MB of schedule data on every invocation, which is a non-starter). If a VPS genuinely exists and has spare capacity, it's the natural home for this. If it doesn't exist yet, standing one up (or equivalent — e.g. a long-running container elsewhere) is itself a real piece of scope this plan needs to account for, not an assumed-free resource.

**Recommend resolving this by direct answer rather than further investigation** — you know what you have running better than any file search can establish.

---

## 4. Pathfinding approach — CSA/RAPTOR vs GTFS+OTP/MOTIS

### Option A — custom rail-only CSA/RAPTOR against parsed SCHEDULE data

- **RAPTOR** (Delling/Pajor/Werneck, Microsoft Research — [ALENEX 2012 paper](https://www.microsoft.com/en-us/research/wp-content/uploads/2012/01/raptor_alenex.pdf), also [Transportation Science 2014](https://pubsonline.informs.org/doi/10.1287/trsc.2014.0534)): round-based, no preprocessing needed, naturally supports multi-criteria search (fastest / fewest changes) via Pareto fronts. Real JS implementations exist ([`planarnetwork/raptor`](https://github.com/planarnetwork/raptor)) — but as a server-side Node library consuming GTFS, not browser-based.
- **CSA** ([Dibbelt/Pajor/Strasser/Wagner, ISEA 2013](https://www.semanticscholar.org/paper/Connection-Scan-Algorithm-Dibbelt-Pajor/c6084d4aaa78540896b9ea869b389cf4199ab807)): simpler mental model — one array of all connections sorted by departure time, scanned once per query. Comfortably handles GB-rail-scale volumes (tens of thousands of daily movements).
- **Input shape**: CIF/JSON SCHEDULE records are already ordered calling-point lists with times — structurally closer to CSA/RAPTOR's native input than to GTFS's normalized trip/calendar/service-exception model. Building CSA/RAPTOR directly off parsed CIF/JSON plausibly needs *less* transform work than authoring valid GTFS as an intermediate step (GTFS conversion is its own hard problem — see Option B).
- **Client-side fit: no.** The existing Dijkstra-in-browser pattern works because the static graph is small (7,100 nodes) and never changes at request time. A live timetable's connection array is a different order of magnitude (hundreds of thousands of rows for a day's GB rail movements) — this needs a server-side resolver, not a client port of the current approach. This is a real architecture change, not just a bigger version of what exists.
- **Rough effort**: single-criterion earliest-arrival CSA, ~1–3 weeks. RAPTOR with Pareto multi-criteria, ~2–4 weeks. Both estimates assume the CIF/JSON→internal-timetable parser (interchange minimum-connection-times, associations/joins-and-splits, VSTP short-term changes) is solid — that parsing layer is nontrivial work regardless of which algorithm sits on top of it, and is probably the actual bulk of the effort either way.

### Option B — convert to GTFS, run OpenTripPlanner or MOTIS

- **Conversion prior art is thin but real**: [UK2GTFS](https://itsleeds.github.io/UK2GTFS/) (ITS Leeds, R) and [ATOCCIF2GTFS](https://github.com/thomasforth/ATOCCIF2GTFS) both convert ATOC/CIF→GTFS. ATOCCIF2GTFS even ships pre-built GTFS zips — but its own README says it isn't production-grade and points to paid providers (ITO World, TransportAPI) for reliably-updated feeds. So a ready-made feed exists but isn't authoritative for a product you'd monetize on; using it as-is means accepting staleness risk, or taking on maintaining the CIF→GTFS conversion yourself, which is real ongoing work.
- **OTP2** (Java): graph-build phase from GTFS+OSM must rerun on every timetable update — minutes to hours, several GB RAM at national scale — with the built graph persisted and reloaded at server start ([OTP2 docs](https://docs.opentripplanner.org/en/latest/Basic-Tutorial/); [known large-GTFS memory issue](https://github.com/opentripplanner/OpenTripPlanner/issues/2063)).
- **MOTIS** ([motis-project/motis](https://github.com/motis-project/motis), C++, TU Darmstadt): lighter than OTP, RAPTOR-based internally, but still has an import step (~30 min for a full multi-feed dataset per its own docs) plus a persistent process with disk state.
- **Neither fits the current hosting shape.** srhq.uk is a static Vercel site with stateless serverless functions today. Both OTP and MOTIS need a real persistent, stateful host — this is the same VPS-class requirement flagged in §3, not something Vercel serverless can absorb.
- **Effort is roughly comparable order-of-magnitude to Option A**, but shaped differently: less "implement an algorithm," more "operate a data pipeline plus a third-party server you don't control the internals of," with less ability to handle UK-specific quirks (interchange minimum connection times, footpath transfers) cleanly and more infrastructure to run continuously.

### Cross-cutting: is a rail-only custom router throwaway once bus/ferry (TNDS GTFS) gets added?

**No — not throwaway, if built with the right internal seam.** Both RAPTOR and CSA generalize to multi-modal cleanly by adding footpaths/transfers and a second source of routes/connections; this is literally how MOTIS/OTP merge multiple GTFS feeds into one graph today — the core scan logic doesn't change per data source. CSA is if anything the more composable of the two here: a second source is just more rows merged into the same time-sorted connection array.

**The risk is discipline in the data model, not the algorithm.** If the router's internal representation is normalized to a stops/routes/trips shape (i.e., GTFS-shaped internally) even while it's *sourced* from CIF/JSON rather than actual GTFS, then bolting on a TNDS bus/ferry GTFS feed later is additive — same engine, second data source. If CIF-specific concepts (TIPLOCs, headcodes, STP indicators) leak into the core routing/search logic instead of being fully resolved in a parser layer, that layer would need a rewrite when multi-modal arrives. This is a real, answerable design constraint to hold to from day one of Option A, not a hedge — build the parser to emit a mode-agnostic internal timetable, and the router underneath is genuinely reusable.

---

## 5. Shared-architecture feasibility

**Current state, confirmed by reading both files:**
- `map.html` (12,022 lines) owns the *entire* From/To pathfinding stack inline in one `<script>` block: the routing-graph fetch, the hand-rolled Dijkstra/MinHeap, `computeFromToPath()`, and the tile-geometry reconstruction (`resolveFromToGeometry` and friends). None of it is in a separate file.
- `departures.html` (1,904 lines) has **zero** reference to `routing-graph.json` or any journey-search concept — it only does single-station departure boards (`searchDepartureStations()`, RTT/Darwin fetch). It doesn't know journeys exist.
- Both pages already independently implement near-identical station-search logic (`searchStations()` in map.html, `searchDepartureStations()` in departures.html) — documented and deliberately reconciled in CLAUDE.md's "Station-search ranking" section, but never actually unified into one shared file. This is the existing precedent for "two pages duplicating the same logic because there's no shared module yet," and it's the same shape this journey-search question is asking about.

**What extracting a shared capability would take, concretely:**

1. **If staying client-side (i.e., you decide NOT to build a real timetable-aware engine, just keep the current topological Dijkstra)**: trivial — pull the routing-graph fetch + Dijkstra + `computeFromToPath()` out of map.html's inline script into a plain `/js/journey-search.js` loaded via `<script src="">` on both pages (no build step needed, fits CLAUDE.md's vanilla-JS-only rule exactly). A few hours of mechanical extraction, no architecture change. **But this doesn't get you a "real" planner** — it's still the same distance-only graph from §1, just shared rather than duplicated.

2. **If moving to a real timetable-aware engine (CSA/RAPTOR from §4)**: the natural shape is a new serverless endpoint, e.g. `api/journey-search.js`, calling into shared logic under `api/_lib/` — this repo already has exactly this pattern (`api/_lib/darwin-normalize.mjs`, shared by `api/darwin-departures.js`; CLAUDE.md documents the `.mjs`-extension-for-ESM-imports gotcha that bit this exact pattern once already). Both `departures.html` and `map.html` would `fetch('/api/journey-search?from=...&to=...')` the same way they already each independently `fetch()` their respective departure-board endpoints. This is architecturally clean and consistent with how this codebase already shares logic — **but it inherits the §3 problem**: a serverless function that has to parse/hold a timetable index needs either (a) a fast path to a pre-built, cached index it can load quickly per cold start, or (b) to call out to a persistent process (the VPS) that already holds the index in memory and just answers queries. Vercel serverless functions are not a good place to hold a large in-memory timetable across requests — this pushes the design toward "VPS holds the live parsed timetable and exposes a query API; Vercel's `api/journey-search.js` becomes a thin proxy to it," which is a reasonable shape but is a real architectural decision, not a detail.

**Net**: retiring map.html's current graph in favour of a shared real engine is straightforward to *wire up* (both pages already fetch-and-render from independent endpoints; adding one more shared endpoint is the established pattern here) — the actual complexity is entirely in §2–4 (getting a currently-timetable, and deciding where it lives and gets refreshed), not in the "shared vs. per-page" question itself. Once a real engine exists anywhere reachable via HTTP, making both pages call it is the easy 10% of this project, not the hard 90%.

---

## Summary for the build/no-build call

- **§1 is solid, verified fact**: current graph is pure physical topology, no service-pattern awareness at all, and isn't extensible into one — a real planner is new work, not an upgrade.
- **§2 and §3 are the actual blockers right now**, not the algorithm choice: NROD credentials aren't evidenced anywhere I can check, and there's no evidence of the Hetzner VPS/"Darwin subscriber" this plan seems to assume exists. Both need a direct answer from you before effort estimates in §4 mean anything, because §4's Option A and Option B both assume *some* persistent-process host exists to run against — that's not proven yet, either way.
- **§4**: CSA over parsed SCHEDULE data is the leaner path (roughly 1–4 weeks for the algorithm layer, comparable total effort to standing up OTP/MOTIS but with more control and no separate GTFS-conversion dependency) — and it's genuinely reusable for multi-modal later *if* the internal data model is kept mode-agnostic from the start.
- **§5**: not a blocker either way — sharing the eventual engine across both pages is cheap once the engine exists.

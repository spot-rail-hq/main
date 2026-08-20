# SpotRail HQ — srhq.uk

## Project overview
srhq.uk is a UK railway platform targeting three audiences simultaneously:
- **Explorers** (curious learners) — monetised via ads and editorial sponsorships
- **Trip Planners** (planning journeys ahead) — monetised via Trainline/Railcard affiliates
- **Active Travellers** (travelling today) — monetised via rebook affiliates at highest purchase intent

The map page is a full-screen interactive map inspired by OpenRailwayMap and Google Maps — no traditional page layout, everything floats over the map canvas.

## Design tokens — use these exactly, never substitute
```
Background:   #07090C
Surface:      #0E1218 (use at rgba(14,18,24,0.96) for floating panels)
Turquoise:    #40E0D0  (primary accent)
Magenta:      #F25CC1  (urgent/Live mode)
Amber:        #F5B84B  (delays/warnings)
Lime:         #B8F266  (heritage/positive)
Dimmed ink:   #9AA4B2  (secondary text)
Borders:      rgba(64,224,208,0.14) default · rgba(64,224,208,0.28) emphasis
```

## Typography
- Display: Archivo (headings)
- Body: Manrope
- Data/monospace: JetBrains Mono (times, codes)
- Fallback: var(--font-sans) from host

## Stack — STRICT rules
- Plain HTML + vanilla JS only. NO React, NO Vue, NO frameworks, NO Babel.
  - **ONE PRE-EXISTING EXCEPTION: `database.html`** (noted 2026-08-04). It
    loads React 18 + ReactDOM + `@babel/standalone` from unpkg (lines ~143–146)
    and its whole page body is JSX in a `<script type="text/babel">` block,
    including the shared `shared.jsx`. This predates the rule being written
    down; it was NOT introduced under it.
  - This is **recorded, not endorsed**. A vanilla-JS rewrite of `database.html`
    is tracked as separate future scope. Until that happens: do not copy this
    pattern to any other page, do not treat it as precedent for adding a
    framework anywhere else, and do not silently rewrite it either — a rewrite
    is its own reviewed task, not a side effect of editing the page.
  - Practical consequence: edits to `database.html` are edits to JSX, and there
    is no build step or JSX parser in this repo, so JSX syntax cannot be
    verified locally — it only fails in the browser. Change it in small steps
    and check it renders.
- No external JS beyond MapLibre GL JS and its dependencies.
- All API calls go through /api/ serverless functions (Vercel/Coolify), never expose keys client-side.
- CSS: use CSS custom properties. No Tailwind, no CSS-in-JS.
- Always add `font-family: inherit; font-size: inherit; box-sizing: border-box` resets on buttons and inputs — browsers do NOT inherit these by default and it causes button font size bugs.

## Map page architecture (map.html)
The map is FULL SCREEN — 100vw × 100vh, no page chrome.
Everything floats over the map as absolutely positioned panels.

### Floating header (top centre)
- Pill shape, rgba(14,18,24,0.96) background, blur backdrop
- Contains: logo · divider · Live tab · Database tab · divider · search icon · star icon · ← srhq.uk back link
- Live tab = magenta when active (#F25CC1)
- Database tab = turquoise when active (#40E0D0)
- All text 10px, icons 12–14px — NEVER larger

### Map library
- MapLibre GL JS (CDN: https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js)
- CSS: https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css
- Base tiles: Stadia Maps Alidade Smooth Dark
  - Style URL: https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json
  - Requires ?api_key= param from env var STADIA_API_KEY
- ORM overlay: OpenRailwayMap standard raster tiles at 55% opacity
  - URL template: https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png
  - Attribution required: © OpenRailwayMap contributors

### Live news panel (top left, floating)
- Width: 242px desktop, full-width bottom sheet on mobile
- Header row: news icon · "Live news" title · urgent badge (magenta) · pulse dot · timestamp · minimise chevron
- All text 10px throughout — filter chips, news items, meta, buttons ALL 10px
- Filter chips: 9px, pill shaped, scrollable row (overflow-x auto)
- News items: urgent first (magenta dot, rgba(242,92,193,0.05) bg, white title text), then chronological
- NO "running normally" items — only show disruptions and editorial news
- Departure board section appears ABOVE filters when a station is selected
- Saved routes section appears below news items
- Minimise button collapses panel body, chevron flips

### Departure board (inside news panel, shown on station tap)
- Triggered by clicking a station marker
- Shows next 4–5 departures: time (JetBrains Mono) | destination | platform | status badge
- Status badges: On time (turquoise), +N min (amber), Cancelled (magenta)
- Data source: GET /api/map-departures?crs=BHM — Realtime Trains (RTT) NG API
  (data.rtt.io) via RTT_API_KEY. Switched from Huxley2/Darwin 2026-07-09,
  after the public Huxley2 instance's Darwin backend became unreliable.
- Station name shown in header alongside "Departures" label

### Map controls (top right)
- Vertical stack: zoom in, zoom out, layers, my location
- 26×26px each, surface background, 6px radius

### Bottom hints (bottom left)
- Small floating pills: "Tap station" · "Tap route" · "Tap fleet"
- Hidden once user has tapped something

### Footer (bottom right, minimal)
- "© SpotRail HQ · Data: Network Rail, NRE" — 9px, pill
- "← Back to srhq.uk" link — 9px, pill

## Mobile layout (≤768px)
- Same full-screen map, same floating header pill
- News panel becomes BOTTOM SHEET pinned to bottom of screen
- Bottom sheet has two tabs: "Departures" and "Live news"
- Shows 3 news items visible at once, sheet is scrollable for more
- Minimise button collapses to just the tab bar
- Departure board tab appears when station is tapped — auto-switches to Departures tab

## Stations GeoJSON
File: /data/stations.geojson
Format: FeatureCollection, each feature:
```json
{
  "type": "Feature",
  "geometry": {"type": "Point", "coordinates": [lng, lat]},
  "properties": {"name": "Birmingham New Street", "crs": "BHM", "toc": "Avanti WC"}
}
```
Include top 50 UK stations to start. Markers: 8px circle, turquoise stroke, dark fill, glow on hover.

## Station regions (`data/station-regions.json`) — the admin-area-110 trap

Every station (current, `station-list.json`; and historical, `scripts/output/
historical-stations.geojson`) is assigned a canonical **NPTG region** —
London, North East, North West, Scotland, South East, South West, Wales,
West Midlands, Yorkshire, East Anglia, East Midlands — for use as a database-
page grouping facet. Generated by `scripts/build-station-regions.mjs`
(`--write` to persist; dry-run by default). **Read this before touching that
script or re-deriving region from NaPTAN/NPTG anywhere else** — the wrong
join looks like it works and silently produces garbage.

**The trap: a NaPTAN stop's OWN `AdministrativeAreaCode` is not real
geography for rail.** Every heavy-rail NaPTAN stop carries
`AdministrativeAreaCode 110`, which NPTG itself defines as `"National -
National Rail"`, filed under `RegionCode "GB"` (`"Great Britain"`) — a
pseudo-region alongside National Coach/Air/Ferry, not a place. Joining
region on a stop's own admin-area code flattens **every rail station** into
one meaningless bucket. Confirmed live (2026-08-16): 2,670 of 2,671 active
`RLY` stops carry exactly this code.

**The correct join is two steps, through the LOCALITY, not the stop:**

```
stop's own atco
  → NptgLocalityCode        (on the stop's own NaPTAN row — 100% populated)
  → that LOCALITY's own AdministrativeAreaCode
                             (nptg/localities.csv — NOT the stop's AdministrativeAreaCode)
  → Region                  (nptg's full XML gazetteer, Region → AdministrativeAreas)
```

The locality's admin-area code is a real, geographically-distributed value
(e.g. `082` = "Greater London") — nothing like the stop-level `110`. `GB` is
excluded from the usable region map entirely, so anything that would resolve
to it (nothing should, post-fix) falls through to the coordinate fallback
below instead of silently reporting "Great Britain".

**Three live DfT endpoints, same host as the NaPTAN CSV already used
elsewhere in this repo** (`naptan.api.dft.gov.uk`) — no static download,
cached to `os.tmpdir()` like the existing NaPTAN fetch, never the repo:
- `/v1/access-nodes?dataFormat=csv` — the same 97 MB bulk file, read here for
  `NptgLocalityCode` (which `scripts/output/naptan-stops.json`'s narrower
  extract never captured — this script reads the raw CSV itself).
- `/v1/nptg/localities` — CSV, ~44k localities, each with its own real
  `AdministrativeAreaCode`.
- `/v1/nptg` — full gazetteer XML, `Region → AdministrativeAreas`.

**Region names are NPTG's own** ("Yorkshire", "East Anglia"), not remapped
to the more familiar ONS Government Office Region names ("Yorkshire and The
Humber", "East of England") — a deliberate decision, not an oversight, so
don't "fix" the naming later without revisiting that call. `region` values
throughout the file are always the NPTG region **code** (`L`, `NE`, `Y`, …);
`regions` at the top of the file is the one place code → display name lives.

**Fallback, for anything the two-step join can't reach** (nearest
already-resolved reference station by coordinate, equirectangular approx —
fine at GB's extent): the primary case is the 8,884 historical stations,
which mostly predate NaPTAN's ~2005 rollout and have no atco at all.
Confirmed live: 100% resolve, 71.8% within 5km of their reference, only 54
(0.6%) beyond `FLAG_DISTANCE_KM` (30km) — `flagged: true` on those marks them
for spot-checking, not "known wrong". Every fallback entry carries
`distance_km` to the reference it borrowed from, so confidence is
inspectable rather than asserted.

**7 current stations are keyed `crs:<CODE>` instead of by atco** — the file
is atco-keyed for 3,436 of 3,443 entries, but Bond Street, Barking
Riverside, Custom House, Canary Wharf, Tottenham Court Road, Woolwich and
Southampton Town Quay all carry `atco: null` on their own `station-list.json`
row (investigated 2026-08-16): six are real London stations that NaPTAN
genuinely files under their Underground/DLR/Elizabeth-line identity instead
of a separate `RLY` record — see `migrate-station-list.mjs`'s own header,
"A clean regenerate ... would be WRONG" — and two of those six (Bond Street,
Custom House) resolve via a curated `interchange` atco instead, which is
safe (a curated same-station identity) where raw proximity-matching to the
nearest different stop is NOT (that was tested and rejected during the
original `station-list.json` migration — Canary Wharf's nearest MET stop is
a *different* station, West India Quay DLR, 149m away). The seventh,
Southampton Town Quay, is structurally different: it's a National
Rail-ticketed replacement BUS stop (the QuayConnect shuttle to the Red
Funnel ferry terminal), not rail infrastructure at all, so it was never
going to have an `RLY` NaPTAN record — `atco: null` is permanent and correct
for it, not a gap.

**Tagged distinctly in `station-list.json` (2026-08-16) so it doesn't render
as a normal station once a Stations tab exists**: `mode: "bus"` /
`network: "National Rail (replacement bus)"`, instead of every other row's
`mode: "rail"` / `network: "National Rail"`. `migrate-station-list.mjs`
otherwise hardcodes both fields for every pre-existing row on each run
(it does not read-merge-preserve its own prior output — nothing else in
this file is hand-curated, so it never needed to), which would silently
overwrite this on a future re-run; the override lives in that script's own
`MODE_OVERRIDES` constant (same pattern as its existing `SAME_STATION`/
`CLOSED_CRS` maps) specifically so it survives one. Confirmed safe against
the current map.html: every `mode`/`network`-sensitive code path there
(`MODE_STATION_TIER`, `MODE_LABELS`, `nonCrsLiveNoticeHtml`,
`nonCrsDatabaseHtml`) is gated on stations with **no** `crs` — Southampton
Town Quay has a real one (`STQ`), so none of them touch it; the override is
inert metadata until a Stations tab (or something else) chooses to read it.
**When the Stations tab is built**: don't render this row like a normal
station (no departure-board expectation, no "station" copy) — surface it as
a ferry-connection bus stop, or exclude it, per whatever the Stations tab's
own scoping decides; this note exists so that decision doesn't have to
re-derive the "it's not actually a station" fact from scratch.

**Read-merge-preserve applies** (`GENERATOR_OWNED_KEYS` = `region`,
`method`, `distance_km`, `flagged`) — any other field hand-added to an entry
survives a re-run.

## Live news / incidents data
- Source: GET /api/incidents (polls every 60s)
- /api/incidents fetches from the Rail Data Marketplace (RDM) Knowledgebase
  Incidents XML feed (RSPS5050 §10, schema v5.0)
- Requires KNOWLEDGEBASE_API_KEY env var
- Returns: [{id, summary, region, toc, severity, timestamp, affectedCRS:[]}]
- Urgent = severity >= 2
- News items from existing api/news.js RSS aggregator — key-less (public RSS
  feeds, no auth)

## /api/ keys, by function (corrected against the code 2026-08-31)
- api/departures.js (?station=, departures.html) and api/map-departures.js
  (?crs=, map.html's departure board — see that section above): Realtime
  Trains (RTT) NG API (data.rtt.io) via RTT_API_KEY. Switched from
  Huxley2/Darwin 2026-07-09, after the public Huxley2 instance's Darwin
  backend became unreliable.
- api/incidents.js: KNOWLEDGEBASE_API_KEY (see above).
- api/spotlight.js: ANTHROPIC_API_KEY.
- api/news.js: key-less (public RSS feeds).
- api/config.js: key-less itself — it only relays the already-documented
  STADIA_API_KEY to the client (see the map page's tile section above), it
  does not require a secret of its own.
- **Planned**: the departures page is moving to Darwin LDBWS REST on Rail
  Data Marketplace — the modern REST/JSON endpoint, not the retired SOAP
  OpenLDBWS. RTT's free tier is non-commercial; it must be retired before
  any monetisation.

## Darwin LDBWS REST — verified constraints (confirmed live 2026-08-19)

Three separate Rail Data Marketplace products, three separate `x-apikey`
keys — **not interchangeable**, confirmed symmetrically (each key gets a
`401 {"fault":{"faultstring":"Invalid ApiKey for given resource", ...
"oauth.v2.InvalidApiKeyForGivenResource"}}` against either other product).

| Product (as named on RDM) | Base URL (incl. slug) | API version | Operation | Key env var |
|---|---|---|---|---|
| Live Departure Board | `https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails` | `20220120` | `GetDepBoardWithDetails` | `DARWIN_LDBWS_KEY` |
| Service Details | `https://api1.raildata.org.uk/1010-service-details1_2/LDBWS/api/20220120/GetServiceDetails` | `20220120` | `GetServiceDetails` | `DARWIN_SERVICE_KEY` |
| Live Next Departures Board | `https://api1.raildata.org.uk/1010-live-next-departure-board1_1/LDBWS/api/20220120/GetNextDepartures` | `20220120` | `GetNextDepartures` | `DARWIN_NEXT_DEPARTURES_KEY` |

**Sourcing note, since only one of these three is actually wired into code
today**: the Live Departure Board row is verified straight from
`api/darwin-departures.js`'s `BOARD_URL_BASE` constant — the only one of the
three this repo actually calls. The other two rows are **not** implemented
in any file; they're transcribed verbatim from the exact URLs given directly
in chat during the verification passes (Service Details: the original task
spec; Next Departures Board: a later correction after an initial guess was
wrong — see the "5 real guesses, all clean 404s" investigation), not
reconstructed from memory. If either is ever wired into code, that
constant becomes the source of truth over this table.

Same API date-version segment (`20220120`) across all three despite
different product-slug version suffixes (`1_2`, `1_2`, `1_1`) — the slug
version and the API date-version are two independent things that happen to
mostly agree here, not one number.

**Assumption, not established fact — check this when the subscription is
renewed**: the three base URLs/slugs above are expected to survive a
resubscription unchanged (a slug identifies the product, not a specific
purchase), but the three keys almost certainly will not — a new
subscription typically issues fresh credentials. This has never actually
been tested against a real renewal; it's inferred from how the RDM portal
behaved during initial subscription, not confirmed. Don't assume a renewed
key can just be dropped into `.env` under the same slug without checking
the URLs still resolve.

- **`numRows` hard ceiling is 25** on GetDepBoardWithDetails, regardless of
  what's requested — confirmed identically at a quiet station (BHM) and one
  of the busiest London termini (LST), both capped at exactly 25 even when
  asked for 150.
- **`timeOffset` valid range is -120 to 119 minutes inclusive** — 120 itself
  is rejected: `400 {"Message":"Requested time range (120,240) falls
  outside permitted time range (-120,False)"}` (the literal `False` is
  Darwin's own error text, not a placeholder introduced here).
  `timeWindow` isn't independently range-validated (no error up to 10000
  observed) but doesn't extend reach past what `numRows`/service density
  already caps — paging further ahead means advancing `timeOffset`, not
  raising `timeWindow`.
- **GetServiceDetails errors are two distinct, real modes, not one:**
  - Stale-but-well-formed serviceID → `500 {"Message":"Unable to retrieve
    the requested data"}` (reproduced twice on different hours-old IDs).
  - Malformed serviceID (wrong format entirely) → `400 {"Message":"Invalid
    Service ID"}`.
  - Fresh serviceID → `200`, full shape in
    `fixtures/darwin-departures/service-details-fresh.json`: has both
    `previousCallingPoints` (new — the board never has this) and
    `subsequentCallingPoints`, plus `sta`/`eta` (arrival at the queried
    station, which the board never exposes at all) alongside `std`/`etd`.
    Has no `formation`/coach data and no `origin`/`destination` fields at
    all — both present on the board, absent here.
- **`fixtures/darwin-departures/normalized/` is a derived artifact, not
  hand-curated.** It's the output of running the real `normalizeBoard()`
  (`api/_lib/darwin-normalize.mjs`) over the raw fixtures via
  `node scripts/build-darwin-fixture-previews.mjs` — departures.html's
  `?fixture=<name>` preview mode (localhost-only) reads these pre-normalised
  files directly rather than duplicating normaliser logic into the browser.
  **Any change to `normalizeBoard()`/`resolveStatus()`/etc. must be followed
  by re-running that script**, or the files under `normalized/` silently
  drift out of sync with what the real normaliser now produces — the
  fixture preview would then be showing a shape the live site can no longer
  actually generate, with nothing flagging the mismatch.
- **`api/` files are bundled as CommonJS unless `package.json` sets
  `"type": "module"`** — which this project deliberately does not (adding
  it project-wide would put every existing `.js` function at risk of the
  same failure, for the sake of the handful that actually need ESM).
  **Any new function that imports an ESM module must use the `.mjs`
  extension itself**, or Vercel's build bundles it to CommonJS and the
  bundle's own `require()` of a real ESM module throws
  `ERR_REQUIRE_ESM` — this exact bug shipped once already (`api/darwin-
  departures.js` importing `api/_lib/darwin-normalize.mjs`), because
  **`vercel dev` does not reproduce this bundling path** — it ran the
  broken `.js` file locally without complaint, and only production 500'd.
  Don't trust a clean `vercel dev` run alone as proof a new `api/`
  function importing an `.mjs` module is safe.
  Separately: **`vercel dev` builds its routing table at startup**, so
  after renaming any file under `api/` (extension change included), the
  running dev server 404s on the old route until it's restarted — a
  restart is required to verify the rename actually resolved correctly,
  not just a nicety.

## SCHEDULE ↔ Darwin join — three permanent coverage gaps (findings only)

Not implemented anywhere yet — this is a finding from investigating a real
CSA journey router built against the SCHEDULE backfill (a VPS-side Postgres
project, not this repo; see `scratchpad/darwin-schedule-join-investigation.md`
and `scratchpad/csa-router.py` for the full detail). Recorded here because
it's a durable fact about the data, not scoped to that one build.

`darwin_movements` (real-time Push Port data) carries no train UID,
headcode, TOC, or date field at all — the only reliable join to a SCHEDULE
record is `resolve_schedule(train_uid, date)` (STP-resolved) followed by a
match on tiploc + scheduled time, never a direct key. Three categories of
"no live Darwin match" are permanent and expected, not a join bug or a data
quality problem:

- **Non-GB-network services present in the SCHEDULE feed.** Some entries
  carry a mainline ATOC tag but describe journeys entirely outside Great
  Britain's Darwin-covered network — confirmed real examples: the Isle of
  Man Steam Railway (tagged `VT`) and a Holyhead→Dublin ferry-port boat
  train (tagged `AW`). These will never have a `darwin_movements`
  counterpart, regardless of join correctness.
- **VSTP-created same-day services.** The SCHEDULE backfill only ingests
  the full weekly CIF extract, not the separate, more-frequent VSTP feed.
  A same-day schedule amendment/addition made via VSTP has no SCHEDULE-side
  counterpart at all (confirmed real example: a Weybridge 08:41 departure
  recorded in `darwin_movements` with no matching calling point anywhere in
  the ingested SCHEDULE data).
- **Non-passenger workings.** ~24% of schedules with an origin calling
  point have no public time at all (ECS/freight/departmental/bus-
  replacement categories) and structurally can't appear in Darwin, which
  only ever carries public-facing running information.

## Station-search ranking (departures.html and map.html)

**Reconciled 2026-08-19** — both files now run the same four-tier model in
`searchStations()`/`searchDepartureStations()`: CRS-prefix match, name-
starts-with, word-boundary match (query starts some word within the name,
delimited by space/hyphen/parenthesis/slash/ampersand), true mid-word
substring, with major-station-then-length as the tiebreak within each tier
— both reading the same curated set from `data/stations.geojson`, no second
source of truth. Confirmed via the real "bir" case that motivated the fix:
"Birmingham New Street" now ranks first on both, not buried behind
"Birkdale"/"Birkbeck" as it was under the old pure-length tiebreak.

**Two things genuinely still differ, deliberately, not by oversight:**
- **Candidate pool.** departures.html's search is CRS-only (a station with
  no CRS can't have a Darwin board at all, so it's filtered out before
  ranking). map.html's plain station search runs over the full list
  (Underground/DLR/tram/etc included) — correct for the map, those are real
  features on it, and left unchanged.
- **Cap.** departures.html raised its dropdown cap to 10. map.html's stays
  at 7 — **not raised**, left as an open decision rather than assumed: its
  `.sb-ac-list` has a fixed 220px `max-height` shared by both desktop and
  the mobile bottom sheet, and even the existing cap of 7 already exceeds
  that (rows are ~36px, so ~6 fit before scrolling) — raising it doesn't
  break anything (`overflow-y: auto` already handles it) but does mean more
  scrolling in the already-tightest case. Traced and reported, not decided
  silently.

## Saved routes (localStorage)
- Key: srhq_saved_routes
- Value: JSON array of {name, crs, toc, line, addedAt}
- Render in saved section with live status dot colour-coded from incidents
- Add button opens a simple text input → saves on Enter

## Database mode
- Hides departure board
- Shows map with ORM infrastructure overlay at full opacity
- History slider appears below legend at bottom
- History data: OpenHistoricalMap vector tiles, year filter on slider drag
- Slider snap-points: **1825, 1845, 1889, 1923, 1963, 1994, {current year}** — the
  authoritative list is `historySnapYears()` in map.html; `scripts/scope-ohm-coverage.mjs`
  keeps a copy for its coverage report only. Corrected 2026-08-04: this line
  previously read "1845, 1880, 1923, 1965, 1994, 2025", which was wrong in four
  ways — it omitted 1825, said 1965 where the code says 1963, hardcoded 2025
  where the last stop is resolved at runtime, and listed 1880, which became
  **1889** on 2026-08-04 (1880 was a "network mature" waypoint with no event
  attached; 1889 is the Regulation of Railways Act). 1845 is a snap point but
  its LABEL is suppressed (`HIDDEN_TICK_LABEL_YEARS`), so six labels render.
- Snap-points are **not** era-band boundaries. `eraBandForYear()` splits on
  1923/1948/1994 independently, so moving a snap point never changes paint.

## Legend bar (Database mode only, bottom of screen)
> **⚠️ PARTLY OUT OF DATE — do not read the colours below as current fact.**
> "Metro/LRT (purple)" no longer describes what renders: the non-CRS marker
> purple was reverted to the turquoise CRS accent (2026-08-02), and "Heritage
> (amber)" became coral in 2026-07-27. Flagged rather than rewritten — a full
> CLAUDE.md accuracy pass is its own task. The authoritative colour table is
> `data/operator-colors.json`.
- National Rail (turquoise) · Metro/LRT (purple) · Heritage (amber) · Closed (dashed)
- History button right-aligned → expands year slider above legend

## Operator line colors
The map's rail-line rendering colors each physical track segment by which
train operator(s) run over it (citylines.co-style — parallel offset lines
where track is shared), extending this legend's category structure rather
than replacing it. The actual hex table lives in `data/operator-colors.json`
(dark + light per canonical operator/category) — this section is the rules,
not the values, so other parts of the site can reference operator colors
consistently without duplicating the table.
- **Categories**: `toc` (real train operating companies — one bold, mutually
  distinguishable hue each) · `metro` (light rail/tram/subway systems —
  purple family, kept visually distinct from TOCs so the category reads at
  a glance, matching the legend's "Metro/LRT (purple)") · `heritage`
  (preserved lines — one shared warm coral/salmon, and the only category
  rendered with a DOTTED line pattern; never dashed, which the legend
  already uses for Closed. Was an amber family until 2026-07-27, changed
  because it collided with West Midlands Railway — see the hand-set note
  below) ·
  `tfl_lines` (London Underground's 11 lines + the 6 real 2024-renamed
  London Overground lines, each with its own real official color —
  route-name-based line-splitting is confirmed working, see the pipeline
  note below; DLR and Elizabeth line are separately tagged in OSM and
  already live in the `metro`/`toc` categories respectively, not here).
- **Never uses `--t` (turquoise)** for any operator/category color — reserved
  exclusively for UI meaning (links, the From/To selected-path highlight).
- **Two entries are HAND-SET and bypass the generator's placement search, so
  regenerating the palette will NOT re-verify them.**
  `scripts/build-operator-palette.mjs` normally derives each color through
  `toVividLightTheme()` (light) and `toDarkThemeFromLight()` (dark), then
  clears it against every already-placed color via `passesGates()`. These two
  skip that:
  - **Blackpool Tramway** — a hand-verified constant pair that IS still run
    through `passesGates()`, and throws if it ever stops clearing.
  - **Heritage** — a hand-set constant pair that has **never** been through
    `passesGates()` at all, before or after the 2026-07-27 coral change,
    because heritage was never part of the placement search. Nothing in the
    build will catch it if a future TOC placement lands on top of it.
    It is hand-set because the derivation *cannot express the color*:
    `toVividLightTheme()` forces saturation ≥ 72 and lightness into 38–54,
    and `toDarkThemeFromLight()` lifts from there — every seed hue in the
    coral range comes out of that pair as a vivid red (`#C52115`/`#EF3F32`),
    which both misses the intended color and measures *worse* than the amber
    it replaced (worst-case CVD separation 3.2). Loosening those clamps is
    not an option: they are what keeps the ~60 generated colors mutually
    consistent.
  - **Therefore: any palette regeneration must re-check heritage by hand** —
    measure `data/operator-colors.json`'s `heritage` value against every
    `toc`/`metro`/`tfl_lines` entry in both themes, under normal vision and
    under protanopia and deuteranopia simulation. The figures the current
    value was accepted on are recorded in that file's `heritage._note`;
    compare against those rather than against the bare 15 ΔE threshold, since
    this palette is dense enough that plenty of pairs sit below it.

### Heritage railways with no map presence — 14 of 175

Not every heritage railway can be drawn. **14 have no map presence**, and it is
**two disjoint causes**, not one — which is why a single "missing" count is the
wrong shape for it:

| flag | count | what it means |
|---|---|---|
| `no_line` | 8 | `km` is 0. The extraction found a name but no measurable track, so **no line is ever drawn** — but the entry HAS a `center`, so it can still be located. |
| `needs_coordinates` / `not_in_graph` | 8 | Not in the segment graph at all. **No `center`**, so there is nowhere even to fly to. |

Only **2 railways carry both** flags, so the union is 14, not 16.

**Counted from `data/heritage-railways.json` (175 entries) on 2026-08-03 — go
back to that file rather than quoting these numbers as fixed trivia.** They move
whenever the heritage extraction is re-run, and older comments in `map.html`
claimed 12 and 9 for these same two sets, both wrong by the time they were read.
Re-derive with:

```
node -e "const d=Object.entries(require('./data/heritage-railways.json')).filter(([k])=>k!=='_notes');
console.log('no_line', d.filter(([,v])=>v.no_line).length,
            'no center', d.filter(([,v])=>!v.center).length,
            'union', d.filter(([,v])=>v.no_line||!v.center).length)"
```

`map.html`'s `heritageHasNoMapPresence()` folds both causes into one user-facing
state (the panel and the search dropdown both say so in words), because the
user-visible consequence is identical: nothing to look at. The two are still
worded differently in the panel — "can't be shown or located" vs "no mapped
track" — since only one of them has a known location.

- Canonicalization (which raw OSM operator/brand tag maps to which
  category/color) is a *separate, broader* mapping than
  operators-content.json's own `aliases` — that field is scoped to station-
  data provenance precision, so it deliberately leaves things like
  `legal_entity`/`welsh_name` strings unfolded; a line-color map needs one
  consistent color per real service regardless of which legal/bilingual
  name a given relation happens to carry. See
  `scripts/build-operator-inventory.mjs` for the full mapping and its
  reasoning, including the "Greater Thameslink Railway" finding (most of
  that network is now tagged at the parent-company level in OSM, not by
  individual sub-brand — Southern/Thameslink/Great Northern/Gatwick Express
  share one color pending a route-name-based way to split them back out).
- This category/color table is one piece of a larger pipeline — the
  physical SEGMENT GRAPH (which track belongs to which operator(s), used
  for the actual line rendering, not just the color lookup) and the
  per-station graph-snapping both live in their own build scripts and
  outputs, documented end to end in **`LINE-COLORING-RUNBOOK.md`**
  (mirrors `PROMPT3-TILES-RUNBOOK.md`'s structure — read that file for the
  full rebuild sequence, current stats, and the open hosting/format
  decision for the segment graph's output, not repeated here). The stage
  table below is the short version.

### Heritage `established_year` — tranche-3 prep note

`heritage-content.json`'s `established_year` (+ `established_year_type`,
`opened_year`, `heritage_reopened_year`, `_established_year`) is populated in
hand-run batches — a pilot (20 railways) and two 30-railway tranches, merged
via one-off scripts (`merge-pilot.mjs`, `merge-tranche.mjs`,
`merge-tranche2.mjs`) that live in session scratch space, not this repo.
Current state (confirmed 2026-08-14): all 80 railways across the three
batches were genuinely researched and are protected by the read-merge-preserve
guard on `build-heritage-content.mjs`; of those, 63 have a published
`established_year` and 17 are correctly, deliberately blank (weak/ambiguous
sourcing, or a real "revival in progress" case where publishing the original
opening date would misrepresent an in-development project as an operating
heritage railway). 63 is the true, complete baseline for these 80 — not a
partial/lost 80, see the investigation this note came out of for the full
reconciliation if the 63-vs-80 question ever resurfaces.

**Known bug, unfixed, in `merge-tranche2.mjs`'s loop logic — read before
reusing this script for tranche 3.** North Dorset Railway's own tranche-2
entry documents (via its `flag` field) a real, confirmed 1863 opening date
that should NOT be published as `established_year`, because the line is a
revival-in-progress (permission to run trains was only granted September
2025, no confirmed public passenger service yet) — the same "don't publish
the original date" shape as Halesworth to Southwold in tranche 1. Tranche 1's
merge script (`merge-tranche.mjs`) has an explicit per-slug blank override for
its equivalent case (`if (slug === 'halesworth-to-southwold-narrow-gauge-railway-cio')
{ blanked++; } else { ... }`). **`merge-tranche2.mjs` has no equivalent
override for North Dorset Railway** — its loop would auto-publish 1863 as
`established_year` if run as saved. The live file is correct today only
because this was caught by hand (checking all 30 entries individually rather
than trusting the script's own summary count) and hand-patched directly into
`heritage-content.json` after the buggy run — the script itself was never
fixed. Anyone extending or reusing `merge-tranche2.mjs`'s pattern for
tranche 3 needs to add that blank-override branch (or an equivalent explicit
check) to the loop first, or the bug reintroduces itself silently on the next
run.

## Line-data pipeline stages — and which figures each one may be quoted for

Every stage rewrites or derives from `scripts/output/line-segments.json`, and
several of them produce *different values for the same statistic*. Both values
look plausible. Only one is right for a given question.

**RULE: any segment count, track-kilometre figure or lane statistic must name
the stage it came from.** A bare "5,371 segments" or "span 7.0" is not a
finding, it is half a finding, and the missing half has already cost this
project one investigation into a bug that did not exist.

| # | Command | Reads | Writes | Figures VALID to quote from this stage |
|---|---|---|---|---|
| 1 | `node scripts/build-operator-inventory.mjs` | Overpass | `operator-inventory.json` | raw OSM operator/brand strings, relation counts |
| 2 | `node scripts/build-operator-palette.mjs` | inventory | `data/operator-colors.json` | per-operator colours, CVD separation figures |
| 3 | `node scripts/build-line-segments.mjs` (bbox checkpoint first, then `LINE_SEGMENTS_NATIONAL=1`) | Overpass | `line-segments.json` **(pre-dedupe)** | way counts, relation counts, rejected-way and UNMAPPED-HERITAGE reports, geometry-integrity result |
| 4 | `node scripts/dedupe-line-segments.mjs` | `line-segments.json` | `line-segments.json` **(post-dedupe, IN PLACE)** | **all segment counts, all km totals, all lane statistics** |
| 5 | `bash tile-generation/build-operator-tiles.sh` | `line-segments.json` | `operators.geojson`, `operators.pmtiles` | feature counts, lane span/collisions/jogs, tileset size, tilestats |
| 6 | `node scripts/build-station-graph-links.mjs` | `line-segments.json` | `station-graph-links.json` | station snap counts |
| 7 | `node scripts/build-routing-graph.mjs` | segments + links + bridges | `data/routing-graph.json` | node/edge counts, component counts |
| 8 | `node scripts/build-graph-bridges.mjs` | **`routing-graph.json`** + segments + links | `graph-bridges.json` | bridge and island counts |
| 9 | `node scripts/build-routing-graph.mjs` again | as above | `data/routing-graph.json` | final `bridge_edges`, final reachability |

Stages 1–5 need a local Overpass instance (see the OSM runbook) only at
stage 3. Stages 6–9 rerun together after ANY segment-graph change.

**Stage 4 is not optional and is easy to skip.** `build-operator-tiles.sh`
does NOT run it — it goes straight from `line-segments.json` to the GeoJSON.
Run the tile script directly after stage 3 and you tile the pre-dedupe graph,
which is a real, shippable, wrong tileset that nothing downstream complains
about.

**Stage 4 has a narrow, currently-dormant read-merge-preserve gap** (audited
2026-08-17, alongside the `build-operator-palette.mjs` gap fixed the same
day — see that section below for the general pattern). When a merge group
has more than one member, `dedupe-line-segments.mjs` keeps the CANONICAL
member's own fields (`{...canonical.seg, operators, way_ids}` — safe, this
preserves whatever hand-curated content the canonical segment carries) but
the OTHER, non-canonical members in that group are dropped along with
everything they carried beyond `operators`/`way_ids`. Not fixed here —
**documenting, not fixing**, per the same call as the audit that found it.

Dormant today: Knottingley's hand-curated `attribution_note` (see the
Corrections-layer section below) sits on a segment whose `way_ids` are all
under this stage's dedup floor, so it never enters a merge group at all. But
there is no protection if a future hand-curated segment ever loses the
canonical vote to another segment describing the same physical corridor —
its curated field(s) would be silently dropped, the same failure shape
`migrate-station-list.mjs` and `build-operator-palette.mjs` both had before
their fixes. If this is ever hit for real, the fix is the same shape as
those two: read-merge-preserve the non-canonical members' non-generator-
owned fields into the canonical survivor before dropping them, rather than
just discarding the loser wholesale.

**Stages 6–9 are a CYCLE, not a line.** `build-graph-bridges.mjs` reads
`routing-graph.json`, which `build-routing-graph.mjs` writes — so the bridges
script scores candidates against whatever node space the *last* routing build
left behind. Run it once against a stale routing graph and it emits bridges
whose endpoint nodes no longer exist; the next routing build then logs
`SKIP bridge for <CRS>: endpoint not present` and silently drops them. Run
routing → bridges → routing, and confirm `bridge_edges` in the final log
equals the bridge count in `graph-bridges.json`. It converges on the second
pass (verified 2026-07-29 — a third pass changed nothing).

### The two traps this table exists to prevent

**1. Cross-stage segment/km comparison.** Committed copies of
`line-segments.json` are POST-dedupe (stage 4). A freshly built one, before
you run dedupe, is PRE-dedupe (stage 3). Comparing the two measures the dedupe
step, not your change:

> Comparing the new pre-dedupe graph against the committed post-dedupe
> `old-graph.json` showed non-heritage track jumping 21,485 → 28,285 km on an
> identical way set. That +6,800 km was read as mass geometry truncation in the
> old file and triggered a full investigation. It was dedupe. Like-for-like
> (post vs post) the real change was 21,485 → 21,499 km, **+0.07%**.

So: **28,285 km is the pre-dedupe national total and never ships. 21,499 km is
what reaches the tileset.** Same graph, both correct, different stages.

**2. Lane span read at the wrong stage.** The lane offset span is **6.000
pre-dedupe and 7.000 post-dedupe** — dedupe removes the parallel duplicate
corridors that were compressing the fan. `LANE_FAN_ZOOM_STOPS` in `map.html`
is derived as `5/7 ×` a 5.0-unit baseline and is paired to the post-dedupe
7.000. Reading 6.000 off a stage-3 run implies a 5/6 rescale that is simply
wrong, and unlike a silent data error this one is *visible*: it changes
fan-out width at every zoom.

Quote the span only from stage 5, after stage 4 has run.

### Stage 5 has a MEMORY. Do not delete it casually.

`scripts/output/lane-offsets.json` records the lane assignment from the last
successful stage-5 run, and `build-operator-tiles-geojson.mjs` both seeds from it
and charges `STABILITY_WEIGHT` (0.35) for moving away from it.

**Why it exists.** The lane optimiser minimises a cost over the WHOLE network and
had no preference for the answer it gave last time. Adding the 338 branch-ingest
segments — Wharfedale, Harrogate, Pontefract, South Fylde, Morecambe, Corby, none
of them within 100 km of the East Coast Main Line — re-solved everything and moved
**739 of 9,897 lane offsets (7.5%)** by 1–4 units on corridors nobody had touched.
In the Retford–Newark–Grantham–Stamford box alone, offset jogs went **2 → 5**, and
the three new ones were LNER, CrossCountry and Grand Central sitting on the ECML.
On screen a jog is a line that steps sideways mid-corridor and reads as the route
snapping in half. Reported as "the railway lines are breaking up", and it took a
four-way elimination (z0 change, dedupe, sub-brand split, render tiers — all
innocent) to find. Seeding from the pre-ingest assignment put the ECML back to 2.

**Consequences for anyone touching stage 5:**

- **Deleting `lane-offsets.json` is a real change, not a cache clear.** The next
  run re-solves from scratch and offsets move once, network-wide. Only do it
  deliberately, and re-check a main line afterwards.
- **The run is idempotent and must stay that way.** An identical re-run changes
  **0** offsets. If it ever doesn't, something has broken the anchor — that is a
  bug, not noise.
- **`Lane jogs: N` is logged every run.** It is the user-visible metric (97 today,
  worst 2.0 lanes). Watch it across a change; a rise means visible breaks.
- **`LANE_JOG_REPAIR=1` exists and is OFF.** It cuts jogs 99 → 84 but is NOT
  idempotent — it optimises jog count while the optimiser optimises cost, so they
  fight across runs (an identical re-run moved 387 offsets at weight 0.35, 434 at
  0.9). Stability beats 13 jogs. Making it shippable means folding jog count into
  the optimiser's own cost, or iterating optimise→repair to convergence.
- **Not all jogs are defects.** Offsets are centred per segment, so where the
  number of operators differs either side the whole fan must shift — that is the
  fan converging and is correct. Measured: 80 of 99 are structural, 19 avoidable.
  Only chase the avoidable ones.

## Local dev environment notes
- Terse/auto-looking commits you may see in `git log` ("map", "route", "05",
  "00", "1", "Update map.html", etc.) are Aaron committing via GitHub
  Desktop's GUI mid-session on his own machine, not a hook, CI job, cron
  timer, or editor extension — all of those were checked and ruled out
  (2026-07 investigation). GitHub Desktop auto-fills the summary as
  "Update {filename}" when the message field is left blank and only one
  file changed. This is expected human behavior — don't re-investigate it;
  just note it in passing if relevant and move on.

## Rolling stock database (database.html)

`data/site-data.json` is **GENERATED — do not hand-edit it.**

```
data/rolling-stock.json            raw spreadsheet export (overwritten on re-export)
data/rolling-stock-overrides.json  hand-curated: overrides, corrections, merges, additions
        │
        ├─ node scripts/build-locomotive-data.mjs          →  data/site-data.json
        └─ node scripts/build-locomotive-data.mjs --check  →  verifies it is up to date
```

Everything curated by hand lives in the **overrides** file, never in the export —
the export is replaced wholesale whenever the sheet is re-exported, so anything
edited there is lost. That file holds four kinds of entry: `overrides` (field
replacements, e.g. the 22 curated Wikimedia `File:` links), `corrections`
(factual fixes, each with a `_why`), `mergeDuplicates` (the same real class
recorded twice under different key formats), and `additions` (classes absent
from the export entirely). `audit-locomotive-image-licenses.mjs` still reads the
raw export directly and is unaffected by any of this.

**Schema.** One unified named-field object per class. The export has three
different header shapes and column index 6 means "Operator(s)" in five sections,
"Fleet Size" in one and "Main Heritage Lines" in another — so **column position
carries no meaning downstream**; each category declares `columns: [{field,label}]`.

**Counts have two different meanings and both are correct:**
- `totalClasses` — each class **once**, however many categories it appears in.
- `category.count` — classes appearing **in that section**, so a cross-listed
  class contributes to several. `sum(section counts) = totalClasses + cross-listed extras`.

**DOM ids are a cross-file contract.** The canonical instance keeps the bare
`fleet-{slug}`; secondary cross-listed instances get `fleet-{slug}--{category}`.
`map.html`'s Fleet chips link to `#fleet-{slug}`, and `fleetClassSlug()` now
exists in **four** places (map.html, database.html, the build script, the
harness) which must stay byte-identical. `scripts/tests/locomotive-data-harness.mjs`
enforces all of this plus a floor on how many chips resolve.

### Deferred: industrial and narrow-gauge rolling stock

Surveyed 2026-08-04 and **deliberately deferred — not rejected.**

Both were scoped as part of the missing-class sweep and stopped before any rows
were generated, for the same structural reason: **most of that population is
individual, one-off locomotives rather than standardised classes.** Industrial
shunters at ports, quarries, steelworks and MoD sites, and narrow-gauge locos on
the Ffestiniog/Talyllyn/Vale of Rheidol/R&ER, largely do not have a "class" in
the TOPS sense at all — they are individual machines with builder and works
number.

That makes this **a data-shape question, not a data-entry one**. The current
schema assumes a row is a *class* (with a fleet size, a builder, a number built);
representing this population honestly may need a per-*locomotive* shape instead,
or a separate dataset. Rough size if it were attempted as-is: industrial 20–100+
depending entirely on where the line is drawn, narrow gauge ~30–60. Both figures
are low confidence, and much of it is not reliably sourceable to the standard the
rest of the database is held to.

**Needs its own scoping session before any of it is built.** Related: the
`01/5`, `mark5`/`mark5a` and `pba`/`pbka` Fleet chips in `operators-content.json`
resolve to nothing for related reasons — a sub-class shunter, hauled coaching
stock (no traction of its own) and Thalys TGV sets (not UK stock).

## Generator safety: read-merge-preserve

Any script whose output file can also hold hand-curated content — a
correction, a research note, a confirmed placement — must read its own
prior output before writing, merge against an INVERTED allowlist (the set
of keys the generator itself writes; anything else on an existing entry is
preserved, whatever it's called and whenever it was added), and guard the
write: if anything preserve-worthy would be dropped, abort loudly and
write nothing rather than overwrite silently. This generalizes patterns
already used ad hoc elsewhere in this codebase (the rolling-stock overrides
file's separate-file approach; lane-offsets.json's stage-5 seed-and-charge-
for-moving-away-from-it behaviour) into one standing rule for this shape of
problem.

**Why not "preserve fields starting with `_`"?** That naming convention is
already taken and means the opposite in this codebase: `_wikidata`/
`_wikipedia`/`_review` on heritage-content.json mean "regenerate me every
run." Using leading-underscore as a preserve signal would flip that
meaning for those fields, and would still miss most of what actually needs
protecting — none of heritage-content.json's own hand-curated fields
(`established_year` and three siblings) are underscore-prefixed. The
allowlist has to be "what the generator owns," not a naming convention, or
it silently misses whatever a future hand-edit adds.

**Segment identity is the hard case.** heritage-content.json and
data/heritage-railways.json both merge on a stable, hand-given key
(`slug`). scripts/output/line-segments.json has no equivalent: segment
`id` is pure assignment order (`segments.length` at push time, so it
shifts for every segment downstream of any topology change anywhere in the
country), and even `way_ids` isn't unique (831 of 8448 segments on the
live file share a way_ids set with another segment, because parallel-
operator lanes over the same physical way are separate segments). The key
that works is the segment's own `nodes` array — the exact interior node-ID
chain between two significant nodes — compared direction-independently:
collision-free on the live file (8448 distinct keys for 8448 segments)
because it's the finest granularity the graph-contraction algorithm itself
operates at. An exact match means "this physical arc is unchanged"; a miss
is reported as orphaned and left out, never guessed onto whatever segment
happens to occupy the same index.

**Compliant generators**: `build-heritage-content.mjs` →
`data/heritage-content.json` (keyed by slug); `build-line-segments.mjs` →
`scripts/output/line-segments.json` (keyed by node-chain, `ALLOW_ORPHANED_
SEGMENT_NOTES=1` escape hatch archives anything it can't re-attach rather
than discarding it); `build-heritage-client-data.mjs` →
`data/heritage-railways.json` (keyed by slug — `placement_confirmed` is
itself generator-owned, but once a human sets it `true` the whole
placement is frozen at the confirmed values, since flipping that field is
the file's own documented hand-edit path); `build-historical-stations.mjs`
→ `scripts/output/historical-stations.geojson` (keyed by `wikidata_qid` —
NOT `crs`, which is exactly the fragile, orphan-prone signal that caused
the AGR/Angel Road bug below; a Wikidata QID is a real, permanent external
identifier, same stability class as a hand-given slug — confirmed 100%
unique across all 8,884 features before adopting it).

## Corrections layer: the pattern for a genuine sourced-disagreement case

Not built — nothing in this repo currently needs it. Recorded here as the
design to follow WHEN one appears, so the next real case (AGR/Angel Road
was investigated as the driving example but turned out to be a bug in our
own pipeline, not a sourced disagreement — see `build-historical-stations.mjs`'s
`_notes` on `historical-stations-report.json` for that writeup) doesn't
have to re-derive this from scratch. Full survey and reasoning:
`scratchpad/corrections-layer-scoping.md`.

**This is a different problem from read-merge-preserve above.**
Read-merge-preserve protects a hand-edit from being silently destroyed by a
regeneration that doesn't know about it. A correction is the opposite
direction: asserting that a SOURCED value is wrong and a different value is
right, with a reason and a citation, surviving the source continuing to say
the old thing. `ownership_status` (operators-content.json) and heritage's
`established_year` are both fresh assertions — nothing else ever
re-derives them, so there is no rival generator output to disagree with.
The genuine case looks like Knottingley's `attribution_note` on
`line-segments.json` (already shipping, node-chain keyed): a value a
generator ACTIVELY produces, being overridden on purpose.

**Shape, when needed:**
- **Inline, per-domain — not a central corrections file.** Every
  correction-shaped pattern already in this repo chose this independently
  (`_why` on rolling-stock-overrides.json, `_note` on operator-colors.json,
  `attribution_note` on line-segments.json, `ownership_status` on
  operators-content.json) — a central file would need its own key bridging
  every domain, introducing exactly the cross-file drift risk the
  allowlist rule above already exists to avoid.
- A sibling `corrections` array on the entry, never a redirect: the real
  field carries the corrected value directly (so every existing consumer
  keeps working unmodified), the array carries `{field, overridden_value,
  reason, source: {url, title, checked_at}}` per correction — plain
  fields, NOT `_`-prefixed (see the naming-convention warning above; a
  correction is hand-curated, never regenerated, so prefixing it would
  claim the opposite of what's true).
- **Keying is domain-specific — check before assuming a short code works.**
  Human-assigned identifiers (slug, operator code) are stable by
  construction. Derived ones need scrutiny: segment `nodes`-chain and
  Wikidata `qid` both turned out to be the right answer for two different
  domains this session, `crs`/`id` were both traps for the same reason
  (order- or curation-dependent, not a real permanent identifier).
- **Retirement detection is two-tier, not one mechanism.** Where a cheap
  local re-derivation exists (a re-exported spreadsheet, an already-fetched
  Overpass extract), reuse `heritageOverrideStatus()`'s shape
  (`scripts/lib/operator-classify.mjs`, generalised in
  `scripts/check-classifier-overrides.mjs`): compare fresh source data
  against both the overridden and the corrected value, four states (dead /
  corrected / partially-corrected / still-active). Where no re-derivation
  path exists at all, don't pretend otherwise — reuse
  `check-operator-ownership-staleness.mjs`'s shape instead: age-only
  nudge against `checked_at`, no comparison, because there is nothing to
  compare against.
- **Orphan protection falls out of read-merge-preserve for free** for any
  domain the guard above already covers — a `corrections` array is just
  one more non-generator-owned field the inverted allowlist preserves or
  loudly orphans. The only real work for a new domain is giving it a
  read-merge-preserve guard first; the correction mechanism adds nothing
  new on top of that.

## Parked future ideas (not in scope, don't build without being asked)
- Full postal-address coverage for `location` across all 2,637 stations,
  regardless of Wikipedia tier — currently `location` only ever populates
  for the ~478 dedicated-content-tier stations (via
  scripts/fetch-wikipedia-facts.mjs, sourced from the Wikipedia infobox,
  itself inconsistent — usually a place/borough description, not a full
  address). Site-wide coverage would need a separate reverse-geocoding
  pipeline (e.g. Nominatim/OSM from NaPTAN's existing lat/lon in
  station-list.json) — flagged 2026-07-17, deliberately not built.

## What NOT to do
- Never show jargon to users: no STANOX, CRS codes (internal only), headcodes
- Never hardcode hex colours — use the CSS vars defined in :root
- Never use font-size below 9px
- Never use position:fixed (breaks iframe rendering)
- Never add React, Vue, or any framework — except that `database.html` already
  has React + Babel and is a recorded pre-existing exception, not a precedent;
  see the Stack section above
- Never put API keys in client-side JS

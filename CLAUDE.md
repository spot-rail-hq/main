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
- Data source: GET /api/departures?crs=BHM via Huxley2 proxy (or Darwin REST)
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

## Live news / incidents data
- Source: GET /api/incidents (polls every 60s)
- /api/incidents fetches from National Rail Knowledgebase incidents endpoint
- Requires DARWIN_TOKEN env var
- Returns: [{id, summary, region, toc, severity, timestamp, affectedCRS:[]}]
- Urgent = severity >= 2
- News items from existing api/news.js RSS aggregator

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
- Era snap-points: 1845, 1880, 1923, 1965, 1994, 2025

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

## Local dev environment notes
- Terse/auto-looking commits you may see in `git log` ("map", "route", "05",
  "00", "1", "Update map.html", etc.) are Aaron committing via GitHub
  Desktop's GUI mid-session on his own machine, not a hook, CI job, cron
  timer, or editor extension — all of those were checked and ruled out
  (2026-07 investigation). GitHub Desktop auto-fills the summary as
  "Update {filename}" when the message field is left blank and only one
  file changed. This is expected human behavior — don't re-investigate it;
  just note it in passing if relevant and move on.

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
- Never add React, Vue, or any framework
- Never put API keys in client-side JS

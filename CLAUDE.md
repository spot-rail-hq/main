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
  (preserved lines — one shared amber-family color; never the literal
  `--a` "delays/warnings" amber, to avoid reading as a service alert) ·
  `tfl_lines` (London Underground's 11 lines + the 6 real 2024-renamed
  London Overground lines, each with its own real official color —
  route-name-based line-splitting is confirmed working, see the pipeline
  note below; DLR and Elizabeth line are separately tagged in OSM and
  already live in the `metro`/`toc` categories respectively, not here).
- **Never uses `--t` (turquoise)** for any operator/category color — reserved
  exclusively for UI meaning (links, the From/To selected-path highlight).
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
  decision for the segment graph's output, not repeated here). Short
  version: `node scripts/build-operator-inventory.mjs` →
  `node scripts/build-operator-palette.mjs` (this section's table) →
  `node scripts/build-line-segments.mjs` (checkpoint a bbox first, see
  runbook) → `LINE_SEGMENTS_NATIONAL=1 node scripts/build-line-segments.mjs`
  → `node scripts/build-station-graph-links.mjs`. Needs a local Overpass
  instance (see the OSM runbook) for every step except the last. Folds into
  the same refresh cadence as the station/operator content.

## What NOT to do
- Never show jargon to users: no STANOX, CRS codes (internal only), headcodes
- Never hardcode hex colours — use the CSS vars defined in :root
- Never use font-size below 9px
- Never use position:fixed (breaks iframe rendering)
- Never add React, Vue, or any framework
- Never put API keys in client-side JS

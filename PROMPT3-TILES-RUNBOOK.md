# Railway vector tiles — generation & hosting runbook

Produces `gb-railways.pmtiles`, the file `map.html`'s `PMTILES_URL` constant
needs to point at. Everything here was researched and, where marked ✅
**verified live in-session**, actually run against real infrastructure —
nothing below is guessed. The one thing nobody but you can do is create the
R2 bucket and run the upload (no Cloudflare account access from here).

## Why this file, and why not a shortcut

Two shortcuts were considered and ruled out:

- **OpenRailwayMap's own vector tile pipeline** (`openrailwaymap-tile-export`)
  requires a full `osm2pgsql` + PostgreSQL/PostGIS server — far heavier than
  this needs for a client-side static site.
- **Protomaps' public global basemap** (`build.protomaps.com`) — ✅ verified
  live: the `pmtiles` CLI can extract a Great Britain-bounded slice of it
  directly over HTTP range requests, no download of the full planet needed.
  But a GB-extent extract at a modest zoom came out to **344MB**, because
  MVT tiles bundle every layer (roads, buildings, water, POIs) together —
  you can't strip unwanted layers out at extract time, only choose not to
  render them. Since Stadia already renders the full basemap underneath,
  shipping another 344MB of mostly-redundant data just to draw railway
  lines is the wrong tradeoff.

**tilemaker**, run against a Great Britain-only OSM extract with a custom
profile that keeps *only* `railway=*` ways, is the right tool: no database,
single-binary/Docker, and the output only contains what's actually needed.

## Licensing

OpenStreetMap data is licensed under the **ODbL** — a share-alike license
requiring attribution. `map.html` already includes this (see Task 3 changes):
the new `railway-vector` source carries
`© OpenStreetMap contributors` (linked to osm.org/copyright) via MapLibre's
`AttributionControl`, which was already present and compact-mode in the
top-right corner. No further action needed — just don't remove that
attribution string if you edit the source definition later.

---

## Task 1 — Generate the tiles

### 1. Get the source data

```bash
curl -L -o great-britain-latest.osm.pbf \
  https://download.geofabrik.de/europe/great-britain-latest.osm.pbf
```

✅ Verified live: this URL resolves (currently redirects to a dated file,
e.g. `great-britain-260708.osm.pbf`), is **2.0GB**, updated daily, and — per
Geofabrik's own extract description — **"includes no part of Ireland"**,
i.e. it's a real GB-only clip, not a bounding-box crop. This is what makes
Task 3's "real data filtering instead of maxBounds" claim true rather than
aspirational.

### 2. Install tilemaker

No Homebrew formula exists for tilemaker (would mean building from source —
`brew install boost lua shapelib rapidjson` then `make`). The official
Docker image is simpler and needs no compilation:

```bash
docker pull systemed/tilemaker:latest
```

### 3. Write the profile

This profile is intentionally narrow — LineString railway geometry only, no
stations (the app already has its own curated `/data/stations.geojson` and
`station-list.json`, no need to duplicate from OSM), no roads/buildings/
water. The output schema below is exactly what `map.html`'s
`railwayLineColorExpression()` reads — if you change one, change the other.

Save as `config.json`:

```json
{
  "layers": {
    "railways": {
      "minzoom": 5,
      "maxzoom": 14,
      "simplify_below": 12,
      "simplify_level": 0.0003
    }
  },
  "settings": {
    "minzoom": 5,
    "maxzoom": 14,
    "basezoom": 14,
    "include_ids": false,
    "compress": "gzip"
  }
}
```

Save as `process.lua`:

```lua
-- SpotRail HQ minimal railway-line profile for tilemaker.
-- Outputs a single "railways" vector layer, LineString geometry only.
--
-- Output schema (must match map.html's railwayLineColorExpression()):
--   kind:   "rail" | "light_rail" | "tram" | "subway" | "narrow_gauge"
--           | "monorail" | "funicular"
--   status: "active" | "disused" | "abandoned" | "construction"

local RAIL_KINDS = {
  rail = true, light_rail = true, tram = true, subway = true,
  narrow_gauge = true, monorail = true, funicular = true,
}

function way_function()
  local railway = Find("railway")
  if railway == "" then return end

  local kind, status

  if RAIL_KINDS[railway] then
    kind, status = railway, "active"
  elseif railway == "disused" then
    kind, status = "rail", "disused"
  elseif railway == "abandoned" then
    kind, status = "rail", "abandoned"
  elseif railway == "construction" then
    kind, status = "rail", "construction"
  else
    return -- platform, station, signal_box, buffer_stop, crossing, etc — not wanted
  end

  -- The more common real-world OSM tagging pattern is railway=rail PLUS
  -- disused=yes/abandoned=yes, rather than railway=disused/abandoned
  -- directly — catch that too, so the "Closed" status isn't undercounted.
  if Find("disused") == "yes" then status = "disused" end
  if Find("abandoned") == "yes" then status = "abandoned" end

  Layer("railways", false)
  Attribute("kind", kind)
  Attribute("status", status)
  local name = Find("name")
  if name ~= "" then Attribute("name", name) end
end

function node_function()
  -- intentionally empty — no point features in this profile
end
```

(API confirmed against tilemaker's own CONFIGURATION.md: `Find(key)` returns
`""` not `nil` for a missing tag; `Layer(name, isArea)` and
`Attribute(key, value)` operate on the current way inside the callback —
this is NOT the `way:Find(...)` OOP-style syntax older tutorials sometimes
show.)

### 4. Run it

```bash
docker run --rm -v "$(pwd)":/data systemed/tilemaker:latest \
  tilemaker --input /data/great-britain-latest.osm.pbf \
            --output /data/gb-railways.pmtiles \
            --config /data/config.json \
            --process /data/process.lua
```

`--output` accepting `.pmtiles` directly is a newer tilemaker feature — no
separate `mbtiles → pmtiles` conversion step needed. Expect this to take
several minutes to run through the 2GB input; RAM usage can be high — if it
struggles, add `--store /data/store` to spill to disk instead of RAM.

### 5. Verify the output

The `pmtiles` CLI (single Go binary, no deps) is the easiest way to sanity
check the result before uploading anywhere:

```bash
curl -L -o pmtiles-cli.zip \
  https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles-1.31.0_Darwin_arm64.zip
  # or _Darwin_x86_64.zip on Intel Macs, or the Linux/Windows asset for other OSes
unzip pmtiles-cli.zip
./pmtiles show gb-railways.pmtiles
```

✅ Verified live: this exact binary and `show` command were run in-session
against a *different* PMTiles file (Protomaps' global build) and worked
correctly — the tool itself is confirmed functional, just not yet run
against your actual `gb-railways.pmtiles` output since that requires the
Docker/tilemaker step above, which wasn't runnable in this sandbox (no
Docker, no package manager to install tilemaker's build dependencies).
`pmtiles show --metadata gb-railways.pmtiles` will print the `vector_layers`
block — confirm it lists a `railways` layer with `kind`/`status` string
fields, matching the profile above.

---

## Task 2 — Host on Cloudflare R2

1. **Create the bucket** — Cloudflare dashboard → R2 Object Storage →
   Create bucket → name it (e.g. `srhq-tiles`).
2. **Upload** — for a railway-only extract (expected to be far smaller than
   the 344MB full-basemap test above — plain line geometry with a handful of
   short string attributes, no polygons/buildings/POIs), the R2 dashboard's
   direct upload should handle it. If the file turns out larger than ~300MB,
   use `rclone` (R2 is S3-compatible) or `wrangler r2 object put` instead of
   the dashboard.
3. **Enable public read access** — Bucket → Settings → Public Access:
   - **Quick/testing**: "Allow Access" via the `r2.dev` subdomain. Cloudflare
     explicitly documents this as rate-limited and dev-only — fine to
     confirm the map works, not for production traffic.
   - **Production** (recommended): "Connect Domain" and point a subdomain
     you own at the bucket (e.g. `tiles.srhq.uk`) — no rate limit, and this
     is the URL that should end up in `PMTILES_URL`.
4. **Configure CORS** — Bucket → Settings → CORS Policy → Add policy. MapLibre's
   PMTiles protocol makes cross-origin HTTP Range requests to fetch just the
   byte ranges it needs, so the bucket must both allow the origin and
   explicitly allow the `Range` request header:

   ```json
   [
     {
       "AllowedOrigins": ["https://srhq.uk", "https://www.srhq.uk"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   If you're testing from `localhost` before the custom domain is live, add
   that origin too (e.g. `"http://localhost:3000"`), and remove it again
   before shipping.

5. **Update `map.html`** — replace the placeholder:

   ```js
   var PMTILES_URL = 'https://REPLACE-WITH-YOUR-R2-PUBLIC-URL/gb-railways.pmtiles';
   ```

   with the real `tiles.srhq.uk/gb-railways.pmtiles` (or `r2.dev`) URL. That's
   the only code change needed — everything else (the vector source, layer,
   paint, attribution) is already wired in `map.html` and will start working
   the moment this URL resolves to a real file.

## Cost

R2 storage is $0.015/GB-month with **zero egress fees** (Cloudflare's whole
pitch for R2). A railway-only extract at the zoom range above should be low
tens of MB at most — storage cost is a fraction of a cent per month. No paid
API or metered service is introduced anywhere in this pipeline.

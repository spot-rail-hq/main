#!/usr/bin/env bash
# tile-generation/build-operator-tiles.sh
# ─────────────────────────────────────────────────────────────────────────
# Builds operators.pmtiles — the operator-list-per-segment vector tile layer
# for the operator-colored rail line feature. Sibling to config.json/
# process.lua (gb-railways.pmtiles' tilemaker profile) but deliberately NOT
# built with tilemaker: tilemaker only ingests raw .osm.pbf via Lua way/node
# callbacks, and this layer's data is already fully computed (operator
# classification + segment-graph splitting all happened in
# scripts/build-line-segments.mjs) — feeding it back through tilemaker would
# mean re-implementing that entire classification pipeline a second time in
# Lua, a duplicate that would silently drift out of sync with the real one.
# tippecanoe (GeoJSON -> vector tiles, arbitrary properties preserved
# losslessly) is the right tool for tiling already-computed data. See
# LINE-COLORING-RUNBOOK.md for the full reasoning and the rest of the
# pipeline this feeds from.
#
# Prerequisites:
#   - scripts/output/line-segments.json must exist and be a NATIONAL run
#     (LINE_SEGMENTS_NATIONAL=1 node scripts/build-line-segments.mjs) —
#     this script warns but does not block if it's a bbox checkpoint instead.
#   - tippecanoe: `brew install tippecanoe` (macOS) — v2.79.0 used when this
#     was last verified working end-to-end.
#
# Run from the repo root:
#   bash tile-generation/build-operator-tiles.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# ⚠ STEP 1 IS NOT SAFE TO RUN BLIND RIGHT NOW (found 2026-07-27) ⚠
# operators.geojson as committed was generated on 21 Jul from a line-segments.json
# that has since been replaced (22 Jul). Re-running this step against the current
# scripts/output/line-segments.json produces a MATERIALLY DIFFERENT layer:
#   shipped operators.geojson : 9,268 features / 6,126 distinct segment_id
#   regenerated today         : 8,244 features / 5,371 distinct segment_id
# i.e. 1,024 fewer features and 755 fewer segments. That is not a formatting
# difference — it would silently change the z5-z14 map that has already been
# reviewed and signed off, on top of whatever the intended change was.
#
# The 2026-07-27 -Z0 rebuild therefore deliberately SKIPPED this step and tiled
# the committed operators.geojson unchanged, which is what makes that rebuild's
# "z5+ is byte-identical" guarantee true.
#
# Before running this step again, work out which line-segments.json is correct
# and why the segment count fell — do not just accept the new output.
echo "[1/2] Converting scripts/output/line-segments.json -> tile-generation/operators.geojson"
node scripts/build-operator-tiles-geojson.mjs

echo "[2/2] Tiling with tippecanoe -> tile-generation/operators.pmtiles"
cd tile-generation
# ─── WHY -Z0 AND NOT -Z5 (2026-07-27) ─────────────────────────────────────
# This was -Z5. MapLibre returns NO tiles at all below a source's minzoom
# (covering_tiles.ts: `if (z < options.minzoom) return []`), so route lines
# simply vanished under z5 while the station dots — a GeoJSON source, which
# has no zoom bound — kept rendering. Dots floating over an empty map read as
# broken, so the floor is gone.
#
# NOTHING ELSE CHANGED, deliberately. Same input file, same flags, same
# detail, same (absent) simplification override. Verified rather than
# assumed: decoding z5/15/10, z5/16/10, z6/31/20, z6/30/19, z7/63/41,
# z8/125/82, z10/502/331, z12/2033/1332 and z14/8086/5338 from the old and
# new tilesets gives byte-identical output at every one. The z5-z14 map Aaron
# already signed off on is untouched; this only adds z0-z4 beneath it.
#
# NO FEATURE-BUDGET DROPPING HAPPENS HERE. --no-tile-size-limit and
# --no-feature-limit were already set (this build never had
# --drop-densest-as-needed — that flag lives in build-historical-tiles.sh),
# so nothing is discarded to fit a byte budget at any zoom.
#
# The low zooms ARE thinned, by tippecanoe's own sub-pixel feature
# elimination, and that is expected and desirable: measured at z0, 1,808 of
# 6,126 segments survive (29.5% by count) but 93.1% of total TRACK LENGTH
# does — 26,546 km of 28,518. The drop is strongly length-ordered: kept
# segments have a median length of 9,765 m, dropped ones 122 m. At z0 the
# whole of GB spans ~122 tile units, so a 122 m stub is ~0.004 units, far
# below anything renderable. This is cartographic generalisation, not an
# arbitrary subset — the network's shape is intact.
#   Retention by distinct segment_id, unioned over every GB tile at each zoom:
#     z0 1,808 · z1 2,260 · z2 2,794 · z3 3,340 · z4 4,142 · z5 4,655 · z6 5,520
#   (of 6,126 in operators.geojson). Note z5 is where the tileset already
#   started, so its 76% was always the case — the new zooms just continue the
#   same curve downward rather than introducing a new kind of loss.
# Tested and rejected as pointless: -d14 and -d16 (higher tile detail) and -ps
# (no line simplification) each moved z0 retention by under 45 segments while
# up to doubling vertex count — the elimination is not quantisation- or
# simplification-driven, so paying for either buys nothing.
tippecanoe \
  -o operators.pmtiles \
  -l operators \
  -Z0 -z14 \
  --no-tile-size-limit \
  --no-feature-limit \
  --force \
  -A '© OpenStreetMap contributors' \
  operators.geojson

echo ""
echo "Done. tile-generation/operators.pmtiles written."
echo "Verify before uploading: check the final tippecanoe summary line above"
echo "reports the same feature count as line-segments.json's segment_count"
echo "(no feature/property drops), and spot-check via test-operators-tiles.html"
echo "(a throwaway MapLibre test page, needs a Range-request-capable local"
echo "server — Python's http.server does NOT support Range; 'npx http-server'"
echo "does) before wiring the real URL into map.html."

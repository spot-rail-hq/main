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

echo "[1/2] Converting scripts/output/line-segments.json -> tile-generation/operators.geojson"
node scripts/build-operator-tiles-geojson.mjs

echo "[2/2] Tiling with tippecanoe -> tile-generation/operators.pmtiles"
cd tile-generation
tippecanoe \
  -o operators.pmtiles \
  -l operators \
  -Z5 -z14 \
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

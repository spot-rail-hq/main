#!/usr/bin/env bash
# tile-generation/build-historical-tiles.sh
# ─────────────────────────────────────────────────────────────────────────
# Builds historical.pmtiles — the two-layer vector tileset behind the
# historical map slider (pre-1994 lines + every GB station that has ever
# existed). Sibling to build-operator-tiles.sh, same tooling choice and the
# same reasoning: tippecanoe, not tilemaker, because the data is already
# fully computed by the scripts/ pipeline and re-deriving it in Lua would be
# a duplicate that silently drifts.
#
# Prerequisites:
#   - node scripts/build-big4-lookup.mjs           -> data/big4-constituents.json
#   - node scripts/build-historical-lines.mjs      -> scripts/output/historical-lines.geojson
#   - node scripts/build-historical-stations.mjs   -> scripts/output/historical-stations.geojson
#   - node scripts/build-historical-tiles-geojson.mjs  -> the two files this tiles
#   - tippecanoe: `brew install tippecanoe` — v2.79.0 used when this was last
#     verified working end to end.
#
# Run from the repo root:
#   bash tile-generation/build-historical-tiles.sh
#
# ─── SIMPLIFICATION SETTINGS: WHY THESE, AND WHAT WAS MEASURED ────────────
# The operator pipeline uses `--no-tile-size-limit --no-feature-limit` with
# no explicit simplification. Measured against this dataset (2026-07-26),
# that config produces a ~170x swing in tile payload across the zoom range:
# 11,072 vertices per tile at z6 against 64 at z14. Low-zoom tiles are
# effectively unbounded, and every feature in them gets crushed by
# tippecanoe's default simplification to make them fit.
#
# This build changes two things:
#
#   -S 0.5                      Half the default simplification tolerance, so
#                               a feature that IS drawn keeps ~1.5x more of
#                               its vertices at every zoom (measured on the
#                               Lancaster and Carlisle Railway: 59 -> 94
#                               vertices at z6, 121 -> 179 at z8). Smoother
#                               curves at the zooms where curves read as
#                               polygons today.
#
#   --drop-densest-as-needed    Bounds tile size by dropping whole FEATURES in
#   (and dropping the           the densest areas at low zoom, instead of
#   --no-*-limit flags)         mangling the geometry of every feature to fit.
#                               This is the actual anti-pop lever: detail per
#                               retained feature stays consistent across the
#                               zoom range rather than varying with local
#                               density.
#
# Verified: 11,021 features in, 11,021 features out — tippecanoe reports no
# drops at any zoom for this dataset at this size, so the safety valve is
# present without currently costing anything. Output is 13.5 MB against the
# default config's 13.2 MB.
#
# HONEST LIMIT: there is no browser in the build environment, so the visual
# result — whether curves still visibly pop on zoom — is UNVERIFIED. What is
# verified is that more vertices survive at every zoom and that tile payloads
# are now bounded. Check it in a real browser before wiring into map.html.
#
# ─── DO NOT UPLOAD FROM HERE ──────────────────────────────────────────────
# This writes a LOCAL file only. R2 upload is deliberately not automated and
# needs Aaron's review first — see HISTORICAL-SLIDER-FINDINGS.md Phase 2A and
# PROMPT3-TILES-RUNBOOK.md Task 2 for the upload/CORS steps when that happens.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/2] Preparing tile-ready GeoJSON"
node scripts/build-historical-tiles-geojson.mjs

echo ""
echo "[2/3] Tiling LINES -> historical-lines.pmtiles"
cd tile-generation
tippecanoe \
  -o historical-lines.pmtiles \
  -l historical_lines \
  -Z5 -z14 \
  -S 0.5 \
  --drop-densest-as-needed \
  --force \
  historical-lines.geojson

echo ""
echo "[3/3] Tiling STATIONS -> historical-stations.pmtiles, then joining"
# STATIONS ARE TILED SEPARATELY, AND THIS IS NOT OPTIONAL.
#
# tippecanoe applies its feature-dropping settings per TILE, not per layer, so
# tiling both layers in one invocation makes them compete for the same tile
# budget. The ~11,000 line features carry 210,800 vertices and dominate it
# completely: measured on the first combined build, a z5 tile held 5,463 lines
# and TWO of the 8,884 stations. z6 held five. The station dots were not faint,
# they were absent from the tiles — no paint or radius change could have fixed
# it.
#
# That was a side effect of --drop-densest-as-needed, added for the line
# simplification tuning. It is right for lines (bounded tiles, no visible loss)
# and catastrophic for a sparse point layer.
#
# -r1 disables point dropping outright; points cost a coordinate pair each, so
# all 8,884 fit comfortably at every zoom without the size limits the lines need.
tippecanoe \
  -o historical-stations.pmtiles \
  -l historical_stations \
  -Z5 -z14 \
  -r1 \
  --no-feature-limit \
  --no-tile-size-limit \
  --force \
  historical-stations.geojson

# tile-join merges the two single-layer tilesets into the one file map.html
# reads, preserving each layer's own tiling settings.
tile-join \
  -o historical.pmtiles \
  --force \
  -A '© OpenHistoricalMap contributors (CC0) · Some historical linework reproduced with the permission of the National Library of Scotland (CC BY) · Station dates from Wikipedia (CC BY-SA 4.0) · Coordinates from Wikidata (CC0)' \
  historical-lines.pmtiles historical-stations.pmtiles

echo ""
echo "Done. tile-generation/historical.pmtiles written (LOCAL ONLY — not uploaded)."
echo ""
echo "Verify before doing anything else with it:"
echo "  - the tippecanoe summary above should report 11021 + 8884 features read"
echo "    (matching historical-lines-report.json and historical-stations-report.json);"
echo "    a lower number means features were dropped, which for this layer would"
echo "    mean losing real history rather than losing visual clutter."
echo "  - the -A attribution string above is a fallback only. The authoritative,"
echo "    machine-readable manifest is data/attribution.json and Phase 2B's"
echo "    attribution bar must render from THAT, not from this string."
echo "  - spot-check in a browser: no browser exists in the build environment, so"
echo "    the simplification tuning above is measured but visually unverified."

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
echo "[2/2] Tiling with tippecanoe -> tile-generation/historical.pmtiles"
cd tile-generation
tippecanoe \
  -o historical.pmtiles \
  -L historical_lines:historical-lines.geojson \
  -L historical_stations:historical-stations.geojson \
  -Z5 -z14 \
  -S 0.5 \
  --drop-densest-as-needed \
  --force \
  -A '© OpenHistoricalMap contributors (CC0) · Some historical linework reproduced with the permission of the National Library of Scotland (CC BY) · Station dates from Wikipedia (CC BY-SA 4.0) · Coordinates from Wikidata (CC0)'

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

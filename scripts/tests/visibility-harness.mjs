/**
 * REGRESSION HARNESS — setHistoryLayerVisibility() year gating.
 * See ./README.md for the approach, what this slices out of map.html, and what
 * breaks it. Run: node scripts/tests/visibility-harness.mjs
 *
 * The isolation claim under test: below 1994 every 'operator-lines-hit-*' layer
 * is visibility:'none', so the operator handlers cannot fire there regardless of
 * what they contain — the pre-1994 band is preserved STRUCTURALLY, not by a mode
 * guard. Same slice-and-stub approach as highlight-harness.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAP_HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'map.html');
const html = readFileSync(MAP_HTML, 'utf8');
const start = html.indexOf('  function setHistoryLayerVisibility() {');
if (start === -1) throw new Error('setHistoryLayerVisibility not found');
const endMarker = '\n  }\n';
const end = html.indexOf(endMarker, start) + endMarker.length;
const src = html.slice(start, end);
for (const needed of ['showModern', 'modernLineLayers', 'operator-lines-hit-']) {
  if (!src.includes(needed)) throw new Error('slice missing ' + needed);
}

const ROUTE_TIERS = [
  { id: 'trunk' }, { id: 'regional' }, { id: 'hyperlocal' },
  { id: 'heritage-trunk' }, { id: 'heritage-regional' }, { id: 'heritage-local' }, { id: 'heritage-micro' },
];
const STATION_TIERS = [{ id: 'major' }, { id: 'mid' }, { id: 'minor' }];
const GLOW_RINGS = [{}, {}, {}];

function run(mode, historyYear) {
  const vis = {};
  const map = {
    getLayer: (id) => ({ id }),
    setLayoutProperty: (id, prop, v) => { if (prop === 'visibility') vis[id] = v; },
    setPaintProperty: () => {},
  };
  const fn = new Function(
    'map', 'mode', 'historyYear', 'historyLayersReady', 'HISTORY_MODERN_FROM',
    'HIST_LINE_LAYER', 'HIST_LINE_HIT_LAYER', 'HIST_GLOW_PREFIX', 'GLOW_RINGS',
    'ROUTE_TIERS', 'STATION_TIERS',
    'SELECTED_STATIONS_LAYER_ID', 'SELECTED_STATIONS_GLOW_LAYER_ID',
    'ROUTE_LAYER_ID', 'ROUTE_HIT_LAYER_ID',
    'historyStationLayerList', 'clearHistoryHover', 'clearHistoryLock',
    'clearHistoryStationHover', 'applyHistoryModernPaint',
    src + '\n setHistoryLayerVisibility();'
  );
  fn(
    map, mode, historyYear, true, 1994,
    'history-lines', 'history-lines-hit', 'history-lines-hover-glow-', GLOW_RINGS,
    ROUTE_TIERS, STATION_TIERS,
    'selected-stations', 'selected-stations-glow',
    'route-line', 'route-line-hit',
    () => ['history-station-hover', 'history-stations-circle-major', 'history-stations-circle-major-hit'],
    () => {}, () => {}, () => {}, () => {},
  );
  return vis;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); failures++; }
}
const hitLayers = ROUTE_TIERS.map((t) => 'operator-lines-hit-' + t.id);

console.log('\n=== HISTORY @ 1889 (pre-1994 band, and a slider snap point) ===');
{
  const v = run('history', 1889);
  check('ALL operator hit layers hidden -> handlers cannot fire',
    hitLayers.every((id) => v[id] === 'none'),
    JSON.stringify(hitLayers.map((id) => id + '=' + v[id])));
  check('historical line hit layer VISIBLE (History owns clicks here)', v['history-lines-hit'] === 'visible');
  check('modern active overlay hidden', v['operator-lines-active'] === 'none');
  check('modern glow rings hidden', [0, 1, 2].every((i) => v['operator-lines-hover-glow-' + i] === 'none'));
}

console.log('\n=== HISTORY @ 2026 (default landing year, modern band) ===');
{
  const v = run('history', 2026);
  check('ALL operator hit layers VISIBLE -> handlers can fire',
    hitLayers.every((id) => v[id] === 'visible'),
    JSON.stringify(hitLayers.map((id) => id + '=' + v[id])));
  check('historical line hit layer hidden (no competing click owner)', v['history-lines-hit'] === 'none');
  check('modern glow rings VISIBLE (glow-only highlight can show)', [0, 1, 2].every((i) => v['operator-lines-hover-glow-' + i] === 'visible'));
  check('live station markers hidden', v['stations-circle-major'] === 'none');
}

console.log('\n=== HISTORY @ 1994 (exact boundary) ===');
{
  const v = run('history', 1994);
  check('boundary counts as MODERN — hit layers visible', hitLayers.every((id) => v[id] === 'visible'));
  check('boundary hides historical hit layer', v['history-lines-hit'] === 'none');
}

console.log('\n=== HISTORY @ 1993 (one year below boundary) ===');
{
  const v = run('history', 1993);
  check('still historical — operator hit layers hidden', hitLayers.every((id) => v[id] === 'none'));
}

console.log('\n=== NOT in History (live/database) ===');
{
  const v = run('database', 2026);
  check('operator hit layers NOT touched at all', hitLayers.every((id) => v[id] === undefined),
    'setHistoryLayerVisibility only writes modern-layer visibility while mode===history');
  check('historical layers hidden', v['history-lines-hit'] === 'none');
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);

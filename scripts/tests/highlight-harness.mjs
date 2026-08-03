/**
 * REGRESSION HARNESS — applyOperatorHighlightPaint() mode branching.
 * See ./README.md for the approach, what this slices out of map.html, and what
 * breaks it. Run: node scripts/tests/highlight-harness.mjs
 *
 * Slices the REAL function source out of map.html and runs it against a
 * recording stub of the MapLibre map, then asserts which setPaintProperty /
 * setFilter calls each mode produces. Verifies the branch logic and the
 * cross-mode isolation claims (Live/Database untouched, History glow-only,
 * active overlay blanked). Says nothing about how any of it LOOKS — that still
 * needs a browser.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAP_HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'map.html');
const html = readFileSync(MAP_HTML, 'utf8');
const start = html.indexOf('  function applyOperatorHighlightPaint() {');
if (start === -1) throw new Error('applyOperatorHighlightPaint not found');
// Function ends at the first line that is exactly two-space-indented '}'.
const endMarker = '\n  }\n';
const end = html.indexOf(endMarker, start) + endMarker.length;
let src = html.slice(start, end);
// Sanity: the slice must contain the branch under test and its closing.
for (const needed of ['glowOnly', 'colorExprFrom', 'GLOW_RINGS.forEach']) {
  if (!src.includes(needed)) throw new Error('slice missing ' + needed + ' — function shape changed');
}

// ── Recording map stub ───────────────────────────────────────────────────
function makeMap() {
  const calls = [];
  return {
    calls,
    getLayer: (id) => ({ id }),
    setFilter: (id, f) => calls.push({ op: 'setFilter', id, value: f }),
    setPaintProperty: (id, prop, v) => calls.push({ op: 'setPaint', id, prop, value: v }),
  };
}

const ROUTE_TIERS = [
  { id: 'trunk' }, { id: 'regional' }, { id: 'hyperlocal' },
  { id: 'heritage-trunk' }, { id: 'heritage-regional' }, { id: 'heritage-local' }, { id: 'heritage-micro' },
];
const GLOW_RINGS = [{ opacity: 0.1 }, { opacity: 0.2 }, { opacity: 0.3 }];
const NO_OPERATOR_FILTER = ['==', ['get', 'operators'], '__no_operator_selected__'];
const HERITAGE_OPERATOR_KEY = 'Heritage';
const HERITAGE_DASH = ['literal', [0, 2]];
const SOLID_DASH = ['literal', [1, 0]];
const MULTI_OPERATOR_NEUTRAL = { dark: '#888888', light: '#777777' };

function run(state) {
  const map = makeMap();
  const fn = new Function(
    'map', 'mode', 'ROUTE_TIERS', 'GLOW_RINGS', 'NO_OPERATOR_FILTER',
    'HERITAGE_OPERATOR_KEY', 'HERITAGE_DASH', 'SOLID_DASH', 'MULTI_OPERATOR_NEUTRAL',
    'lockedOperatorHighlight', 'hoveredOperatorHighlight',
    'heritageHighlightAll', 'lockedHeritageSlug', 'hoveredHeritageSlug',
    'currentTheme', 'themeColors', 'buildOperatorColorLookup', 'glowColorFor',
    src + '\n applyOperatorHighlightPaint();'
  );
  fn(
    map, state.mode, ROUTE_TIERS, GLOW_RINGS, NO_OPERATOR_FILTER,
    HERITAGE_OPERATOR_KEY, HERITAGE_DASH, SOLID_DASH, MULTI_OPERATOR_NEUTRAL,
    state.locked ?? null, state.hovered ?? null,
    state.highlightAll ?? false, state.lockedHeritage ?? null, state.hoveredHeritage ?? null,
    () => 'dark',
    () => ({ railwayMain: 'rgba(154,164,178,0.65)' }),
    () => ({ GR: '#F72D75', Heritage: '#FC7B64', NT: '#0F0D78' }),
    (c) => c,
  );
  return map.calls;
}

// ── Assertions ───────────────────────────────────────────────────────────
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); failures++; }
}
const greyWrites = (calls) => calls.filter((c) => c.op === 'setPaint' && c.prop === 'line-color' && /^operator-lines-(?!hover-glow|active)/.test(c.id));
const activeFilter = (calls) => calls.filter((c) => c.op === 'setFilter' && c.id === 'operator-lines-active').pop();
const activeColor = (calls) => calls.filter((c) => c.op === 'setPaint' && c.id === 'operator-lines-active' && c.prop === 'line-color').pop();
const activeDash = (calls) => calls.filter((c) => c.op === 'setPaint' && c.id === 'operator-lines-active' && c.prop === 'line-dasharray').pop();
const glowFilters = (calls) => calls.filter((c) => c.op === 'setFilter' && c.id.startsWith('operator-lines-hover-glow-'));
const glowColors = (calls) => calls.filter((c) => c.op === 'setPaint' && c.id.startsWith('operator-lines-hover-glow-') && c.prop === 'line-color');
const isBlank = (f) => JSON.stringify(f) === JSON.stringify(NO_OPERATOR_FILTER);

console.log('\n=== LIVE: national operator locked (baseline, must be unchanged) ===');
{
  const c = run({ mode: 'live', locked: 'GR' });
  check('greys all 7 tiers', greyWrites(c).length === 7, greyWrites(c).length + ' writes');
  check('active overlay filtered to GR', JSON.stringify(activeFilter(c).value) === JSON.stringify(['==', ['get', 'operators'], 'GR']));
  check('active overlay coloured', activeColor(c).value === '#F72D75');
  check('active dash solid', JSON.stringify(activeDash(c).value) === JSON.stringify(SOLID_DASH));
  check('all 3 glow rings filtered + coloured', glowFilters(c).length === 3 && glowColors(c).length === 3);
}

console.log('\n=== DATABASE: locked + hovered (baseline, must be unchanged) ===');
{
  const c = run({ mode: 'database', locked: 'GR', hovered: 'NT' });
  check('greys all 7 tiers', greyWrites(c).length === 7);
  check('active filter is an any-of-2', activeFilter(c).value[0] === 'any' && activeFilter(c).value.length === 3);
  check('active colour is a case expr', Array.isArray(activeColor(c).value) && activeColor(c).value[0] === 'case');
  check('glow rings painted', glowColors(c).length === 3);
}

console.log('\n=== DATABASE: heritage railway locked (last session, must be unchanged) ===');
{
  const c = run({ mode: 'database', lockedHeritage: 'bluebell-railway' });
  check('greys all 7 tiers', greyWrites(c).length === 7);
  check('active filter is heritage_slug', JSON.stringify(activeFilter(c).value) === JSON.stringify(['==', ['get', 'heritage_slug'], 'bluebell-railway']));
  check('active dash is DOTTED (heritage-only)', JSON.stringify(activeDash(c).value) === JSON.stringify(HERITAGE_DASH));
  check('glow rings painted', glowColors(c).length === 3);
}

console.log('\n=== DATABASE: heritage highlight-all (last session, must be unchanged) ===');
{
  const c = run({ mode: 'database', highlightAll: true });
  check('active filter is operators==Heritage', JSON.stringify(activeFilter(c).value) === JSON.stringify(['==', ['get', 'operators'], 'Heritage']));
  check('active dash is DOTTED', JSON.stringify(activeDash(c).value) === JSON.stringify(HERITAGE_DASH));
}

console.log('\n=== HISTORY: national operator locked (the fix — glow-only) ===');
{
  const c = run({ mode: 'history', locked: 'GR' });
  check('NO grey pass — history paint untouched', greyWrites(c).length === 0, greyWrites(c).length + ' grey writes leaked');
  check('active overlay BLANKED', isBlank(activeFilter(c).value));
  check('active overlay line-color NOT written', activeColor(c) === undefined);
  check('active overlay dash NOT written', activeDash(c) === undefined);
  check('all 3 glow rings filtered to GR', glowFilters(c).length === 3 && glowFilters(c).every((g) => JSON.stringify(g.value) === JSON.stringify(['==', ['get', 'operators'], 'GR'])));
  check('all 3 glow rings coloured', glowColors(c).length === 3 && glowColors(c).every((g) => g.value === '#F72D75'));
}

console.log('\n=== HISTORY: hover preview (glow-only) ===');
{
  const c = run({ mode: 'history', hovered: 'NT' });
  check('NO grey pass', greyWrites(c).length === 0);
  check('active overlay blanked', isBlank(activeFilter(c).value));
  check('glow follows the hover', glowColors(c).length === 3 && glowColors(c).every((g) => g.value === '#0F0D78'));
}

console.log('\n=== HISTORY: nothing selected (entering History / after clear) ===');
{
  const c = run({ mode: 'history' });
  check('NO grey pass', greyWrites(c).length === 0);
  check('active overlay blanked', isBlank(activeFilter(c).value));
  check('glow rings blanked', glowFilters(c).length === 3 && glowFilters(c).every((g) => isBlank(g.value)));
}

console.log('\n=== HISTORY: heritage railway locked (2026-08-03 — the new path) ===');
{
  const c = run({ mode: 'history', lockedHeritage: 'bluebell-railway' });
  check('NO grey pass — history paint untouched', greyWrites(c).length === 0, greyWrites(c).length + ' grey writes leaked');
  check('active overlay BLANKED (glow-only)', isBlank(activeFilter(c).value));
  check('active overlay dash NOT written', activeDash(c) === undefined);
  check('glow filtered to the ONE railway by heritage_slug',
    glowFilters(c).length === 3 && glowFilters(c).every((g) =>
      JSON.stringify(g.value) === JSON.stringify(['==', ['get', 'heritage_slug'], 'bluebell-railway'])));
  check('glow uses the heritage colour', glowColors(c).every((g) => g.value === '#FC7B64'));
}

console.log('\n=== HISTORY: heritage highlight-all (toggle, must still work) ===');
{
  const c = run({ mode: 'history', highlightAll: true });
  check('NO grey pass', greyWrites(c).length === 0);
  check('glow covers ALL heritage by operators tag',
    glowFilters(c).every((g) => JSON.stringify(g.value) === JSON.stringify(['==', ['get', 'operators'], 'Heritage'])));
}

console.log('\n=== HISTORY: operator clicked AFTER heritage (state-corruption check) ===');
{
  // Exactly the sequence in the brief: heritage click leaves lockedHeritageSlug
  // set, then a modern-operator click sets lockedOperatorHighlight. Neither may
  // clobber the other, and both must glow.
  const c = run({ mode: 'history', lockedHeritage: 'bluebell-railway', locked: 'GR' });
  check('NO grey pass', greyWrites(c).length === 0);
  check('active overlay still blanked', isBlank(activeFilter(c).value));
  check('glow filter is an any-of-2 (both survive)',
    glowFilters(c).every((g) => g.value[0] === 'any' && g.value.length === 3));
  check('heritage condition present', JSON.stringify(glowFilters(c)[0].value).includes('heritage_slug'));
  check('operator condition present', JSON.stringify(glowFilters(c)[0].value).includes('"GR"'));
  check('glow colour is a 2-way case (each keeps its own colour)',
    glowColors(c).every((g) => Array.isArray(g.value) && g.value[0] === 'case'));
  check('heritage precedence first, operator as fallback',
    glowColors(c)[0].value[2] === '#FC7B64' && glowColors(c)[0].value[3] === '#F72D75');
}

console.log('\n=== LIVE: nothing selected (baseline) ===');
{
  const c = run({ mode: 'live' });
  check('greys all 7 tiers', greyWrites(c).length === 7);
  check('active overlay blanked', isBlank(activeFilter(c).value));
  check('glow rings blanked', glowFilters(c).every((g) => isBlank(g.value)));
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);

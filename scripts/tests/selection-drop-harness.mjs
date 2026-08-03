/**
 * REGRESSION HARNESS — setMode()'s selection-drop matrix.
 * See ./README.md for the approach, what this slices out of map.html, and what
 * breaks it. Run: node scripts/tests/selection-drop-harness.mjs
 *
 * Slices the real condition out of map.html and evaluates it for every
 * (selection.type x target mode) pair, so moving one type between categories
 * re-verifies every other type at once rather than only the one that changed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAP_HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'map.html');
const html = readFileSync(MAP_HTML, 'utf8');
const start = html.indexOf('    var liveOnly = selection.type === ');
const endMarker = '      activeSpanRange = null;\n    }';
const end = html.indexOf(endMarker, start) + endMarker.length;
if (start === -1 || end < start) throw new Error('drop block not found');
const src = html.slice(start, end);
for (const needed of ['dbAndHistory', 'liveOnly', 'historyOnly', 'selection = { type:']) {
  if (!src.includes(needed)) throw new Error('slice missing ' + needed);
}

// Detects the ASSIGNMENT, not the resulting type — `selection.type === 'none'`
// would be trivially true for a selection that was already 'none' and would
// report a drop that never happened. The block reassigns `selection` to a fresh
// object, so identity against the original is the honest signal.
function dropped(type, mode) {
  const original = { type };
  let selection = original;
  let activeSpanRange = null;
  const fn = new Function('selection', 'mode', 'activeSpanRange', 'original',
    src + '\n return selection !== original;');
  return fn(selection, mode, activeSpanRange, original);
}

const TYPES = ['saved', 'route', 'operator', 'heritage', 'fromto', 'histop', 'histline', 'histstation', 'none'];
const MODES = ['live', 'database', 'history'];

// expected[type][mode] = true means "should be dropped"
const expected = {
  saved:       { live: false, database: true,  history: true  },
  route:       { live: true,  database: false, history: true  }, // stays dbOnly — no map representation in History
  operator:    { live: true,  database: false, history: false }, // ← 2026-08-04 change
  heritage:    { live: true,  database: false, history: false },
  fromto:      { live: false, database: false, history: false },
  histop:      { live: true,  database: true,  history: false },
  histline:    { live: true,  database: true,  history: false },
  histstation: { live: true,  database: true,  history: false },
  none:        { live: false, database: false, history: false },
};

let failures = 0;
console.log('\n=== setMode() selection-drop matrix (true = selection dropped) ===\n');
console.log('  type          live      database   history');
for (const t of TYPES) {
  const row = [];
  for (const m of MODES) {
    const got = dropped(t, m);
    const want = expected[t][m];
    if (got !== want) { failures++; row.push(`${got}!=${want}✗`); }
    else row.push(String(got).padEnd(9));
  }
  const mark = (t === 'heritage' || t === 'operator') ? '  <- dbAndHistory' : (t === 'route' ? '  <- dbOnly' : '');
  console.log('  ' + t.padEnd(13) + row.join(' ') + mark);
}

console.log('\n=== the specific claims ===');
function check(label, cond) {
  if (cond) console.log('  PASS  ' + label);
  else { console.log('  FAIL  ' + label); failures++; }
}
check('heritage SURVIVES a switch into History', dropped('heritage', 'history') === false);
check('heritage SURVIVES a switch into Database', dropped('heritage', 'database') === false);
check('heritage is DROPPED in Live (Live cannot render it)', dropped('heritage', 'live') === true);
check('operator SURVIVES a switch into History (2026-08-04)', dropped('operator', 'history') === false);
check('operator SURVIVES Database', dropped('operator', 'database') === false);
check('operator is DROPPED in Live', dropped('operator', 'live') === true);
check('route DELIBERATELY unchanged — still dropped in History', dropped('route', 'history') === true);
check('route unchanged elsewhere', dropped('route', 'live') === true && dropped('route', 'database') === false);
check('saved unchanged — still dropped in Database and History',
  dropped('saved', 'database') === true && dropped('saved', 'history') === true);
check('fromto unchanged — survives everywhere',
  MODES.every((m) => dropped('fromto', m) === false));
check('history types unchanged — survive History, dropped elsewhere',
  ['histop', 'histline', 'histstation'].every((t) =>
    dropped(t, 'history') === false && dropped(t, 'live') === true && dropped(t, 'database') === true));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL CHECKS PASSED'));
process.exit(failures ? 1 : 0);

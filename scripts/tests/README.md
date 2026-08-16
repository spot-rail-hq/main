# map.html regression harnesses

    node scripts/tests/run-all.mjs        # everything
    node scripts/tests/highlight-harness.mjs   # or one at a time

Exit code 0 = pass. Every harness prints a PASS/FAIL line per check.

## What these are, and what they are not

`map.html` has no build step, no module system and no browser available in this
environment, so its logic cannot be imported or clicked. These harnesses do the
next best thing: each one **slices a specific function's source text straight out
of `map.html`**, evaluates it with `new Function(...)` against stub dependencies,
and asserts on the calls it makes.

That means they test the **real shipped code**, not a copy that can silently
drift. It also means they are **structural**: they verify which
`setPaintProperty` / `setFilter` / `setLayoutProperty` calls happen in which
mode. They say nothing about how anything **looks**. Layout, colour rendering and
actual on-screen appearance remain unverified by these — that still needs a
browser.

## Why they exist

Every one of these covers a bug this feature area has already produced, twice
each in some cases:

- **2026-07-27** — blanket `mode === 'history'` early-returns were added to
  `wireOperatorLineInteractions()` to stop a hover in History greying the whole
  network. They fixed the repaint by disabling selection outright, leaving the
  entire 1994+ band with no interaction owner. Nothing caught it for a week.
- **2026-08-03** — `selectHeritageRailway()` called `setMode('database')`
  unconditionally, so a shared `?mode=history&year=…&heritage=…` link threw away
  the restored mode *and* year before the panel opened.
- Repeatedly — cross-mode paint leakage, where a Live-mode repaint writes over
  layers History owns.

The common shape is **one mode's behaviour leaking into another**. That is
exactly what a matrix of stubbed calls catches cheaply and a manual click-through
does not.

## The harnesses

### `highlight-harness.mjs`
**Slices:** `applyOperatorHighlightPaint()` — from `  function
applyOperatorHighlightPaint() {` to the first two-space-indented `}`.

**Stubs:** a recording `map` (`getLayer`/`setFilter`/`setPaintProperty` push to an
array), plus `ROUTE_TIERS`, `GLOW_RINGS`, the colour lookup and theme helpers.

**Asserts:** that Live/Database do the full reverse-colour-reveal (grey all 7
tiers, filter + colour the `operator-lines-active` overlay, set the dash, paint 3
glow rings) and that History does **glow-only** — zero grey writes, overlay
blanked, `line-color`/`line-dasharray` never written on it. Also covers heritage
per-railway locks (filter on `heritage_slug`), heritage highlight-all (filter on
`operators`), and the mixed heritage+operator case where both must survive with
their own colours and correct precedence.

**Breaks if:** the function is renamed, its opening line stops matching, its body
stops being closed by a two-space-indented `}`, or the `glowOnly` /
`colorExprFrom` / `GLOW_RINGS.forEach` internals are renamed — it asserts those
names are present in the slice and throws loudly rather than testing nothing.

### `visibility-harness.mjs`
**Slices:** `setHistoryLayerVisibility()`.

**Stubs:** a `map` recording `setLayoutProperty(id, 'visibility', …)`, plus the
tier and layer-id constants.

**Asserts:** the 1994 source-switch. Below 1994 every `operator-lines-hit-*`
layer is `'none'` and `history-lines-hit` is `'visible'`; at and above 1994 the
reverse. This is what makes the pre-1994 band's isolation **structural** — the
modern operator handlers cannot fire there because MapLibre does not hit-test
hidden layers, so no mode guard is needed in the handlers themselves. Checks the
1993/1994 boundary explicitly.

**Breaks if:** the function is renamed, or `showModern` / `modernLineLayers` /
the `operator-lines-hit-` prefix are renamed.

### `selection-drop-harness.mjs`
**Slices:** the `liveOnly` / `dbOnly` / `dbAndHistory` / `historyOnly` block in
`setMode()`, from `    var liveOnly = selection.type === ` through the closing of
the `if` that resets `selection`.

**Stubs:** just `selection`, `mode` and `activeSpanRange`.

**Asserts:** the full drop matrix — all 9 selection types × 3 modes. The point is
that changing one type's category re-verifies every other type at the same time,
so a category move cannot quietly alter a neighbour.

Note the oracle detects the **assignment** (`selection !== original`), not
`selection.type === 'none'` — the latter is trivially true for a selection that
was already `'none'` and would report drops that never happened.

**Breaks if:** the variable names change, or the block stops ending with
`activeSpanRange = null;\n    }`.

### `locomotive-data-harness.mjs`
**Does NOT slice map.html.** `data/site-data.json` is a generated artefact, so
this one runs against the built file plus its inputs (`rolling-stock.json`,
`operators-content.json`).

**Asserts** the invariants the 2026-08-04 schema migration introduced: global
`totalClasses` counts each class once while per-section counts count every
appearance (so `sum(section counts) = totalClasses + cross-listed extras`); every
DOM id is unique; canonical ids stay bare `fleet-{slug}` and secondary ones carry
a `--{category}` suffix; nothing was dropped (`canonical + merged = raw export
rows`); and the schema really is unified (no positional `row` arrays, named
columns everywhere).

The load-bearing one is **"at least 83 Fleet chips still resolve"** — a
cross-file contract between `operators-content.json`, `map.html`'s chip links and
this data, which nothing else enforces. 83 is a floor measured pre-migration:
adding classes may raise it, but a drop means a chip stopped landing on a row.

**Breaks if:** `site-data.json` is hand-edited instead of rebuilt (run
`node scripts/build-locomotive-data.mjs`), or `fleetClassSlug()` diverges between
its four copies.

### `station-region-harness.mjs`
**Slices:** `regionKeyFor()` out of `shared.jsx` (React/JSX, loaded browser-side
as a `text/babel` script with no build step — same reason the other harnesses
here slice rather than import).

**Asserts:** every one of the 3,443 current stations in `station-list.json`
resolves, via `regionKeyFor()`, to a real `data/station-regions.json` `current`
entry whose `region` is a real key in that file's own `regions` table; that
every station carrying its own `atco` resolves through that atco (never the
`crs:` fallback); and that the `crs:` fallback set is exactly the 7 stations
CLAUDE.md's station-regions note documents (Bond Street, Barking Riverside,
Custom House, Canary Wharf, Tottenham Court Road, Woolwich, Southampton Town
Quay) — named individually, not just counted, so a drift names itself rather
than just changing a number.

**Breaks if:** `regionKeyFor()` is renamed or restructured so its body is no
longer closed by a bare top-level `}`, or `station.atco`/`'crs:'` stop
appearing in its source (the slice sanity check).

## When one of these fails

A failure is usually real. But because they slice source text, a **restructure**
of `map.html` can break the slice itself rather than the behaviour. The harnesses
distinguish these for you: a bad slice throws an explicit
`slice missing <name>` / `<function> not found` error before any check runs,
whereas a behaviour regression prints `FAIL` on a specific named check. Fix the
slice markers in the harness for the former; fix `map.html` for the latter.

## Future decision

There is no test runner, no `package.json` and no CI wiring in this repo — these
run under plain `node`. Adopting a real runner (and having it run on push) is a
separate decision, deliberately not made here.

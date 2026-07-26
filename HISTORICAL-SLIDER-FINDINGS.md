# Historical map slider — Phase 1 data investigation

**Status:** findings only. No pipeline built, no data files written, nothing committed.
**Date:** 2026-07-25
**Sources queried live:** OpenHistoricalMap Overpass (`overpass-api.openhistoricalmap.org`,
data timestamp `2026-07-25T19:40Z`), Wikipedia action API, Wikidata API, plus our own
`scripts/output/line-segments.json`.
**GB bounding box used throughout:** `49.86, -8.65, 60.86, 1.77`. See
[Caveats](#caveats-that-apply-to-every-number-here) — this bbox is not GB.

---

## Headline verdict

| Component | Verdict |
|---|---|
| **Lines, geometry + dates** | **Strong.** Build on OHM. |
| **Lines, company/operator attribution** | **Not viable from OHM tags.** ~7% coverage, and effectively zero for 1923–1994. |
| **Stations** | **Weak from OHM (~1,400 for all of history).** Wikipedia + Wikidata is ~8× better and geolocatable. |
| **Beeching-era lines (the 1965 snap-point)** | **Strong.** 7,427 km of closures dated 1963–70. |
| **Beeching-era stations** | **Weak from OHM (426), good from Wikipedia (3,378).** |
| **Notable-year highlights** | **Semi-automatable, but not from the source you'd expect.** Derive candidate years from closure/opening statistics, not from prose articles. |
| **Modern band (1994–2025) reuse** | **Yes, reuse ours. Don't source modern from OHM at all.** |

The single biggest surprise: **OHM's line coverage is far better than its raw feature count
suggests, and its station coverage is far worse.** 13,454 line ways sounds thin next to the
61,905 OSM ways behind our modern segment graph, but by length OHM holds 33,385 km across all
eras and tracks the real network's rise and fall closely. Meanwhile 1,395 station records is
simply not a national dataset — it is less than today's open stations, never mind history.

---

## 1. Lines — OHM coverage

### 1a. Date coverage

13,655 ways carry `railway=*` in the bbox. Excluding station buildings, platforms, turntables,
signal boxes and other non-linear features leaves **13,454 linear track ways**.

| | ways | % of linear |
|---|---:|---:|
| `start_date` present | 11,661 | 86.7% |
| `end_date` present | 5,670 | 42.1% |
| **both** | 5,661 | 42.1% |
| only `start_date` | 6,000 | 44.6% |
| only `end_date` | 9 | 0.1% |
| **neither** | 1,784 | 13.3% |

"Only `end_date`" being 9 features is the useful shape here: an end date virtually never appears
without a start date, so there are no half-dated features to reconcile. Undated features are
undated in both directions.

**Date formats are clean and machine-parseable.** Of 18,331 date values: 12,674 `YYYY-MM-DD`,
3,941 `YYYY`, 715 `YYYY-MM`, and exactly **one** malformed value (`18341`, on a `start_date` —
an obvious typo for 1834). No `~1850`, no `1850s`, no `C19`, no EDTF strings in the main tags.
A `^(\d{4})` prefix match is sufficient; no fuzzy date parser needed.

Two caveats on that cleanliness:
- 282 ways carry `start_date:edtf` and 200 carry `end_date:edtf` alongside the plain tags.
  I did not inspect whether these disagree with the plain values. **Flagged, not resolved.**
- 876 ways carry `fixme:start_date`, and only 1 of those also has a `start_date`. So roughly
  half of the 1,784 undated ways are undated because **a mapper explicitly flagged the date as
  unknown**, rather than because nobody has looked. That is honest metadata and worth surfacing
  rather than silently hiding those features.

### 1b. Era bands

Ways/km alive at each candidate snap-point (a way is alive at year Y if `start_year <= Y` and
`end_year` is absent or `>= Y`; the 1,784 undated ways are excluded entirely):

| Year | ways alive | km alive | Real-world reference |
|---:|---:|---:|---|
| 1825 | 93 | 207 | Stockton & Darlington was 25 mi / 40 km — OHM also holds earlier wagonways |
| 1845 | 1,411 | 4,373 | |
| 1880 | 8,441 | 25,287 | |
| 1923 | 10,770 | 31,447 | Peak network was 23,440 mi / **37,720 km** (pre-WWI) → OHM ≈ **83%** |
| 1948 | 10,519 | 30,611 | |
| 1965 | 8,699 | 23,948 | |
| 1994 | 6,054 | 17,719 | |
| 2025 | 6,000 | 17,513 | Today's National Rail network is ~15,800 route km |

The shape is right and the magnitudes are right. The 1923 figure sitting at 83% of the known
historical peak is the strongest single indicator that OHM's GB line data is a real dataset
rather than a scattering of enthusiast contributions.

**Per-band feature activity:**

| Band | alive | opened in band | closed in band |
|---|---:|---:|---:|
| pre-1923 | 11,224 | 11,224 | 456 |
| 1923–1947 (Big Four) | 10,889 | 121 | 371 |
| 1948–1994 (BR) | 10,698 | 180 | 4,646 |
| 1994–2026 (modern) | 6,190 | 142 | 190 |

**No band looks sparse for line geometry.** The 1923–1947 band has the fewest events (121
openings, 371 closures) but that is historically correct — the Big Four era was consolidation,
not construction. It is not a data gap.

### 1c. Beeching closures — the 1965 snap-point

This is the band the whole feature hinges on, and it is **well covered for lines**:

| Window | ways closed | km closed |
|---|---:|---:|
| 1948–1954 | 394 | 1,241 |
| 1955–1962 | 664 | 2,644 |
| **1963–1970** | **2,662** | **7,427** |
| 1971–1975 | 332 | 633 |
| **1955–1975 total** | **3,658** | **10,705** |

The 1963 Beeching report targeted 5,000 miles (**8,000 km**) for closure. OHM holds 7,427 km of
line closures dated 1963–70 alone. The five-year closure histogram peaks exactly where it
should (1965–69: 1,770 ways; 1960–64: 1,139), with a clean falloff either side.

**The 1965 snap-point will look right for lines.** It will not look right for stations — see §2.

### 1d. Company / operator naming — the real problem

This is where OHM fails for our purposes.

| Tag | ways | % of linear |
|---|---:|---:|
| `operator` (plain) | 944 | 7.0% |
| `operator:<date>` (date-namespaced) | 290 ways, 8 distinct keys | 2.2% |
| `name` | 7,655 | 56.9% |

`operator` presence is flat at **~7% in every era band** — it does not improve for any period.
Worse, the 41 distinct values are geographically concentrated: the top entries are *Formartine
and Buchan Railway* (189), *Inverness and Perth Junction Railway* (106), *Great North of Scotland
Railway* (92), *Inverness and Aberdeen Junction Railway* (81), *Highland Railway* (77). This is
one or two dedicated mappers having done north-east Scotland thoroughly. It is not national
coverage.

**The Big Four and British Railways are essentially absent.** Across the full tag dump of all
13,454 linear ways:

- `British Rail` — **1 occurrence**
- `British Railways` — **1 occurrence**
- `LNER` — **0**
- `LMS` — **0**
- `London, Midland` — **0**
- `Southern Railway` — 4
- `Railtrack` — **0**

So the popup-naming requirement **cannot be met from `operator` for 1923–1994 at all**. OHM
models GB railways as physical infrastructure with build/close dates, not as a time-series of
who ran them.

**Tagging inconsistencies found**, if you do use what exists:
- `NER` (2 ways) vs `North Eastern Railway` (2 ways) — same company, both spellings live.
- `Scotrail` (3) — the real brand is *ScotRail*.
- `Cheshire Lines Railway` (13) — the real body was the *Cheshire Lines Committee*.
- Ampersand vs word: `Lanarkshire & Ayrshire Railway`, `Glasgow & South Western Railway` vs
  `Liverpool and Manchester Railway`, `London and South Western Railway`.
- Irish operators present in the bbox (`Irish Rail`, `CIÉ`, `Great Southern Railways`,
  `Dublin and South Eastern Railway`) — see [Caveats](#caveats-that-apply-to-every-number-here).

**The date-namespaced form is real but tiny.** OHM's convention for "operator changed on this
date" produces keys like `operator:1864-02-01`. Only 8 such keys exist in GB, on 290 ways,
clustered in 1862–1880 with a single `operator:1923-01-01` (18 ways). It is a genuine OHM
idiom you'd need to parse, but it is not a usable national dataset either.

**A partial workaround exists.** 3,861 ways (28.7%) carry a `name` that *is* a historic company
name — `Liverpool and Manchester Railway`, `Grand Junction Railway`, `Glasgow & South Western
Railway` — across 415 distinct company-ish strings. This is a viable proxy **for pre-1923 only**,
with three important limits: it is the name of the line *as built*, not a time-varying operator;
it is inconsistently formatted (same `&`/`and` problem); and branch suffixes are appended
free-form (`North London Railway-Poplar Branch`, `Lanarkshire & Ayrshire Railway - Irvine Branch`).
2,063 ways (15.3%) instead carry a modern route name (`…Line`), which is a different kind of
string in the same field.

**Recommendation, flagged for your decision:** for 1923–1947 and 1948–1994, company attribution
would have to come from somewhere other than OHM tags — most plausibly a small hand-built
grouping-to-company table, since the Big Four and BR are a *closed, tiny* vocabulary (4 companies
and 1 nationalised body, plus BR regions if you want them). That is a very different and much
smaller curation job than naming pre-1923's hundreds of independent companies, and it may be the
one place hand-curation is genuinely cheaper than automation. **I have not scoped that table.**

### 1e. Relations

496 relations carry a railway tag — 479 `type=multilinestring`, 13 `multipolygon`, 4
`type=chronology` (OHM's mechanism for a feature that changes identity over time). All 496 carry
a date. **Zero carry an `operator`.** Only 5 `type=route` railway relations exist in the whole
bbox, so unlike mainstream OSM — where our own segment graph is built from 1,145 route
relations — **there is no route-relation layer in OHM to hang attribution on.**

---

## 2. Stations — OHM coverage

### 2a. The universe is too small

**1,395 station-ish elements exist in OHM for all of GB history:** 1,287 `node:station`,
70 `way:station`, 29 `node:halt`, 9 `node:stop`.

For scale: **~2,570 stations are open in GB today**, and the 1963 Beeching report alone
identified 2,363 stations for closure. The full historical universe is comfortably north of
5,000. OHM has, at most, ~509 records without an end date — **under a fifth of today's open
stations, let alone history.**

### 2b. Date quality is excellent where records exist

| | count | % of 1,395 |
|---|---:|---:|
| `start_date` | 1,327 | 95.1% |
| `end_date` | 886 | 63.5% |
| both | 885 | 63.4% |
| neither | 67 | 4.8% |

So the problem is **not** date quality — it is that the records barely exist. A station in OHM is
almost always properly dated; there just aren't many stations.

### 2c. Beeching-era station closures — the direct test you asked for

**426 stations carry an `end_date` between 1955 and 1975**, against a real-world figure of
roughly 2,000–2,500.

The closure histogram has the right *shape* (1965–69: 195; 1960–64: 134; 1950–54: 88) but roughly
**one-sixth the volume**. Concretely: if you build station appear/disappear from OHM alone,
dragging the slider through 1963→1967 will remove a couple of hundred dots from a map that only
had ~1,400 to begin with. It will read as a mild thinning, not as the Beeching Axe. **It will
look wrong to anyone who knows the period, which is precisely the audience a history slider
attracts.**

One genuinely good piece of news: the sparse coverage is **not** regionally clustered the way the
line `operator` tags are. Crude latitude banding gives London-ish 20.6%, Midlands/N Wales 18.1%,
S England/S Wales 17.0%, N England 16.2%, C/S Scotland 14.9%, SW England 7.2%, N Scotland 5.9%.
That is a plausible spread of where stations actually are. So OHM's station data is *uniformly*
thin rather than *patchily* thin — which means a Wikipedia backfill would be topping up
everywhere rather than patching specific holes.

### 2d. Wikipedia + Wikidata as the station source — assessed, not built

Wikipedia's year-indexed station categories are dramatically richer, and I verified this end to
end rather than assuming it.

| | articles |
|---|---:|
| `Category:Railway stations in Great Britain closed in YYYY`, 1830–2026 | **7,204** |
| `Category:Railway stations in Great Britain opened in YYYY`, 1830–2026 | **10,653** |
| closed 1955–1975 (Beeching window) | **3,378** — vs OHM's 426, ~**8×** |

Peak closure years: 1964 (565), 1965 (392), 1962 (346), 1966 (288). Peak opening years:
1848 (358), 1849 (246), 1847 (238).

**The critical question was whether these are geolocatable.** I took all 565 members of
"closed in 1964" and checked:

| | rate |
|---|---|
| Wikipedia page has `coordinates` | 130 / 565 = **23.0%** |
| Wikipedia page has a Wikidata item | 532 / 565 = **94.2%** |
| …of those items, Wikidata has **P625 coordinate location** | 531 / 532 = **99.8%** |
| …of those items, Wikidata has P571 inception (opened) | 37 / 532 = 7.0% |
| …of those items, Wikidata has P576 dissolved (closed) | 8 / 532 = 1.5% |

This is a clean split of responsibilities and it makes the pipeline unusually low-risk:

- **The date comes from the category name itself** — `…closed in 1964` is structured, exact, and
  needs no extraction. No AI, no parsing of prose.
- **The coordinates come from Wikidata P625** at ~94% of category members (94.2% × 99.8%).
- **Wikidata's own date properties are useless here** (7% / 1.5%) and should be ignored entirely.

So a station backfill would be **fully deterministic** — no Claude involvement, no hallucination
surface. That is a materially different risk profile from the notable-years work in §3.

**Unresolved, flag before building:**
- Year granularity only. The category gives 1964, not 15 June 1964. Fine for a year slider;
  a problem if you ever want month precision.
- ~6% of members have no Wikidata coordinates and would need another route or dropping.
- Deduplication against OHM's existing 1,395 records is unscoped. Name matching alone will be
  messy (`Aberdare Low Level railway station` vs OHM naming), and reopened stations appear in
  both an "opened" and a "closed" category legitimately.
- Category membership is not a closure *cause*. Stations closed by Beeching, by wartime economy,
  and by a 1980s rationalisation all sit in the same year categories with nothing distinguishing
  them. If you ever want "show me Beeching closures specifically", this source does not carry it.

### 2e. Line-level Wikipedia categories are *not* a similar win

Worth stating explicitly so it isn't assumed symmetric: `Category:Railway lines opened in 1845`
holds **15** pages and `Category:Railway lines closed in 1965` holds **19**. The station
categories are richly populated; the line categories are not. **Lines stay on OHM; only stations
get the Wikipedia treatment.**

---

## 3. Notable-year highlights — feasibility

### What I checked

- **`YYYY in rail transport` articles: exist for all 207 years, 1820–2026.** No gaps. But they
  are **global in scope and short** — 1,744 chars (1825) to 5,560 (1994), with only 1–10
  UK/Britain mentions each. 1965's article mentions the UK 10 times; 1963's, twice.
- **`Timeline of United Kingdom railway history` — does not exist.**
- **`Category:Years in rail transport` — does not exist.**
- `History of rail transport in Great Britain`, `Beeching cuts`, `Big Four (British railway
  companies)`, `List of early British railway companies` all exist as prose articles.

**Conclusion on prose sources: too thin and too global to drive year selection.** Feeding
Claude "1963 in rail transport" would yield a blurb built on two UK sentences — exactly the kind
of confident-but-hollow output that gets a history feature in trouble.

### The approach I'd actually propose

**Let the data nominate the years, and use prose only to describe them.** We already have, from
this investigation, two independent per-year event series covering 1830–2026:

1. OHM line openings/closures per year (from `start_date`/`end_date`)
2. Wikipedia station opening/closure category sizes per year (already fetched, exact counts)

A year becomes a candidate when it spikes in either series. That is a purely statistical
selection with no interpretation, and it surfaces the right years without anyone needing to know
rail history. Rough candidate volume at a "notably above trend" threshold: **25–40 candidate
years** across the full range — 15 years already clear 150 station closures on their own
(1964, 1965, 1962, 1966, 1917, 1951, 1959, 1930, 1952, 1960, 1963, 1958, 1955, 1968, 1953), and
the opening series adds a distinct 1840s–1860s cluster (1848, 1849, 1847, 1863, 1866).

Then, following the `api/spotlight.js` pattern: pull the candidate year's Wikipedia context,
have Claude draft a 1–2 sentence blurb **grounded in that fetched text**, and write it to a
staging field — **never auto-publish**. Given that the stakes here are higher than the locomotive
spotlight (a wrong hex code is cosmetic; a wrong claim about the Beeching Axe is embarrassing and
quotable), I'd go further than the spotlight pattern and make the review gate explicit in the
data: a `reviewed: false` field that the map refuses to render, so an unreviewed blurb cannot
reach the page through an oversight rather than a decision.

### Do the candidates cluster around your chosen snap-points?

Partially — and the mismatches are informative:

| Snap-point | Data support | Note |
|---:|---|---|
| **1825** | Weak in the data (93 ways alive) | Historically essential, statistically invisible. **Keep it, but it is a story point, not a data peak.** |
| **1845** | **Strong** | Sits right inside the Railway Mania opening peak (1847–49 are the true maxima) |
| **1880** | Moderate | No particular spike; a reasonable "network mature" waypoint |
| **1923** | **Strong** | Grouping — and OHM's peak-network year in our own numbers |
| **1965** | **Strong** | Second-highest closure year for stations, peak 5-year window for lines |
| **1994** | Moderate | Privatisation; visible in our data only as the modern-band boundary |

**Two adjustments worth considering.** The opening peak is genuinely **1847–1849**, not 1845 — if
snap-points are meant to land on maximal visual change, 1848 is the better anchor. And **1962–1966
is a four-year plateau**, not a 1965 point; 1964 is the single biggest station-closure year (565)
while 1965 is the biggest line-closure window. Whether to move these is a design call about
whether snap-points mark *famous* years or *maximal-change* years — those are not the same set,
and I'd rather flag the tension than pick for you.

---

## 4. Proposed schema (proposal only — nothing written)

### Lines

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [[lng, lat], ...] },
  "properties": {
    "start_year": 1841,          // int|null — from OHM start_date, ^(\d{4}) prefix
    "end_year": null,            // int|null — null = still open
    "era_band": "pre1923",       // pre1923 | big4 | br | modern  (see note below)
    "company_name": "Great Western Railway",  // string|null
    "company_source": "ohm_operator",         // ohm_operator | ohm_name | era_default | null
    "date_confidence": "exact",  // exact | year_only | unknown | mapper_flagged
    "ohm_way_id": 198168331,     // provenance; NOT an OSM id, separate database
    "railway_kind": "rail"       // rail | narrow_gauge | tram | subway | light_rail | preserved
  }
}
```

Four schema notes, each driven by something found above:

- **`era_band` cannot be a single value per feature.** A line built in 1841 and closed in 1965
  exists in three of your four bands. Storing one band per feature would silently drop it from
  the others. Either compute band membership at render time from `start_year`/`end_year`, or emit
  the feature once per band it survives into. I'd recommend the former and treating `era_band`
  as a *rendering* concept that never touches the data file.
- **`company_source` is not optional bookkeeping.** Given only 7% of ways have a real `operator`
  and 28.7% have a company-ish `name`, the UI needs to know whether it is showing a mapped fact,
  a string scraped from a line name, or an era default — because the honest popup text differs
  in each case.
- **`date_confidence`** distinguishes the 12,674 features with a full ISO date, the 3,941 with a
  bare year, the 875 a mapper explicitly flagged unknown via `fixme:start_date`, and the rest.
  Collapsing these loses the one thing that lets the UI be honest about gaps.
- **`ohm_way_id` must be labelled as OHM.** See §5 — these are not OSM ids and a future reader
  will assume they are.

### Stations

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [lng, lat] },
  "properties": {
    "name": "Aberdare Low Level railway station",
    "start_year": 1846,
    "end_year": 1964,            // null = still open
    "source": "wikipedia_category",  // ohm | wikipedia_category
    "wikidata_qid": "Q4667079",  // coordinate provenance for wikipedia-sourced records
    "crs": null                  // string|null — only ever set for still-open stations
  }
}
```

`crs` is deliberately nullable and expected to be null for the overwhelming majority. Closed
stations have no CRS code and never will; forcing one would be inventing data. It exists only as
the join back to `stations-content.json` for stations that are still open.

### Conflicts with our existing structures — flagged

1. **`data/operator-colors.json` has no historical vocabulary.** Its `toc` keys are modern ATOC
   codes (`GW`, `VT`, `SW`), plus `metro`/`tfl_lines`/`heritage`. Nothing in it can colour a
   Great Western Railway line in 1880 or an LMS line in 1935 — the *name* "Great Western Railway"
   collides across eras while referring to two different companies (a collision this repo has
   already been bitten by: see `operators-content.json`'s `_notes` on GW's `wikipedia_title`
   pointing at the historic 1833–1947 company). **Historic company colours need their own
   namespace, not new keys in the existing `toc` block.**
2. **CLAUDE.md reserves turquoise `--t` and forbids the literal `--a` amber for operators.** Any
   historic palette inherits those constraints.
3. **Our segment graph's `operators` values are codes; OHM's are display names.** Same conceptual
   field, two different key spaces — the same split that already exists between the `toc` bucket
   (codes) and the `metro` bucket (names) in `operator-colors.json`, so there is precedent for
   handling it, but it should be a deliberate decision rather than a discovery at build time.
4. **`era_band` has no equivalent anywhere in the current data.** Nothing existing is
   time-aware; every current file describes "now".

---

## 5. Modern-era (1994–2025) reuse — yes, and here's why

### Reuse ours. Do not source the modern band from OHM.

`scripts/output/line-segments.json` (generated 2026-07-15, national scope) holds **5,371 segments
over 21,710 km**, derived from **61,905 OSM ways** across 1,145 route relations, with operator
attribution already solved per segment (histogram: 4,259 segments single-operator, 1,089 with
two, and a tail to six).

Three independent reasons OHM cannot serve the modern band:

1. **Attribution.** Ours is complete and canonical; OHM's is 7% and has no modern TOCs to speak of.
2. **Light rail is missing from OHM.** Of OHM's "still open in 2025" set: 17,285 km `rail` but
   only **165 km `subway`, 44 km `tram`, 5 `narrow_gauge` ways and 7 `light_rail` ways**. We just
   spent a pass adding ten metro/light-rail systems to the database; OHM would render essentially
   none of them.
3. **Granularity.** OHM averages 18.7 nodes/way and its long ways run 86–439 m per node (the
   142.5 km Heart of Wales Line way has 905 nodes = 157 m/node). Our graph is ~50 m/node
   (436,094 nodes over 21,710 km) — **3–9× finer.**

### The 1994 join — recommended strategy

**Do not merge the files. Butt them together and switch sources at the boundary.**

There is no shared identifier to merge on: **OHM way ids and OSM way ids are separate databases
that happen to use the same integer range.** OHM way `198168331` and OSM way `198168331` are
unrelated. Nothing in the OHM tag set cross-references OSM — I checked every key on all 13,454
linear ways, and the only semantic join available is `wikidata`, present on 632 ways (4.7%), which
our segment graph doesn't carry either. **Any id-based merge would silently produce garbage.**

Proposed join:

- **Slider year ≥ 1994 → render our segment graph exclusively.** Full modern operator colouring,
  light rail included, existing pipeline untouched.
- **Slider year < 1994 → render the OHM historical layer exclusively.**
- **At the boundary, cross-fade rather than hard-cut.** The two layers are different linework;
  a hard swap will visibly twitch.
- **Never render both at once.** The overlap is ~17,500 km of the same physical railway drawn
  twice at different vertex densities — it would double-draw every still-open line.

### Is the geometry consistent enough for that to look clean?

I measured it rather than guessing. For three lines open in both datasets, sampling OHM vertices
and finding the nearest vertex in our segment graph:

| Line | samples | median offset | p90 | max |
|---|---:|---:|---:|---:|
| Vale of Glamorgan Line | 246 | **10 m** | 34 m | 3,009 m |
| Heart of Wales Line | 227 | **19 m** | 88 m | 344 m |
| East Coast Main Line | 381 | **19 m** | 42 m | 148 m |

**Positionally the two datasets agree.** A 10–19 m median offset is well within rail-corridor
width — they are tracing the same real alignment, and OHM is not misplaced, just coarsely sampled.
At national and regional zoom the cross-fade will be invisible. At high zoom the vertex-density
difference will show as slight corner-cutting on curves in the historical layer.

**One flagged anomaly:** the 3,009 m maximum on the Vale of Glamorgan Line means OHM has a
stretch of that line somewhere our segment graph does not (or on a materially different
alignment). I did not chase it down. It is a single outlier against a 10 m median, so it does not
change the recommendation, but **it should be looked at before trusting any automated
OHM↔ours geometry reconciliation** — a naive nearest-neighbour matcher would silently pair those
two features.

---

## Caveats that apply to every number here

1. **The bbox is not GB.** `49.86,-8.65 → 60.86,1.77` includes the whole island of Ireland
   (**629 railway ways**, ~4.6% of the count), so Northern Irish and Republic of Ireland features
   are in every figure above. Irish operators are visibly present in the `operator` values
   (`Irish Rail`, `CIÉ`, `Great Southern Railways`). The build pipeline needs a real GB boundary
   clip, or at minimum a country filter — **a bbox will not do.**
2. **OHM is a live wiki.** Every count is a snapshot at `2026-07-25T19:40Z` and will drift.
   Coverage is also actively improving, so the station picture in particular may be better in a
   year.
3. **I did not verify OHM's dates against any external source.** "86.7% have a start_date" is a
   completeness measure, not an accuracy one. The aggregate length curve tracking known history
   (§1b) is indirect evidence of accuracy, not proof of it.
4. **The `*:edtf` tags were not inspected** for disagreement with the plain date tags (282 + 200
   ways).
5. **Real-world reference figures** (37,720 km peak, 5,000 mi / 2,363 stations in the 1963
   report, 25 mi Stockton & Darlington) are quoted from Wikipedia's `Beeching cuts` and
   `History of rail transport in Great Britain`, fetched during this investigation. Today's
   ~2,570 open stations and ~15,800 route km are from general knowledge and **were not verified
   against a source in this pass.**
6. **Nothing here was written to any data file.** The raw query outputs live in the session
   scratchpad (`ohm/gb-railway-ways-tags.json`, `ohm/gb-railway-geom.json` (21 MB),
   `ohm/gb-stations-tags.json`, `wiki-station-year-cats.json`) and will be lost when the session
   ends — say the word if any of them should be preserved before then.

---

## Open questions for you

1. **Company naming for 1923–1994** — accept a hand-built Big Four/BR table (small, closed
   vocabulary), or drop company naming entirely for those bands and show only the line name?
2. **Station backfill** — build the Wikipedia+Wikidata pipeline, or ship with OHM-only stations
   and accept that Beeching will look understated?
3. **Snap-points** — keep the famous years (1845, 1965), or move to the maximal-change years
   (1848, 1964)?
4. **Undated features** — hide the 1,784 undated line ways, show them in every era, or show them
   in a distinct "date unknown" style? The 875 mapper-flagged ones arguably deserve different
   treatment from the genuinely unexamined ones.
5. **Segment graph output format** — `LINE-COLORING-RUNBOOK.md` still has the hosting/format
   decision open for the modern segment graph. The historical layer is a second large geometry
   file with the same question, and it would be worth answering both together rather than twice.

---
---

# Phase 1B — remaining investigation + reproducibility

**Status:** findings only. One script added (`scripts/scope-ohm-coverage.mjs`), this document
appended to. No pipeline built, no map code, nothing committed.
**Date:** 2026-07-25
**Phase 1 above is unchanged.** Where 1B supersedes a Phase 1 number, it says so explicitly.

Locked decisions from the Phase 1 review are treated as settled and are not re-argued here. Two
of them turn out to have data-shaped consequences that need flagging before build — the `era_band`
field (§1B-6) and the `big4` colour band (§1B-4). Both are flagged as constraints to design
around, not as reopened questions.

## What changed since Phase 1

| | Phase 1 | Phase 1B | Effect |
|---|---|---|---|
| Station **opening** dates | not assessed | **97.6% of currently-open stations resolve deterministically** | The station story is largely solved, not weak |
| Stations needing line-inheritance | assumed many | **82 total** (63 current + 19 historical) | `date_precision: "inferred"` is a rounding error, not a mode |
| OHM licence | assumed CC0 | **CC0 confirmed, but 14% of GB ways are CC-BY (NLS)** | Attribution now required |
| Big Four lookup | "probably needs hand-curation" | **auto-parses in one pass — and still doesn't solve it** | The bottleneck was never the lookup |
| GB clip | "needs a boundary" | **OHM's own CC0 boundaries work** | No cross-licence contamination |

---

## 1B-1. Reproducibility — `scripts/scope-ohm-coverage.mjs`

Added, following the existing `scope-` prefix convention (it is a scoping/report pass that writes
nothing but its own report, exactly like `scripts/scope-wikipedia-coverage.mjs`). Not `fetch-`
(those populate content files) and not `build-` (those produce pipeline artefacts).

```
node scripts/scope-ohm-coverage.mjs            # counts + tag census, ~20s
GEOMETRY=1 node scripts/scope-ohm-coverage.mjs # adds the km-by-era census (~21 MB, slow)
BBOX=1 node scripts/scope-ohm-coverage.mjs     # reproduce Phase 1's exact figures
```

Writes `scripts/output/ohm-coverage-report.{json,md}`. It holds all ten census queries with a
comment on each explaining what it returns and which Phase 1 finding it tracks, so the quarterly
refresh is a single command rather than a reconstruction exercise.

**Verified by running it** (GB-clipped, count mode). The generated report files were then deleted
so this phase's deliverable stays exactly one script plus this document — re-run the command above
to regenerate them.

Three things built in deliberately:

- **The geometry dump is opt-in.** Per instruction it was not re-run; the queries are saved and
  gated behind `GEOMETRY=1`.
- **A stale-boundary assertion.** If OHM splits or replaces the England/Scotland/Wales relations,
  the area clip returns *zero features rather than an error*. The script throws instead of writing
  a report full of confident zeroes.
- **A licence gate.** The census re-checks every `license=*` value on each run and flags anything
  outside the two known-good values as a blocker. See §1B-3 for why this is not paranoia.

**Fresh GB-clipped baseline** (2026-07-25, supersedes Phase 1's bbox figures for extract purposes):

| | GB clip | Phase 1 bbox | Δ |
|---|---:|---:|---:|
| railway ways | 13,122 | 13,655 | −533 |
| linear track ways | 12,935 | 13,454 | −519 |
| with `start_date` | 11,152 (86.2%) | 11,661 (86.7%) | |
| with `end_date` | 5,328 (41.2%) | 5,670 (42.1%) | |
| undated | 1,774 (13.7%) | 1,784 (13.3%) | |
| with `operator` | 931 | 944 | |
| closures 1963–70 | 2,625 | 2,662 | |
| station elements | 1,361 | 1,395 | −34 |

The clip removes ~4% of features and moves no percentage by more than a point — Phase 1's
conclusions all survive the correction.

---

## 1B-2. Station opening dates — the gap closed

Phase 1 assessed closures only. This is the better half of the story.

### The category source is real and verified

Rather than assuming the title pattern, I enumerated the parent categories:

- **`Category:Railway stations in Great Britain by year of opening`** — **202** year
  subcategories, **1812–2026**, every one matching `…opened in YYYY` exactly, zero deviations.
- **`Category:Railway stations in Great Britain by year of closing`** — note **"closing"**, not
  "closure" — **177** subcategories, **1834–2019**.

Phase 1's 1830 start year was too late; the opening series begins at 1812. Corrected totals:
**10,666 opening memberships** and **7,204 closing memberships**.

### Coverage of currently-open stations — the number that matters

Matched via `stations-content.json`'s curated `wikipedia_title` (present for 2,571 of 2,629
stations), resolved through Wikipedia's redirect table so our titles compare against the canonical
titles the categories actually list:

| | stations | |
|---|---:|---:|
| Total in `station-list.json` / `stations-content.json` | 2,629 | |
| have a `wikipedia_title` | 2,571 | 97.8% |
| **→ found in an opening-year category** | **2,566** | **97.6%** |
| → have a title but no opening category | 5 | |
| have no `wikipedia_title` at all | 58 | |
| **→ no opening date, needs line-inheritance fallback** | **63** | **2.4%** |

**97.6% of the current network gets an exact opening year with no AI, no prose extraction and no
inference.** The five title-but-no-category cases are Carfin, Llangennech, Levenshulme,
Wolsingham and Southsea Hoverport (the last being a hovercraft terminal, not a railway station —
a data-quality curiosity in our own station list, not Wikipedia's).

### The full historical universe

| | stations |
|---|---:|
| distinct articles with an **opening** year | 9,402 |
| distinct articles with a **closing** year | 6,599 |
| **union — total distinct stations** | **9,421** |
| both dates (fully bounded) | 6,580 |
| opening only | 2,822 |
| **closing only (start_year must be inferred)** | **19** |

So **line-inheritance is needed for 82 stations in total** — 63 currently-open plus 19 historical
— out of 9,421. Phase 1 anticipated this as a significant fallback mode; it is a rounding error.

For scale against Phase 1's OHM figures: **9,421 stations vs OHM's 1,395**, and Wikipedia's
Beeching-window closures (3,378) against OHM's 426.

### Geolocatability — checked on all 9,402, not sampled

| | | |
|---|---:|---:|
| Wikipedia page carries `coordinates` | 2,090 | 22.2% |
| has a Wikidata item | 9,232 | 98.2% |
| …of those, Wikidata has **P625** | 9,179 | 99.4% |
| **geolocatable end to end** | **9,179 of 9,402** | **97.6%** |

Identical to the 1964-closure sample in Phase 1 (94%), now confirmed across the whole set. The
split of responsibilities holds: **the year comes from the category name, the coordinates come
from Wikidata P625, and Wikidata's own date properties are ignored** (P571 inception 7%, P576
dissolved 1.5% — useless, as Phase 1 found).

### Two failure modes found — both would ship silently

**(a) 421 currently-open stations also appear in a closure category.** Alloa, Aigburth, Ardrossan
Town, Althorpe, Ambergate and 416 others closed and later reopened. A naive "latest closing year
wins" read **would retire 421 stations that are demonstrably open today** — they would vanish from
the map somewhere in the 1960s and never come back. This is the single most likely bug in the
whole station pipeline, and it is invisible unless specifically tested for.

**Fix:** `station-list.json` is authoritative for "open right now" (it is NaPTAN-derived). If a
station is in it, `end_year` is null regardless of any closure category. Closure categories are
only ever consulted for stations *absent* from that file.

**(b) 678 stations have an opening year, no closure category, and are not in our current station
list.** Defaulting `end_year = null` would assert "still open" on no evidence and leave them on
the map permanently. These are some mix of heritage/preserved stations, Northern Irish stations
(the GB categories are not perfectly policed), and genuinely closed stations whose closure year
was never categorised. **Not resolved — flagged.** Cheapest honest treatment is a third state
(`end_year: null` + `date_precision: "unknown"`) rendered distinctly, rather than silently
asserting either open or closed.

### Year distribution

Openings cluster exactly where the history says they should — 1840s (1,580), 1860s (1,667),
1850s (1,260) — with a secondary 1900s bump (924) and a modern reopening wave in the 1980s–90s
(245, 234). Peak years: 1848 (358), 1849 (246), 1847 (238), 1863 (229).

---

## 1B-3. OHM licence — confirmed, with a caveat that matters

### The default is CC0, and commercial use is fine

Confirmed from OHM's own copyright policy, not assumed:

> "OpenHistoricalMap strives to dedicate as much of its contents as possible to the public domain
> under a Creative Commons CC0 dedication."

and explicitly distinguishing itself from OSM:

> "You may freely use OHM data inside OSM or any other project, whereas the reverse is not
> necessarily true."

**CC0 permits commercial use with no restrictions and requires no attribution.** OHM is *not*
ODbL. The Overpass API's own response header independently states the same: *"The data is made
available under CC0."* For a site with planned monetisation, this is the clean outcome.

### But CC0 is a default, not a guarantee — and GB has a real exception

OHM's policy permits contributors to override the default per element with a `license=*` tag.
**In GB, 1,898 railway elements do exactly that:**

| `license=*` value | elements |
|---|---:|
| `CC-BY (NLS): Reproduced with the permission of the National Library of Scotland` | 1,898 |
| `CC0` (explicit) | 485 |
| everything else | none |

These are ways traced from the National Library of Scotland's historic Ordnance Survey sheets.
**CC-BY requires attribution.** No `attribution=*` tag is present anywhere, so the licence string
itself carries the required wording.

**Scale — smaller than the count suggests.** The NLS ways are 14.0% of ways but only **2.1% of
km** (709 km of 33,385) because they are short, detailed features — station throats, yards,
sidings. Their share of the network alive at each snap-point is ~2.2% and never exceeds it.
Two-thirds sit in Scotland (66.7% north of 55°N, against 50.4% for ways generally), consistent
with an NLS-sourced tracing effort.

### What this means practically

1. **No blocker.** CC-BY is commercially usable. Nothing found is NC or ShareAlike — I swept
   every `license=*` value across all fetched GB elements (ways, stations, relations) to confirm.
2. **Attribution is required** and must appear wherever historical lines render. Proposed wording,
   using NLS's own required phrasing:
   > © OpenHistoricalMap contributors (CC0) · Some historical linework reproduced with the
   > permission of the National Library of Scotland (CC BY)
3. **`license` must be carried through the pipeline as a per-feature field**, not checked once and
   discarded. This is the actionable finding: a future contributor could add a CC-BY-NC element,
   and without a per-feature licence the pipeline would absorb it invisibly. `scope-ohm-coverage.mjs`
   flags unexpected values on every run, but that is a detector, not a filter — **the extract step
   should refuse or exclude any element whose licence is not on an allow-list.**

**Flagged as unresolved:** I confirmed the licence from OHM's copyright policy page as mirrored on
the OSM wiki. `openhistoricalmap.org/copyright` itself returned HTTP 403 to automated fetching, so
the primary-source page was not read directly. The wiki page is OHM's own documented policy and
the API response corroborates it, but **if this needs to be airtight for a commercial launch, have
a human open that URL in a browser and confirm the wording matches.**

---

## 1B-4. Big Four attribution — the lookup is easy, and it is not the problem

### Building the lookup is trivial

The `Railways Act 1921` article's `=== Groups ===` section is **four clean wikitables**, one per
group, split into "Constituent companies (amalgamated)" and "Subsidiary companies (absorbed)",
every entry a `* [[Wikilink]]`. I parsed all four automatically in a single pass — **no manual
transcription needed**:

| Group | constituents | subsidiaries | total |
|---|---:|---:|---:|
| Southern (SR) | 5 | 14 | 19 |
| Western (GWR) | 7 | 26 | 33 |
| North Western/Midland/West Scottish (LMS) | 8 | 27 | 35 |
| North Eastern/Eastern/East Scottish (LNER) | 7 | 26 | 33 |
| **Total** | **27** | **93** | **120** |

Four companion articles (`List of constituents of the …`) add deeper absorbed-company trees,
taking the lookup to **340 entries**, also auto-parsed.

### The cross-check says it doesn't work

Against OHM's pre-1923 ways carrying a company-like name (3,522 ways, 394 distinct names):

| Lookup | ways matched | % of company-named | % of ALL pre-1923 ways | distinct names matched |
|---|---:|---:|---:|---:|
| Act 1921 schedule (120) | 543 | 15.4% | 4.8% | 48 of 394 (12.2%) |
| + constituent lists (340) | 1,215 | **34.5%** | **10.8%** | 125 of 394 (31.7%) |

**Why it fails is structural, not fixable by a bigger lookup.** OHM names a line after the company
that *built* it, and most of those companies were swallowed decades before 1923. The Act's
schedule only names companies still independent in 1922. The stubborn unmatched names make this
obvious:

- *Glasgow, Paisley and Greenock Railway* (178 ways) — absorbed by the Caledonian in 1847
- *Manchester and Leeds Railway* (75) — became the Lancashire & Yorkshire in 1847
- *Aberdeen Railway* (128), *Scottish Central Railway* (152) — both into the Caledonian by 1866
- *Formartine and Buchan Railway* (175) — Great North of Scotland, 1866

Resolving these needs a **transitive successor chain** (built-by → absorbed-by → … → 1923 group).
Wikidata partially supports this — of five stubborn cases tested, three carried a successor
property (`merged into` / `replaced by` / `followed by`) and **two carried none at all**. So even
a chain-walking approach dead-ends unpredictably.

### The ceiling nobody can raise

The decisive number. Of the network **alive during the big4 band (1923–1947)** — 10,889 ways,
31,667 km:

| | share of km |
|---|---:|
| carries any `name` | 62.1% |
| carries a **company-like** name | **30.4%** |
| carries `operator` | 772 ways (~7%) |

**Even a perfect, complete constituent→group lookup could colour at most 30.4% of the band by
length**, because 69.6% of the km carries no company name to map in the first place.

### What this means for the locked `big4` band

Not reopening the four-band decision — but the band as specified will render **roughly 70%
uncoloured**, and that should be a deliberate design choice rather than a launch-day surprise.
Three ways to live with it, in my order of preference:

1. **Show the band, colour what resolves, style the rest as "company unknown".** Honest, needs the
   `company_name: null` + `source` fields already in the schema, no extra sourcing.
2. **Colour the big4 band by a single neutral colour like the `br` band**, and use the four
   company colours only in popups where a name *is* known. Visually consistent; loses the "four
   companies" map effect that presumably motivated the band.
3. **Source Big Four territory from a boundary/territory map rather than per-line attribution.**
   Would colour 100% of the band, but it is a genuinely different (and much larger) sourcing
   exercise, and territory ≠ ownership at the line level.

**Recommendation: option 1**, with the caveat that if the uncoloured share reads badly in practice,
option 2 is a small change on top of the same data. Not decided here.

The `br` band (1948–1994) has no such problem — it is a single colour for a single nationalised
operator, so **no attribution lookup is needed at all**, which is why British Railways being
absent from OHM's tags (Phase 1) turns out not to matter.

---

## 1B-5. GB-only clip

**Recommended: OHM's own current England / Scotland / Wales boundary relations.**

| | relation | Overpass area id |
|---|---:|---:|
| England | 2874395 | 3602874395 |
| Scotland | 2874396 | 3602874396 |
| Wales | 2697730 | 3602697730 |

**Tested and working** — 13,122 railway ways against the bbox's 13,655, cleanly dropping the Irish,
Northern Irish and Channel/continental features. Implemented in `scripts/scope-ohm-coverage.mjs`.

**Why this source over the obvious alternatives:**

- **An OSM boundary relation is ODbL.** Using an ODbL database to spatially filter another dataset
  arguably produces a *Derivative Database*, which would drag share-alike obligations onto output
  that is otherwise CC0. Genuinely ambiguous — and not an argument worth having when a CC0 source
  exists. **Avoid.**
- **OS Boundary-Line is OGL v3** — commercial use permitted, attribution required
  ("Contains OS data © Crown copyright and database right {year}"). Perfectly usable, but needs a
  download, an OSGB36→WGS84 reprojection, and a second attribution line.
- **Natural Earth is public domain** but far too coarse for a coastline clip at this scale.
- **OHM's own boundaries are CC0**, in the same database, queryable in the same request, and add
  no attribution obligation. The whole pipeline stays inside one licence.

**Two caveats.** OHM's boundary relations are themselves dated; I deliberately selected the
*current* (no `end_date`) polygons and would fix them for all eras — clipping 1923 data to 1923
borders would make lines blink in and out as historical borders moved under them. And a renamed or
split relation id returns **zero features rather than an error**, which is why the script asserts
on a zero result.

---

## 1B-6. Updated schema proposal (report only)

### Lines

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [[lng, lat], ...] },
  "properties": {
    "start_year": 1841,
    "end_year": null,                    // null = still open
    "company_name": "Great Western Railway",  // null when unresolved
    "source": "ohm:way/198168331",       // see provenance note below
    "date_precision": "exact",           // exact | inferred | unknown
    "license": "CC0"                     // REQUIRED — see §1B-3
  }
}
```

### Stations

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [lng, lat] },
  "properties": {
    "name": "Aberdare Low Level railway station",
    "start_year": 1846,
    "end_year": 1964,                    // null = still open
    "source": "wikipedia:Category:Railway stations in Great Britain opened in 1846",
    "date_precision": "exact",
    "wikidata_qid": "Q4667079"           // coordinate provenance
  }
}
```

### Notable years

```jsonc
{
  "year": 1963,
  "blurb": "…",
  "source": "wikipedia:Beeching cuts",
  "reviewed": false                      // map MUST refuse to render unless true
}
```

### `date_precision` — needs a tighter definition than three words

The field is user-facing, so it has to mean something defensible. Proposed:

| value | lines | stations |
|---|---|---|
| `exact` | `start_date` present in OHM (66.6% full ISO date, 20.0% year-only — both count as exact *to the year*, which is all the slider resolves) | year taken directly from a Wikipedia year-category name |
| `inferred` | not applicable — see below | opening year inherited from the line the station sits on (**82 records**) |
| `unknown` | undated; **hidden** per the locked decision (13.3%) | in a category but with an unresolvable date, or the 678 ambiguous "no closure recorded" cases |

**Flag: `inferred` has no meaning for lines.** The locked spec lists `date_precision` on both, but
line dates are either present in OHM or the feature is hidden — there is no inheritance mechanism
for a line. Options: keep the field on lines with only `exact`/`unknown` ever used (consistent
shape, one dead value), or omit it from lines entirely (honest, asymmetric). **I would keep it**,
for a uniform property shape across both layers, and document that `inferred` is stations-only.

**Flag: "exact" is ambiguous between "exact year" and "exact date".** Two thirds of OHM line dates
are full `YYYY-MM-DD` and a fifth are year-only. Since the slider resolves to years, both are
exact *for this purpose* — but a user reading "exact" on a 1841 line may reasonably assume we know
the day. Recommend the UI phrase it as "recorded" vs "inferred" vs "unknown" rather than exposing
`exact` literally.

### `era_band` — do not store this per feature

Phase 1 flagged this; Phase 1B quantifies it, and the answer is emphatic. Of 11,661 dated line
ways:

| bands spanned | ways | |
|---:|---:|---:|
| 1 | 639 | 5.5% |
| 2 | 543 | 4.7% |
| 3 | 4,646 | 39.8% |
| 4 | 5,833 | 50.0% |
| **more than one** | **11,022** | **94.5%** |

**94.5% of dated lines exist in more than one era band, and half exist in all four.** A stored
`era_band` would be wrong for almost every feature in the dataset. Combined with the locked
decision that the slider is *continuous*, the band is a property of **the slider position**, not
of the feature: at render time, band = f(slider year), and each feature is drawn if
`start_year <= sliderYear < (end_year ?? ∞)`.

`era_band` is therefore **omitted from the proposed properties above.** This is the one place I
have departed from the field list as specified, and it is a correctness issue rather than a
preference — flagging it explicitly rather than silently complying or silently dropping it.

### `source` — one string, machine-parseable prefix

A "suggest a correction" flow needs to know *where* to send someone, so `source` should be a
resolvable pointer, not a vague label: `ohm:way/{id}`, `wikipedia:{page or category}`,
`wikidata:{qid}`, `srhq:line-segments` for the modern band. Prefix parses, remainder resolves to a
URL.

**`ohm:` must never be confused with `osm:`.** Phase 1's core join warning applies to the schema
itself: OHM and OSM ids share an integer range and are unrelated. Any bare `way_id` field would be
a trap; the prefix is the guard.

### Coexistence with existing structures — conflicts

1. **`data/operator-colors.json` must not gain historical keys.** Its `toc` block is keyed by
   modern ATOC codes. "Great Western Railway" as a 1923–1947 company and `GW` as today's operator
   are *different entities sharing a name* — a collision this repo has already been bitten by
   (see `operators-content.json`'s `_notes` on GW's `wikipedia_title` having pointed at the
   historic 1833–1947 company). **Recommend a separate `data/era-colors.json`** with four
   `big4` entries plus one `pre1923` neutral and one `br` Rail Blue. Six colours, its own
   namespace, zero risk to the modern palette.
2. **CLAUDE.md's palette rules still bind:** turquoise `--t` is reserved for UI meaning and must
   not be used for any era colour, and BR Rail Blue must be checked for collision against the
   existing TOC hues — `NT` (`#1310C9`/`#0F0D78`) and `SW` (`#2D4ED0`/`#24398C`) are both deep
   blues. They never render simultaneously with an era colour under the source-switch design, so
   this is a *consistency* concern rather than a legibility bug, but worth a deliberate check.
3. **The modern band keeps its own schema.** `line-segments.json` segments carry
   `operators`/`way_ids`/`length_m` and no dates; historical features carry dates and no operator
   codes. Under the locked source-switch-at-1994 design these two never need a common shape —
   **that is the point of the switch, and the schemas should be allowed to stay different** rather
   than forced into a shared one.
4. **Nothing existing is time-aware.** Every current data file describes "now". The historical
   layer is the first with a time dimension, and the `modern` band's upper bound must resolve to
   the **current year at runtime** per the locked decision — `scope-ohm-coverage.mjs` already uses
   `new Date().getUTCFullYear()` rather than a literal, and the map should too.

---

## Sources deliberately not used

Per instruction, **neither was accessed** — not downloaded, scraped, parsed, or derived from:

- **StopsGB** (British Library / Living with Machines) — stated licence **CC BY-NC-SA 4.0**. The
  non-commercial clause is incompatible with this site's planned monetisation, and ShareAlike
  would additionally propagate to derived output.
- **Michael Quick, *Railway Passenger Stations in Great Britain: a Chronology*** — the definitive
  station open/close reference.

Both would materially improve station date coverage — particularly the 678 ambiguous cases in
§1B-2 and the residual Beeching gap. **Recorded here as a future permission-seeking opportunity
only:** the Railway & Canal Historical Society (Quick) and the British Library (StopsGB) can be
approached for explicit permission or a commercial licence. That is a conversation, not a
pipeline, and nothing in the current design depends on it.

---

## Open questions for you — Phase 1B

1. **`big4` band coverage** (§1B-4) — accept ~70% "company unknown" and style it honestly
   (option 1), or drop to a single neutral colour for the band (option 2)?
2. **The 678 ambiguous stations** (§1B-2) — third visual state, or exclude them entirely?
3. **`era_band` removal from the schema** (§1B-6) — confirm you're happy it becomes a render-time
   computation, since it was listed as a stored field.
4. **OHM copyright primary source** (§1B-3) — worth a human opening `openhistoricalmap.org/copyright`
   in a browser before launch? It 403s to automated fetching, so I could not read it directly.
5. **Quarterly refresh cadence** — should `scope-ohm-coverage.mjs` fold into the existing
   station/operator content refresh documented in CLAUDE.md, or run on its own schedule?

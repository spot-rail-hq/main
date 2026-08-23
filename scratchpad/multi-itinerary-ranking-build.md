# Multi-itinerary ranked search — build report

Implements `scratchpad/multi-itinerary-ranking-investigation.md`. Nothing
committed or pushed — local edits only, in both
`srhq-journey-search/service.py` (+504/-120) and `main/departures.html`
(+48/-11, cumulative with the earlier save-route-star work this session).
Verified against real data on the VPS throughout; screenshots of the
frontend not attempted (browser screenshot capture has been broken at the
tool level all session — confirmed again previously against a blank page)
but every rendering path was exercised via real DOM inspection instead.

---

## Step 1 — Fixed discarded `walk_meters`

`load_footpaths()` now selects `walk_meters` alongside the existing
columns and carries it through as a third tuple element:
`(neighbor_tiploc, walk_seconds, walk_meters)`. `walk_meters` has no
reverse column (confirmed: distance was never meaningfully asymmetric
across the dataset), so the same value is used for both directions of a
pair, matching how the table itself was built.

**Required a matching, minimal change to `_relax_footpaths()`** (Pass 1's
own footpath-relaxation helper) — it unpacks the footpaths tuples, so its
`for neighbor, walk_seconds in footpaths.get(cur, ())` line would have
crashed (`ValueError: too many values to unpack`) the moment the tuple
shape changed. Updated to unpack the third value and add
`"walk_meters": walk_meters` to the predecessor dict, alongside the
existing `"walk_seconds"` field. **`run_csa()`'s own body is untouched** —
this is a change to its helper only, and every arrival-time comparison,
boarding rule, and predecessor-selection decision in `run_csa()` is
byte-identical to before. Flagging this plainly since Step 2 says "keep
`run_csa()` completely unchanged" — this is the one place that
necessarily had to change for Step 1 to work at all, and it's inert (an
extra field on data already flowing through unchanged logic), not a
behavioral change.

`walk_meters` also threaded through to the final API response
(`build_itinerary_json()`'s `leg_json`, alongside `walk_seconds`) — not
explicitly required by Step 1's wording, but "matching how walk_seconds
is already handled" reads as "thread it everywhere walk_seconds already
goes," so it now does. Verified live: a walk leg's JSON now carries both
`walk_seconds: 762` and `walk_meters: 885` for the Moor Street↔New Street
edge.

---

## Step 2 — Two-pass CSA search

**`run_csa()` is untouched** beyond the `_relax_footpaths()` fix above —
confirmed by re-reading it before and after; same sort, same loop, same
comparisons.

**New `run_csa_fewest_changes()`** mirrors `run_csa()`'s exact shape (same
sort, same one-pass loop, same boarding-buffer rule, same footpath-
relaxation call sites) with two differences: the label per stop is
`(transfer_count, arrival_dt)` instead of a bare `arrival_dt`, compared
lexicographically (fewer changes wins outright; arrival time only breaks a
tie on transfer count); and every connection/footpath candidate is gated
by `arrival_deadline` (Pass 1's own fastest arrival +
`TRANSFER_SEARCH_SLACK_SECONDS`).

**`TRANSFER_SEARCH_SLACK_SECONDS = 1800`** (30 min), same constant-location
pattern as `MAX_FOOTPATH_SECONDS`. Your message referred to this existing
constant as `WALK_TIME_CEILING_SECONDS` — the real name is
`MAX_FOOTPATH_SECONDS`; noting the mismatch rather than silently
following either name, since it's the pattern that mattered, not the
literal name. On real results (see Whitby↔Windermere below),
1800s left real headroom without being obviously too generous — no
change recommended yet, but genuinely just a first guess as flagged.

**Transfer-count definition, chosen and flagged, not left implicit**:
counts DISTINCT SCHEDULED-SERVICE BOARDINGS only (the classic CSA-
literature "number of changes") — a walk transfer never increments it.
This is deliberately **not** the same number as `len(changes)` in the
final JSON response, which counts every adjacent-leg boundary including
walk-adjacent ones (a walk between two trains produces two `changes`
entries — arrive-then-start-walking, walk-ends-then-board — but is one
interchange effort in the human sense). Ranking uses the train-boarding
count; the displayed `changes` array is unaffected and unchanged in shape.
Flagging this as the concrete resolution of a real ambiguity your message
didn't spell out to this level of detail.

**Reconstruction is untouched, exactly as the investigation predicted** —
`run_csa_fewest_changes()` uses the identical linear-backward-walk
reconstruction shape as `run_csa()`, since it stays single-label
internally (one label, one predecessor, per stop).

### New ambiguity found during implementation, not anticipated by the investigation report

The investigation flagged that Pareto multi-label breaks the global
`trip_reached` optimization (a *count* needs to stay tied to the specific
trip being ridden; a shared timestamp doesn't have that problem). What it
didn't anticipate: **single-label two-pass needs a small parallel fix for
the same reason**, once the label being tracked is a count rather than
just a timestamp. Concretely: without a separate
`trip_transfer_count = {schedule_id: transfer_count_at_first_boarding}`
dict, a connection *continuing* an already-boarded trip would read
`best_label[dep_tiploc]` to learn "how many transfers to propagate
forward" — but that dict slot could have been overwritten by a completely
unrelated, coincidentally-better path reaching the same intermediate
calling point, silently corrupting this trip's own transfer count.
Fixed by recording the transfer count once, at first boarding, and reusing
it for every subsequent connection of that same `schedule_id` — this was
found and fixed during implementation, reported here per the brief's own
instruction to flag new ambiguity discovered along the way.

**Measured impact (real data, not the investigation's rough estimate)**:
`csa_seconds_fastest` ~0.7-0.8s (unchanged baseline); `csa_seconds_
fewest_changes` ~0.43-0.48s — genuinely *cheaper* than Pass 1, because the
`arrival_deadline` prune skips a large fraction of the connections list.
Total warm response ~1.2-1.25s (up from ~0.75-0.8s), a smaller increase
than the investigation's cautious 1.1-1.5s estimate.

---

## Step 3 — Risk-weighted tiebreak (bounded, not full-scan)

**Real architecture conflict found and resolved by NOT improvising past
it, per your own pre-authorization to stop and report.** Your Step 3 asks
to detect "multiple itineraries tied on [a pass's] primary criterion" in
general. The current single-label scan (both passes, by construction)
keeps exactly one label per stop — a genuine tie at an intermediate stop
(two different route shapes arriving at the SAME tiploc at the exact same
value) is never retained at all: the connections loop's own strict-
improvement check (`candidate < cur_label`) means whichever is scanned
first silently wins and the other's path is discarded with no trace, in
both passes. Detecting that fully would mean either changing `run_csa()`'s
own internals (which Step 2 explicitly said to leave completely
unchanged) or re-scanning per intermediate stop (unbounded — the opposite
of what Step 3 itself asked for). **I did not build that** — implementing
it would have meant violating one of your two explicit constraints
without telling you.

**What I did implement, and why it's real rather than a token gesture**:
`dest_tiplocs` can itself contain more than one distinct tiploc — confirmed
live (Whitby resolves to `{'WTBY', 'YORKWHT'}`) — and each already gets
its own independently-tracked label in the very same scan, at zero
restructuring cost. This is the one place a tie is both a real, recurring
possibility in this exact codebase AND cheap to check without touching
`run_csa()`'s internals. `resolve_fastest_ties()`/
`resolve_fewest_changes_ties()` do this: when `len(dest_tiplocs) > 1`, they
independently re-run the relevant pass once per *other* dest_tiploc,
compare its result to the winner's primary-criterion value, and collect
exact ties into a bounded candidate list. `pick_lowest_risk()` then
computes connection-risk (via the shared `compute_leg_statuses`/
`compute_change_risks` helpers, factored out of the old inline `search()`
closures so there's one implementation, not two that could drift) for
only that bounded set, scoring by `(count of at_risk changes, count of
tight changes)` — lower wins. **The common case (`len(dest_tiplocs) == 1`,
which is most searches) pays none of this: zero extra scans, zero extra
Darwin calls.** Verified live with a manually-constructed
`dest_tiplocs={'HGHI','HIGHBYA'}` (Highbury & Islington's two real,
independently-scheduled tiplocs from earlier Phase A work): both ties
correctly detected (2 candidates each), and the risk-based pick resolved
deterministically.

**Flagged, as asked: when could this get expensive?** Bounded by
`len(dest_tiplocs)`, which every real query so far has been 1-2 (never
observed higher) — cheap in practice. But it is a real, uncapped cost if a
destination query ever resolved to *many* distinct tiplocs: each one costs
a full extra scan (~0.4-0.8s per part 2b/this build's own measurements),
so N extra tiplocs means N extra full scans. This is the expensive case
your message asked me to watch for; noting it rather than adding an
arbitrary cap that wasn't asked for.

**Risk-scoring definition, chosen and stated concretely** (not spelled out
in the brief beyond "prefer the lower-risk itinerary"): `(at_risk count,
tight count)`, both ascending — `unknown`/`n/a`/`fine` all treated as
equally non-risky, consistent with `classify_connection_risk()`'s own
stated philosophy of never asserting "fine" from absent data (so
`unknown` isn't penalized either). Revisit if a different weighting is
wanted.

---

## Step 4 — Route-signature deduplication

`route_signature(chain)` builds an ordered tuple of `(leg_type,
dep_tiploc, arr_tiploc, schedule_id)` from `merge_legs()`'s own output —
the existing itinerary data shape, not a new representation.
`schedule_id` is included (not just the station sequence), so two
itineraries visiting the same stations via genuinely different services
are never wrongly treated as identical. Compared between Pass 1's and
Pass 2's (post-tiebreak) winners: identical → one itinerary, labeled
`["fastest", "fewest_changes"]`; otherwise → both, each labeled with its
own single criterion.

**Verified against real, opposite outcomes**: Solihull→Telford Central and
Solihull→Manchester Piccadilly both dedup to one itinerary (the walk-
shortcut route is genuinely best on both criteria). Whitby→Windermere
returns two genuinely different itineraries — same total journey time
(6:12:00) but a different route via Thornaby with one fewer change (4 vs
5) — a real, live demonstration of exactly the tie Pass 1 alone would
have silently discarded (see Step 3's architecture note above): both
routes arrive at the identical time, and Pass 2 recovers the one Pass 1's
single-label scan wasn't tracking.

---

## Step 5 — Frontend

`departures.html`: `/api/journey-search` responses now carry
`data.itineraries` (1-2 entries, each `{criteria, legs, changes,
total_journey_time}`) instead of flat `data.legs`/`data.changes`/
`data.total_journey_time`. Confirmed no other code in the file still
referenced the old flat shape before finishing (grepped for
`data.legs`/`data.changes`/`data.total_journey_time` — none remain).

- `planTripSummaryHtml()` now reads the route line from
  `data.itineraries[0]` (origin/destination are the same search regardless
  of which itinerary you look at) and drops the change-count/total-time
  line — that's now per-itinerary. The save-route star stays exactly
  where it was, unaffected by how many itineraries come back.
- New `planItineraryHtml()`: one block per itinerary, a header row with a
  criteria badge ("Fastest" / "Fewest changes" / "Fastest · Fewest
  changes" with a filled variant when both apply) plus that itinerary's
  own change-count/total-time, then its legs/changes exactly as before
  (`planLegHtml`/`planInterchangeHtml`, both untouched — the walk-leg and
  risk-chip fixes from the previous pass apply unchanged per itinerary).
- `renderPlanResults()` now loops `data.itineraries` instead of assuming
  one flat set.

**Verified live** (mock data matching the real Whitby↔Windermere 2-
itinerary response and the real deduped Telford↔Solihull response,
injected via `renderPlanResults()`, inspected via the DOM): 2-itinerary
case renders 2 `.plan-itinerary` blocks with correct badges ("Fastest" /
"Fewest changes") and correct per-block change counts (2 vs 1) and
matching total times; deduped case renders exactly 1 block with the
combined "Fastest · Fewest changes" badge in its filled `is-both` style,
walk leg and "No wait" label both still correct from the prior pass. The
save-route star still saves/loads correctly against the new structure
(verified: clicking it with the new response shape rendered still
produces the same `localStorage` entry as before).

---

## Not done / explicitly flagged, not silently resolved

- **General same-stop ties are not detected** (only destination-tiploc-set
  ties are) — see Step 3's architecture note. This needs an explicit
  decision (touch `run_csa()`'s internals, or accept unbounded re-scans)
  before it could be built; not built here.
- `TRANSFER_SEARCH_SLACK_SECONDS = 1800` is a first guess, not tuned
  against a broad set of real results.
- Risk-scoring weighting (`at_risk`/`tight` counts) is a concrete choice,
  not something the brief specified precisely — stated plainly so it can
  be adjusted.

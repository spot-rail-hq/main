# General same-stop tie detection — build report

Implements `scratchpad/general-tie-detection-investigation.md`, superseding
Step 3's narrow destination-tiploc-only tiebreak. Local edit only,
`srhq-journey-search/service.py` (+254/-106) — not committed or pushed.

Per your instruction, **measured numbers first** — this is what determines
whether uncapped tracking is safe to ship.

---

## Step 2 — measured, not estimated

### Timing (real DB, warm where noted)

`run_csa()` (Pass 1) got meaningfully slower than the investigation's
abstract estimate predicted — flagging this divergence plainly:

| Case | Old baseline (pre-this-build) | With tie-tracking (measured) |
|---|---|---|
| Solihull → Moor St / Manchester (simple) | ~0.65-0.75s | **0.97-1.16s** |
| Whitby → Windermere | ~0.70s | **0.99-1.05s** |
| Woking → Waterloo (busy dest) | ~0.75s | **1.11-1.19s** |
| Waterloo → Exeter (busy origin, 6 ties) | untested before | **1.30s** |

**Real added cost: roughly +0.3 to +0.5s to Pass 1 alone** — bigger than
the investigation's "modest, tens-of-ms" guess. Likely cause (reasoned
after seeing the numbers, not before): every one of the ~500k+ connections
now goes through an extra function call (`_consider_arrival`) with two
comparisons instead of one, plus occasional list operations instead of
plain dict writes — Python's per-call overhead over that many iterations
adds up to real, measurable time, not the negligible constant-factor I'd
assumed. Full warm `search()` response times observed: **~1.2-2.0s** for
ordinary cases, **~3.1s** for Waterloo→Exeter specifically (that outlier is
mostly a disk cache-tier cost + Pass 2's own separate, unrelated
per-destination re-scan cost — see the asymmetry note below — not the new
tie-tracking itself).

### Candidate-set sizes (the number that actually matters for safety)

Ran `run_csa()` directly (bypassing risk-tiebreak/dedup) against 18 real
origin/destination pairs, including a deliberate stress case: **routes
into and out of London Waterloo**, confirmed live as the single busiest
station in the whole `schedules` table (~24,307 distinct schedules,
querried directly — Leeds, London Bridge, Liverpool Street, and Cardiff
Central follow close behind).

```
max candidate-set size observed across all 18 pairs: 6
(London Waterloo -> Exeter St Davids)
```

Most pairs: 1 candidate (no tie). Several genuine real ties found: Whitby→
Windermere (2, at a *different* depart time than previously tested — see
below), Reading→York (2), Crewe→Newcastle (2), Manchester Piccadilly→
Edinburgh (2), London Waterloo→Portsmouth Harbour (3), London Waterloo→
Exeter St Davids (**6**, the deliberate busy-interchange stress case).
**Confirmed correct, not just counted**: inspected all 6 Waterloo→Exeter
chains leg-by-leg — all chronologically valid, all start at the origin,
all end at the destination, and they represent two genuinely different
physical routes (via Salisbury/Westbury vs. via Yeovil/Honiton, arriving
within a minute of each other) each reachable via up to three different
tied early-London connecting trains. Real, useful alternatives, not noise.

**This is 6, against a circuit breaker of 1000 — roughly 166x headroom.**
Nothing close to pathological was observed even under a deliberately
adversarial busy-station stress test. Uncapped tracking looks safe in
practice at this network's real scale, based on what was actually measured
here (not a large-scale sweep — see the caveat in Step 4 below).

### `TIE_TOLERANCE_SECONDS = 120` — no change recommended

Real tie gaps observed cluster at 0-2 minutes (e.g. the Waterloo→Exeter
group's own internal ties were 1-2 minutes apart; the two physical routes
themselves were 1 minute apart). 120s comfortably covers what was actually
observed without an obvious reason, from this data, to move it up or down.

---

## Step 1 — implemented in `run_csa()` directly (Option A, confirmed)

- `predecessor[stop]` is now a list, not a single value; `earliest_arrival[stop]`
  stays a scalar throughout, confirmed not to reintroduce Pareto (a tie is
  two paths sharing one value, not two incomparable label values).
- `_consider_arrival()`: the shared three-way branch (strictly better /
  tied / worse), used by both the main connection loop and
  `_relax_footpaths()`, so both use identical tie logic.
- `run_csa()`'s return contract changed, as agreed: a list of every
  itinerary tied for best across `dest_tiplocs`, or `None`. `search()`'s
  Pass 1 call site updated accordingly.
- **`resolve_fastest_ties()` removed, not just left dead.** It's fully
  superseded: since every `dest_tiploc`'s true arrival is already computed
  in the same scan, checking which ones tie the true best is free now,
  confirmed live against the manually-constructed Highbury & Islington
  case (`{'HGHI', 'HIGHBYA'}`) — both tiplocs correctly found tied,
  entirely inside `run_csa()`, no external re-scan.
- Pass 2 (`run_csa_fewest_changes()`) is **unchanged**, per scope — it
  still uses the old, narrower per-destination-tiploc re-scan
  (`resolve_fewest_changes_ties()`). This is a real, deliberate asymmetry:
  Pass 2's tiebreak is still bounded by `len(dest_tiplocs)` extra full
  scans the way Pass 1's used to be, and this shows up directly in the
  Waterloo→Exeter timing above (`tiebreak_seconds_fewest_changes` = 0.59s,
  a full extra scan, since Waterloo has multiple tiplocs) — Pass 1's
  equivalent cost is now 0.02s. Flagging this plainly since it's a
  concrete, measured consequence of the scope boundary, not a defect.

### Circuit breaker: `TIE_CIRCUIT_BREAKER_LIMIT = 1000`

Bounds two things with one constant: a single stop's tied-list size
(checked in `_consider_arrival`) and total reconstruction work across
every tied itinerary (checked in `_reconstruct_all_chains`, incremented
once per predecessor-edge explored — a stronger, earlier bound than
capping only the final chain count, since work done is always ≥ chains
produced). **Reasoning**: the real observed maximum across every case
tested, including a deliberate busy-interchange stress test, was 6 — 1000
is ~166x that, generous enough to never interfere with any real result
seen so far, while still catching genuine runaway growth (a bug, a
walk-graph cycle, or a truly pathological interchange) at a scale that's
unambiguously not a normal answer.

**When it trips**: `TieCircuitBreaker` is raised (not caught silently
anywhere inside `run_csa()`), propagates up to `search()`, which catches
it specifically and returns `{"found": false, "error": "internal: ..."}`
— a distinct, diagnosable failure, never a partial or truncated
itinerary list. This was never actually triggered by anything in Step 2's
real testing.

### New ambiguity/bugs found during implementation, not anticipated by the investigation

**1. Allowing ties to re-trigger relaxation reopens an infinite-loop risk
the old code avoided by accident, not by design.** The pre-existing
`_relax_footpaths()` never re-queued a stop on an exact tie, purely
because it used strict `<` — equality never matched. Once ties are
tracked deliberately, a genuine hazard appears: the walking-transfer graph
has real, confirmed ~0-second round-trip pairs (co-located platforms).
Without a fix, two such stops could tie each other back and forth
forever. **Fixed two ways**: (a) `_consider_arrival` only reports "this is
worth propagating further" on a brand-new stop or a strict improvement to
the true minimum — never on a pure tie with the anchor unchanged, since a
pure tie can't discover anything the anchor's own already-triggered
relaxation didn't already cover; (b) origin-tiploc stops are never
touched by `_consider_arrival` at all (an origin's state is fixed by
`depart_after`, never something a walk should revise) — the old code got
this for free too (a real walk can never arrive strictly before
`depart_after`), but ties needed it made explicit, since a 0-second
round-trip back to an origin would otherwise both corrupt reconstruction
(a spurious predecessor entry on a stop that's supposed to have none) and
feed the same infinite-loop hazard.

**2. Reconstruction itself needed an independent cycle guard.** Even with
fix (1) bounding scan-time growth, nothing about the recorded tied-list
data structurally guarantees a predecessor chain can't loop back on
itself during RECONSTRUCTION specifically. Added a `visited` set, refused
on revisit, to `_reconstruct_all_chains()` — this makes reconstruction
provably terminating regardless of what the scan produced, independent of
(and in addition to) fix (1).

**3. Caught and fixed before ever running**: an early draft accidentally
added a `.reverse()` call to the new reconstruction output. The old
single-chain reconstruction built its chain backward (destination to
origin) and needed an explicit reverse; the new recursive version builds
each chain as `sub_chain + [c]` with the recursive call (into the earlier
stop) evaluated first, which already yields forward chronological order —
reversing it again would have silently produced backward, invalid chains.
Caught by tracing through the recursion by hand before testing, not by a
test failure — worth naming since it's exactly the kind of bug that would
have been very confusing to debug from its symptoms alone (times
appearing to run backward) if it had shipped.

---

## Step 3 — path reconstruction, confirmed generalized

`_reconstruct_all_chains()` explores every tie point along the *whole*
path, not just at the final destination — so a genuine tie at an
intermediate stop that later reconverges onto the same onward service
still produces distinct alternatives (exactly what the Waterloo→Exeter
case demonstrates: ties both at the Waterloo-area starting trains and,
independently, between the two whole different physical routings).

**One important limitation found and worth stating clearly, since it
affects how to read the existing Whitby↔Windermere result**: re-tested
the *exact* 08:00 Whitby query already used throughout this build, and
`run_csa()` alone now finds only **1** candidate there — not 2. Traced why:
the two known Whitby↔Windermere routes (via Darlington vs. via Thornaby→
Stockton→Hartlepool→Sunderland) reach Newcastle **17 minutes apart**
(11:35 vs 11:52), not tied by any reasonable tolerance — they only
coincidentally reconverge onto the *same* later train and arrive at the
final destination at the same overall time. That's a genuine, real
phenomenon, but it isn't a same-stop tie in Pass 1's own single-criterion
terms: it's Pass 2 (fewest-changes) deliberately accepting a *worse*
intermediate arrival in exchange for fewer changes, which happens to still
make the same connection. **General tie detection (this build) and the
two-pass system (the previous build) are two separate, complementary
mechanisms, not one subsuming the other** — the former finds genuine
within-criterion ties (confirmed real and common: Reading→York, Crewe→
Newcastle, Manchester→Edinburgh, Waterloo→Exeter, and — at a *different*
depart time, 09:00 rather than 08:00 — Whitby→Windermere itself); the
latter finds cross-criterion coincidences. `search()`'s existing
Pass-1-vs-Pass-2 comparison still supplies the Whitby 08:00 case's second
itinerary exactly as it did before this build, unaffected by any of this.

---

## Not done / explicitly flagged

- Pass 2 was not generalized the same way (out of scope, per the brief) —
  it keeps the narrower, more expensive per-destination-tiploc tiebreak,
  with a measured, real cost shown above.
- No large-scale sweep beyond the 18 pairs tested plus the deliberate
  busy-interchange stress case — real, but not exhaustive; if the busiest
  station's own tied-set size (6) turns out not to be representative of
  the true worst case across the whole network, that would only be found
  by testing more broadly than this report did.

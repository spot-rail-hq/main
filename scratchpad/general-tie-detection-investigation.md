# General same-stop tie detection — investigation

Investigate only, per the ask — no code changed, nothing committed.
Follows on from `scratchpad/multi-itinerary-ranking-build.md`'s Step 3,
which correctly stopped short of this rather than picking a silent
workaround.

---

## 1. What `run_csa()` would need to change

**New state**: today, `predecessor[stop]` holds exactly one connection —
the single winning path to that stop, overwritten destructively the
instant something strictly better is found (`c["arr_dt"] < cur_ea`, the
literal comparison in the loop). To detect a tie as it happens, that
overwrite needs to become a **decision**, made at the moment a candidate's
`arr_dt` matches (or falls within a tolerance of) the current best:
strictly better → replace and discard whatever was tracked before (it's
now dominated); within tie-tolerance of the current best → **keep both**,
not overwrite. So `predecessor[stop]` needs to become a small list of
tied predecessors, not a single dict value, and every connection touching
an already-reached stop needs a three-way outcome (strictly better / tied
/ worse) instead of today's two-way one (better / not).

**Does this reintroduce Pareto?** No — and this is worth being precise
about, since it's the real question underneath what you asked.
`earliest_arrival[stop]` (the scalar arrival-TIME value itself) does
**not** need to become a set. A tie is not two different, mutually non-
dominating label VALUES the way Pareto's `(arrival_time, transfer_count)`
pairs are — a tie is two different PATHS producing the exact same single
value. So there is still only one correct "best arrival time" per stop;
what changes is that more than one path can be recorded as achieving it.
This is a real, if smaller, expansion of the multi-label problem the
original investigation flagged for Pareto (per-stop state becomes a
collection rather than a scalar, and reconstruction has to walk more than
one chain), but it is **not** the dominance-check problem — there's no
comparison between incomparable criteria here, only an equality/tolerance
test on one already-scalar value. Cheaper and structurally simpler than
full Pareto, but not free.

**`trip_reached` is not at risk here**, unlike the transfer-count fix
needed in the two-pass build. That earlier bug was specifically about a
*count* that had to stay tied to a specific trip, read back from
`best_label[dep_tiploc]` for continuations. Tie-tracking only ever *writes*
to a stop's predecessor-list when arriving there; it never reads a stop's
tied-list back to decide boarding feasibility (that still only ever
consults the scalar `earliest_arrival[dep_tiploc]`, unchanged). So the
continuation-corruption hazard from Step 2 doesn't reappear here.

**A real open question, not resolved here**: "tie-worthy window" — exact
equality (mirrors what the destination-tiploc tiebreak already does), or
a small tolerance (e.g. a handful of seconds/a minute)? Exact equality is
simpler and matches the one precedent already in the codebase; a
tolerance window is arguably more useful (two paths 90 seconds apart are
still a real practical choice for a human) but reopens exactly the kind
of "how much slack is legitimate" question `TRANSFER_SEARCH_SLACK_SECONDS`
already represents elsewhere — at a very different, much smaller
magnitude. Flagging as a decision point, not deciding it.

---

## 2. Scope of the change

**Detecting ties requires new tracking inside the connection-scan loop
itself — there's no way around touching that loop.** Unlike the
destination-tiploc tiebreak (which cheated by re-running the whole scan
targeted at a single tiploc, external to `run_csa()`'s own body), a tie at
an *intermediate* stop can only be observed by watching every connection
as it's processed and comparing it to that stop's current best, in place.
There's no way to reconstruct that after the fact without re-deriving the
same internal state some other way.

**But "touches the loop" and "changes what Pass 1 returns" are genuinely
separable, and this is the real decision point:**

- **Option A — modify `run_csa()` in place.** Its body tracks tied lists
  internally and its return value becomes richer (e.g. `(chain,
  tied_alternatives)` instead of a bare `chain`/`None`). This changes Pass
  1's contract. In *this* codebase specifically, the blast radius is
  narrow — `run_csa()` has no external callers (`csa-router.py`, per its
  own module docstring, is a separate, parallel standalone script, not an
  importer of this file); the only real call sites are `search()`'s own
  Pass 1 call and `resolve_fastest_ties()`, both of which I wrote this
  session and could update in lockstep. But it's still a contract change,
  not an additive one: anything relying on "`run_csa()` returns a bare
  chain" — including a future reader of this file who hasn't seen this
  investigation — would need to know it no longer does.
- **Option B — a new sibling function**, exactly the shape
  `run_csa_fewest_changes()` already took: `run_csa()`'s own body stays
  **byte-for-byte identical**, and a new function (duplicating the scan
  loop, with tie-tracking added) is used wherever tie-detection is
  actually wanted. This keeps Pass 1's contract completely stable — zero
  risk to it — at the cost of a second near-copy of the core scan loop
  that could drift out of sync with `run_csa()` if one is ever bug-fixed
  and the other isn't.

Not deciding between these — flagging it, since it's exactly the kind of
choice you asked me to surface rather than resolve. Given this build's own
established pattern (Pass 2 was already built as a sibling, not a
modification) and the repeated instruction to leave `run_csa()` alone,
Option B is the path consistent with everything built so far — noted, not
assumed as the answer.

---

## 3. Where ties can actually occur

**Not hypothetical — checked directly against real data rather than
reasoned about in the abstract.** Ran the existing, already-built,
unmodified `search()` (Pass 1 + Pass 2 + Step 4's dedup) against 12 real
origin/destination pairs (2026-08-24 09:00), specifically choosing routes
through busy interchanges (Crewe, York, Reading, Birmingham New Street) —
this is a proxy measurement, not exhaustive (it only surfaces a tie that
manifests at the FINAL destination stop, and only when the tied
alternative also happens to be the fewest-changes winner specifically —
it can't see a tie at an intermediate stop that doesn't happen to
propagate all the way through to a different final route). Real result:

```
Bristol Temple Meads -> Norwich:        4:46:00 vs 4:46:00, different routes  <- TIE
Manchester Piccadilly -> Edinburgh:     4:32:00 vs 4:32:00, different routes  <- TIE
Reading -> York:                        4:09:00 vs 4:05:00, different routes (no tie, genuinely faster)
Crewe -> Newcastle:                     3:50:00 vs 3:53:00, different routes (no tie, genuinely faster)
(8 of 12 pairs deduped to one itinerary -- fastest and fewest-changes agreed)
```

**2 of 12 (17%) show a confirmed same-stop tie by this proxy measure
alone** — and this doesn't count ties at intermediate stops that never
surface as a different final route, so the true rate (including
intermediate-stop ties, which are invisible to this measurement) is
almost certainly higher. Combined with the earlier, already-known
Whitby↔Windermere case from the Step 2/4 build itself, this makes **three
independently observed real ties** across a small sample. This is a real,
structurally-common phenomenon, not a rare edge case: UK clockface
scheduling (services repeating on a fixed, repeating pattern) makes
near-simultaneous arrivals at busy interchanges (Crewe, York, Doncaster,
Reading, Birmingham New Street) a routine feature of the timetable, not a
coincidence — and Phase A's walking-transfer graph adds a second,
independent tie-generating mechanism on top of that (a train-only path
and a walk-assisted path landing at the same stop at the same time).
**Common enough to matter for a "ranked search" feature's real quality,
not an edge case worth deprioritizing.**

---

## 4. Cost of detecting ties

The destination-tiploc bound (Step 3, already built) works *because*
`dest_tiplocs` is small by construction (1-3 tiplocs in every real case
observed). That bound **does not carry over** to intermediate-stop ties,
and this is worth stating plainly: at a busy interchange with several
genuinely reachable-from-origin routings converging around the same time,
more than 2 tied predecessors at a single stop is realistic, not
far-fetched.

**The real risk is cascading, not just per-stop size.** If stop A ties
with 2 predecessors, and each of those 2 leads to a further connection
that also ties at stop B, the tied set at B could already be larger than
at A — and this can compound across a long journey with several
tie-producing interchanges, growing the candidate set combinatorially by
the time it reaches the final destination, unless it's actively bounded
along the way. This is the concrete "pathological case" worth flagging:
not one busy station producing a large tied set locally, but a chain of
ordinary-sized ties compounding across several interchanges over a long
route.

**What would bound it**: a hard cap on tied-predecessors-per-stop (e.g.
keep at most 2-3, discard the rest) applied *during* the scan, not just at
the end — this stops the cascade at its source rather than letting it grow
and pruning only at the final destination. **Which alternatives to keep
when the cap is exceeded is a real design decision** (first-found order,
some cheap quality proxy, or something else) — not resolved here.

---

## 5. Infrastructure / cost check

**Nothing beyond compute already available.** This is pure in-process
Python data-structure work (a list instead of a dict value per stop) over
data already loaded for every search — no new database table or column,
no external service, no additional paid API usage (Google Routes API,
Realtime Trains, Darwin — none of them are touched by this; risk-scoring
of a bounded tied-candidate set already uses only the existing
`darwin_movements` table, same as today). Flagging this explicitly as
asked, and the honest answer is no new infrastructure or cost of any kind
is implied by any option in this report.

---

## 6. Recommended approach

**Smallest change that detects general same-stop ties correctly:**

- Build it as a new sibling function (Option B, section 2) rather than
  modifying `run_csa()` in place — consistent with this build's own
  established pattern and the standing instruction to leave Pass 1
  untouched. `run_csa()` stays exactly as it is today.
- Track ties with **exact equality**, not a tolerance window, as the first
  cut — matches the one precedent already in this codebase (the
  destination-tiploc tiebreak), and avoids opening the "how much slack"
  question at the same time as everything else here. A tolerance window
  is a reasonable follow-up, not a prerequisite.
- Cap tied-predecessors-per-stop at a small constant (2-3) applied during
  the scan, to bound the cascade risk in section 4 at its source.
- Reuse the *exact* existing `compute_leg_statuses`/`compute_change_risks`/
  `risk_score`/`pick_lowest_risk` machinery from Step 3 for the final
  choice among however many tied full itineraries survive reconstruction
  at the destination — nothing new needed there, it's already
  criterion-agnostic.

**Code complexity**: meaningfully more than `run_csa_fewest_changes()`
was. That function only changed the comparison key; this needs the
three-way better/tied/worse branch, a capped list instead of a dict
value, and a decision about which ties survive the cap — a genuinely new
piece of correctness-sensitive logic, not a mechanical copy-and-tweak of
the existing pattern.

**Performance**: every connection processed pays one extra comparison
(is this within tie-tolerance of the current best, not just worse) and
occasionally a list append instead of a dict write — a constant-factor
addition, not a complexity-class change, so the existing ~0.7-0.8s Pass-1
cost shouldn't grow by more than a modest amount. This is a genuine
estimate, not a measurement — nothing like it has been built or profiled
yet, so treat it as a plausible order of magnitude, not a number to plan
around.

**Flagged as real design decisions, not resolved here**: the tie-tolerance
window (exact vs. small slack); the per-stop cap size and which
alternatives survive it when exceeded; and whether to modify `run_csa()`
in place or add a sibling function (section 2) — that last one carries
the most consequence and is the one most worth a deliberate answer before
any of this is built.

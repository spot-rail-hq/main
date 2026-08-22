# Multi-itinerary ranked output — architecture investigation

Investigation only, per the ask — no code changed, nothing committed. Read
against the current, fully-integrated `srhq-journey-search/service.py`
(Phase A walking-transfer graph complete, steps 2a/2b already live).

Your message said "these seven headings" but listed eight numbered items —
reporting all eight as given, since all eight are clearly distinct
questions worth answering; flagging the mismatch rather than silently
picking one interpretation.

---

## 1. Current label structure

**A single scalar per stop, not a richer structure.** `earliest_arrival`
(service.py:401) is a `defaultdict(lambda: None)` mapping `tiploc ->
datetime` — exactly one arrival time per stop, always the best (earliest)
seen so far, unconditionally overwritten the moment something better is
found (`c["arr_dt"] < cur_ea`, line 426; the same strict-improvement guard
governs footpath relaxation, line 385). Nothing about transfer count, walk
time, or path shape is tracked as part of this — it's folded invisibly into
the arrival time only (a slower-but-fewer-changes path and a faster-but-
more-changes path competing for the same stop: only the earlier arrival
survives, the other's information is destroyed, not merely deprioritized).

**Predecessor/reconstruction**: `predecessor` (line 402) is a plain dict,
also one entry per stop — `{tiploc: winning_connection_or_walk_dict}`,
overwritten in lockstep with `earliest_arrival`. Reconstruction (lines
443-451) is a simple linear walk backward from `best_dest` via
`predecessor[cur]` until an origin tiploc is reached. This assumes, by
construction, exactly one winning path per stop — there is no mechanism
today for "the second-best way to reach this stop" to survive at all.

**`trip_reached`** (line 403) is a third piece of state, but it's global
scan state, not part of the per-stop label: a set of `schedule_id`s already
boarded, letting a connection continuing an already-boarded trip skip the
transfer-buffer check entirely (line 413-414). It's an optimization/
correctness trick for "staying on the same train is always allowed," not a
per-path fact today — flagged as relevant again in sections 2 and 6.

**Single pass, confirmed.** `connections` is sorted once by `dep_dt` (line
399) and iterated exactly once in one `for c in connections` loop (line
411). Footpath relaxation is a separate, much smaller, nested traversal
over the `footpaths` adjacency dict (not a second pass over `connections`)
that happens inline during that same single pass. Nothing in the current
implementation performs or requires a second connections pass.

---

## 2. Multi-criteria approach options

### (a) Multi-label Pareto CSA

**Complexity against this codebase specifically: a real restructuring, not
an incremental patch.** Concretely:
- `earliest_arrival[stop]` (one datetime) would need to become
  `labels[stop] = [label, ...]` (a small list), with a dominance check
  (e.g. on `(arrival_time, transfer_count[, walk_time])`) replacing the
  simple `<` comparison everywhere it appears.
- `predecessor` can no longer be keyed by stop alone — two non-dominated
  labels arriving at the same stop need independent backpointer chains, so
  each label needs a stable identity of its own (see section 6).
- **`trip_reached`'s global set doesn't generalize safely, and this is the
  least obvious part of the port.** It works today only because there is
  exactly one active label per stop. With multiple concurrent labels, "am I
  currently riding schedule X" becomes a per-label fact, not a global one —
  reusing the current global set as-is would let one label board a train
  "for free" purely because a completely unrelated label happened to have
  already boarded that same service elsewhere in the frontier. The
  straightforward fix is to make "last boarded schedule_id" part of the
  label itself rather than a shared global set — a small but real
  correctness-sensitive change, not cosmetic.
- Dominance-check cost per relaxation is cheap in isolation (comparing
  against a handful of labels at one stop), but it now runs however many
  times the label-set size at each touched stop implies, rather than once.

### (b) Two-pass (today's scan, then a bounded min-transfers pass)

**Complexity: much smaller, and reuses almost all existing code shape.**
Pass 1 is `run_csa()` completely unchanged, giving the true fastest arrival
`T*`. Pass 2 is structurally the *same loop* (same sort, same connection
iteration, same footpath relaxation shape) with two changes: the
improvement comparison becomes `(transfer_count, arrival_time)` lexical
order instead of raw arrival time, and connections whose own `arr_dt`
already exceeds `T* + slack` are skipped outright (a cheap, if not fully
admissible, pruning bound). Both passes stay single-label internally, so
`predecessor`/reconstruction need no changes at all (see section 6) —
this is functionally "call a slightly-parameterized `run_csa()` twice," not
a new algorithm.

**Realistic ~0.8s impact** (rough, not benchmarked — see section 8 for the
full numbers): option (a)'s cost scales with average per-stop label-set
size, which is genuinely unknown without real data — plausibly 2-5x
today's ~650-710ms `run_csa()` cost, but with real variance since nothing
comparable has been measured yet. Option (b)'s cost is a second near-full
scan, partially cut by the slack-window filter — plausibly +0.3-0.7s
depending on how aggressively that filter prunes, anchored on a cost
model (single-label scan) already measured in part 2b. Option (b) is the
structurally smaller, lower-uncertainty change; not deciding which to
build, since that wasn't asked here, but stating this plainly since it's
a direct answer to "implementation complexity ... given current code
shape."

---

## 3. Criteria selection

**Available now:**
- **Arrival time** — already the sole criterion; no gap.
- **Transfer count** — not tracked live today, but trivially derivable
  post-hoc (`len(merge_legs(chain))`, or counting non-continuation chain
  entries); to be a real scan-time/dominance criterion under either option
  above it needs to become part of the live label (option a) or the pass-2
  objective (option b), not just computed after the fact as it is now.
- **Walk time** — available per walk leg (`walk_seconds` on every
  walk-tagged predecessor entry). **Walk *distance* is not currently
  carried this far**: `load_footpaths()` (service.py:335) only keeps
  `(neighbor, walk_seconds)` from `walking_transfers`, discarding
  `walk_meters` at load time. A small, concrete gap if walk distance
  specifically (not just time) is ever wanted as a ranking axis — not
  available for free today.

**Not deciding, flagging as asked: should connection-risk
(tight/at_risk/fine/unknown) factor into ranking, or stay informational
per itinerary?** The architecturally relevant fact this decision turns on:
connection-risk is currently computed **after** `run_csa()` returns, inside
`search()`, from live Darwin lookups per interchange of the one already-
chosen chain (`get_live_status()` calls, `classify_connection_risk()`) — it
does not exist anywhere inside the scan itself, which today is pure
schedule-graph arithmetic with no I/O at all. Folding risk into scan-time
ranking/dominance would mean live database reads inside the hot loop,
potentially once per candidate interchange per label — a materially
different performance profile from today's scan, not a free addition.
Keeping it informational-only (computed once per each of the top-N
*already-chosen* itineraries, same as today, just repeated per result)
avoids that entirely. Both are legitimate; this is the decision point,
reported with its real cost attached rather than left as a bare "TBD."

---

## 4. Walking-leg interaction

**Today**: walk legs are already fully integrated into the single-label
scan (Phase A steps 2a/2b) via `_relax_footpaths()` — inline relaxation
whenever the single `earliest_arrival` scalar at a stop improves, both
pre-scan (from origins) and in-scan (from any connection-driven
improvement). `MAX_FOOTPATH_SECONDS` (900s) is a **hard, scan-independent
gate** applied once at `load_footpaths()` load time (service.py:351/353) —
it shrinks which edges exist in the graph *before* scanning starts; it is
not part of any per-label or dominance logic today.

**Under multi-criteria**: that gate can stay exactly as-is, as a pre-scan
graph-shrinking filter, under *either* option — nothing about moving to
Pareto or two-pass forces walk time to become a first-class dominance
component. It only needs to become one if criterion selection (section 3)
decides walk time/distance should be an independent ranking axis in its
own right (e.g. preferring a shorter walk between two itineraries tied on
arrival time and transfer count) rather than something that only ever
shows up indirectly through its effect on arrival time, which is already
fully captured today. This is coupled to, not separate from, the section 3
decision — not resolving it independently here.

---

## 5. STP resolution interaction

**Confirmed directly from the code, not assumed: this is a structural
non-issue for multi-label Pareto, and here's exactly why.** STP resolution
happens **once per date, entirely before `run_csa()` runs at all** —
`BULK_RESOLVE_SQL`'s `DISTINCT ON (train_uid) ... ORDER BY train_uid,
{STP_ORDER_SQL}` (service.py:77-84) picks exactly one schedule row per
`train_uid` per date, in Cancellation > New > Overlay > Permanent priority,
via `bulk_resolve()`. This feeds `build_connections_for_date()`, which
builds the **entire** connections list for that date from that one
resolution pass — cached (memory then disk) across every search hitting
that date, via `load_or_build_date()`, completely decoupled from and prior
to any per-search scan logic, single- or multi-label alike.

**Direct answer**: since every connection in the shared list already
reflects the one globally-resolved STP version of its `train_uid` before
any scan (single- or multi-label) ever touches it, there is only ever one
version of any given service in play. Two non-dominated labels at the same
stop can disagree about arrival time or transfer count, but they cannot
disagree about which STP-resolved version of a service they're each
reasoning about, because there is structurally only one version to
reason about at all. **No design decision is needed here** — flagged
explicitly as a confirmed non-issue, per the instruction to flag things
plainly even when the answer turns out to be "this isn't a problem,"
rather than silently passing over a question that was directly asked.

One adjacent (not asked, but worth naming): this non-issue depends
entirely on STP resolution staying a whole-date, pre-scan step. If a
future change ever made resolution depend on the query itself (e.g.
something relative to `depart_after` rather than the whole calendar date),
this exact hazard would reappear — but neither option under consideration
here implies or requires that change.

---

## 6. Path reconstruction at scale

**Does not generalize for free — real rework, and here's specifically what
breaks.**

- `predecessor: {stop: connection}` has exactly one slot per stop. It
  cannot hold two competing backpointers for two non-dominated labels
  arriving at the same stop — the key space itself needs to change from
  "per stop" to "per label," which needs a stable label identity that
  doesn't exist today (today, "the label at stop X" simply *is* "stop X";
  under Pareto there can be several, so each needs its own identity, e.g. a
  counter or a `(stop, arrival_time, transfer_count)` tuple).
- Every relaxation/candidate-generation step needs to *create* new label
  identities and link them backward, rather than overwriting one dict slot
  as today's code does at lines 427-428 and 386-387.
- Reconstruction changes shape from "walk backward once, from the single
  winning label at the destination" to "walk backward once **per label**
  worth showing" — mechanically similar per walk, but now needs a prior
  selection step (which of the destination's surviving non-dominated
  labels actually get reconstructed and shown — likely a handful, not the
  full frontier, since a real Pareto frontier can in principle be larger
  than anything useful to present).
- `trip_reached`'s global-set trick (flagged in section 2a) also touches
  reconstruction correctness: today's reconstruction implicitly relies on
  there being only one active notion of "currently riding this trip" per
  stop. Per-label reconstruction needs each label's own path to be
  self-consistent, which again pushes toward per-label "last boarded
  schedule_id" state rather than the current shared global set.

**For option (b) specifically: zero rework.** Each pass stays single-label
internally — only the comparison function changes, not the data structure
— so today's exact `predecessor`/reconstruction code (lines 443-451) runs
completely unmodified, just once per pass, each producing its own
independent chain. This is a concrete, code-level advantage for option (b)
on exactly the question this section asks.

---

## 7. Output shape / deduplication

**Flagging, not resolving, per the ask.** The real problem: two
itineraries differing only by, say, a one-minute-later near-identical
service on a frequent corridor (or the same physical route reached via a
marginally different but functionally-equivalent walk edge) would read as
separate ranked results while being uninteresting or confusing to show
side by side. Candidate axes to de-duplicate on (not deciding among them):
same ordered sequence of interchange stations regardless of exact
`train_uid`/`schedule_id`; same ordered sequence of operators; arrival
times within some small window *and* identical transfer count.

**Existing precedent in this codebase for this specific problem: none
found — checked directly, not assumed.** `run_csa()` has only ever returned
a single chain, so there has never been a multi-result set to de-duplicate
within this service before now. The one remotely-adjacent thing in the
wider project is `normalizeBoard()`/the departures-board dedup logic in
`api/darwin-departures.js` (per CLAUDE.md) — but that de-duplicates the
*same real-time event reported twice* across multiple Darwin messages, a
different problem entirely from de-duplicating structurally-similar but
genuinely distinct *itineraries*. Nothing to reuse; this is new design
surface, reported plainly as such rather than implying a pattern exists
that doesn't.

---

## 8. Performance estimate

Rough only, not a benchmark, per the ask. Baseline (measured live, part
2b): `load_footpaths()` ~4ms; connection-build ~4.4s cold / ~5ms once
memory-cached per `load_or_build_date()`'s existing tiering; `run_csa()`
itself ~650-710ms warm, with footpath relaxation adding only noise-level
overhead (~±20-36ms) on top of that. The ~0.8s figure in your message
matches this measured warm-path total closely.

- **Option (a) (Pareto)**: cost scales with average per-stop label-set
  size, which is genuinely unknown without real data — plausibly 2-5x
  today's `run_csa()` cost (roughly 1.5-3.5s warm), but this carries real
  uncertainty since nothing comparable to "how large do non-dominated
  label sets get on this network" has ever been measured.
- **Option (b) (two-pass)**: a second near-full scan, partially prunable by
  the arrival-time-slack filter — plausibly +0.3-0.7s on top of today's
  ~0.8s (roughly 1.1-1.5s warm), anchored on a cost model (a single-label
  scan) that's already been measured, so meaningfully less uncertain than
  option (a)'s estimate.
- **Existing indexes/precomputation**: unaffected by either option at the
  algorithm level — both reuse the exact same `connections` list and
  `footpaths` dict already loaded today; neither implies a new database
  index. The one genuine, small precomputation gap (already flagged in
  section 3) is `load_footpaths()` discarding `walk_meters` — trivial to
  carry through if walk distance becomes a real ranking axis, not a
  structural change to any index or table.

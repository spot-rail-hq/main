# Pass 2 ("fewest changes") general tie detection — investigation

Investigate only, per the ask — no code changed in `service.py`, nothing
committed. Measured directly against real, live production data (via the
running `srhq-journey-search` container itself, `docker exec`'d — never
modified) rather than estimated.

---

## 1. What counts as a tie in Pass 2

Pass 2 compares `(transfer_count, arrival_dt)` lexicographically. The two
components are not symmetric, and tie-tolerance can't be applied to both
the same way:

- **`transfer_count` needs EXACT match, no tolerance.** It's the primary
  sort key and it's discrete/integer, and — unlike Pass 1's continuous
  arrival time — an off-by-one difference is not "close enough to be a
  real alternative," it's a materially different answer to the exact
  question Pass 2 exists to answer ("fewest changes"). A path with 2
  changes is not a tolerable near-tie with a path that has 3; allowing
  slack here would silently misdefine what "fewest changes" means.
- **`arrival_dt` is the right place for a tolerance window** — same
  reasoning as Pass 1: two paths with the same transfer count arriving
  within a couple of minutes of each other are a genuine practical choice.
- **Reuse `TIE_TOLERANCE_SECONDS` (120s) rather than a new constant.** The
  question it answers ("how close in time counts as effectively
  simultaneous for a human") doesn't change depending on which pass is
  asking it — it's the same real-world tolerance, not a different
  phenomenon. No evidence from what was measured below suggests Pass 2's
  ties cluster at a different timescale than Pass 1's did.

**Recommended definition**: `transfer_count` exact match AND `arrival_dt`
within `TIE_TOLERANCE_SECONDS`.

---

## 2. Real frequency — measured, not estimated

Ran two independent measurements against the same 12 O-D pairs already used
for the Pass 1 investigation, plus 3 more (Waterloo→Exeter, Woking→
Waterloo, Southampton→Stratford — the same busy-interchange stress cases
used in the Pass 1 build), all at `2026-08-24 08:00`, live DB.

### Method A — existing live `search()`, completely unmodified

Just re-ran the real, already-shipped endpoint. Whenever it returns 2
itineraries with different `criteria` (`['fastest']` + `['fewest_changes']`
rather than the deduped `['fastest', 'fewest_changes']`), that's Pass 1 and
Pass 2 disagreeing — **not proof of a Pass-2-internal tie**. 7 of 15 pairs
showed this split. This is already fully handled by the existing dedup
logic and is a different phenomenon (confirmed in the Pass 1 build report:
the Whitby↔Windermere case that looks like this is a cross-criterion
coincidence, not a same-criterion tie).

### Method B — direct stop-level tie probe (new script, `service.py` untouched)

A read-only re-derivation of `run_csa_fewest_changes()`'s own scan loop
(same logic, copied, not imported/modified) that logs every candidate
`(transfer_count, arrival_dt, schedule_id)` computed at each watched stop,
then counts how many *distinct schedule_ids* land within the tie
definition from #1 of that stop's real final winning label. Watched stops,
per pair: the winning destination tiploc, plus **every stop the winning
Pass-2 path actually visits** (not an arbitrary "busy station" list —
an early version of this probe also watched fixed busy interchanges like
Waterloo/Crewe/York regardless of whether the route in question went near
them, and it produced noise: e.g. Manchester→Edinburgh and Birmingham→
Southampton — routes that never go anywhere near London Waterloo —
"tied" at a Waterloo-area tiploc purely because *some unrelated service*
converges there at a similar time. That's real, but irrelevant to those
searches; the corrected version only watches stops on the path actually
being evaluated).

**Real results, all 15 pairs:**

| Measure | Result |
|---|---|
| Destination-level ties (same dest tiploc, exact transfer_count, arrival within 120s) | **0 of 15** confirmed genuine (one apparent 0-candidate case — Woking→Waterloo — is a probe artifact: the winning arrival there came from a footpath relaxation, which the probe doesn't log candidates for, not a real absence) |
| On-path intermediate ties | **1 of 15** (London Waterloo→Exeter St Davids: two schedule_ids tie at Clapham Junction and, separately, at Vauxhall — both very early legs right out of the Waterloo throat, transfer_count=1, ~8 minutes apart in real clock time... within the 120s tolerance of each other specifically) |

**This is a materially lower rate than Pass 1's own measured tie
frequency** (Pass 1's build report: destination-level ties in 6 of 18
pairs, one case with 6 simultaneous tied candidates). The reason is
structural, not a measurement fluke: Pass 2's tie condition is a
**conjunction** (exact transfer_count AND arrival tolerance) where Pass 1's
is a single continuous comparison — a strictly harder bar to clear, so
fewer real candidates meet it.

---

## 3. Implementation shape

Checked directly, same way as Pass 1's own investigation did:
`run_csa_fewest_changes()` has **no external callers** either. Grepped the
whole `srhq-journey-search` repo and `main` (the site repo, which only
talks to this service over HTTP via `api/journey-search.mjs` — a JSON
contract, not a Python import) — the only two call sites are
`resolve_fewest_changes_ties()` and `search()`, both in this same file.
`csa-router.py` (in `main/scratchpad`) has its own separate, older
`run_csa()` and never imports `service.py` at all — same non-issue as
before.

**Same low-risk path applies**: if this were built, modifying
`run_csa_fewest_changes()` directly (Option A, matching what was actually
done for Pass 1) would carry the same narrow blast radius Pass 1's version
did, for the same reason.

---

## 4. Cost — anchored to Pass 1's real measured number, not a fresh guess

Pass 1's real, measured overhead from adding tie-tracking was **+0.3 to
+0.5s absolute**, added to a Pass-1 baseline of ~0.65–0.75s (a ~40–70%
relative increase). The overhead is per-connection (an extra function call
plus branching over the same ~500k+ connections), not proportional to the
pass's own baseline cost — so the same *absolute* addition should be
expected here.

Pass 2's own measured baseline in this session: **~0.4–0.6s** (`csa_seconds_
fewest_changes` in the live perf numbers above), smaller than Pass 1's.
Applying the same absolute overhead (+0.3–0.5s) would mean **Pass 2's own
runtime roughly doubles** (to ~0.7–1.1s) — a much bigger *relative* hit
than Pass 1 took, for a mechanism that, per section 2, found a genuine
tie in only 1 of 15 real cases and it never changed which stop the winning
path actually reached.

Also worth weighing against the *existing* mechanism this would replace:
`resolve_fewest_changes_ties()`'s current per-extra-dest-tiploc re-scan is
already not free — the live perf numbers above show `tiebreak_seconds_
fewest_changes` ranging from 0 to **2.25s** in this same test run (Reading
→York), sometimes costing more than Pass 2's own primary scan. A general
mechanism would fold that cost into the single scan rather than adding
it on top, which is a real potential upside not captured by the "+0.3-0.5s"
number alone — but Method A above shows destination-level ties (the case
this existing mechanism actually handles) were never observed as genuine
in this sample, so it's unclear how much of that existing cost is even
buying anything today.

---

## 5. Recommendation: not worth building now

Given 1–4: **no.** The real, measured evidence is:

- **0 of 15** genuine destination-level Pass-2-internal ties (the case
  Pass 1's equivalent build was clearly worth it for — Pass 1 found this
  in a third of its own test pairs).
- **1 of 15** genuine on-path intermediate tie, and it didn't change the
  final route reachable from that search.
- A real cost that would roughly **double** Pass 2's own runtime, based on
  Pass 1's own measured overhead.

This is the opposite profile from Pass 1, where the tie rate was common
enough to matter for real search quality and the cost was a smaller
relative hit on a bigger baseline. Building the same mechanism here would
pay a proportionally large, real performance cost for a benefit that did
not materialize in this sample even once at the level (destination) that
actually reaches the user.

**Not a permanent "never"** — flagging what would change this: a wider
sweep than 15 pairs turning up destination-level Pass-2 ties at a rate
closer to Pass 1's, or a specific real user-reported case where Pass 2's
single-label answer visibly discarded a real, equally-good fewest-changes
alternative. Neither was found here. Revisit only if either shows up.

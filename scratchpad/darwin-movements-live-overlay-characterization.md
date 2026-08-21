# darwin_movements characterization for live-overlay design

Report only, no build, no schema/service/repo changes. 2026-08-21. All
queries run directly against the live `srhq-infra` Postgres on `srhq-prod`.

---

## 1. Full column inventory — real rows, not the general spec

```
id | tiploc | rid | event_type | scheduled | working | expected_or_actual
   | is_actual | delay_minutes | platform | source | msg_timestamp | received_at
```

**No distinct forecast column vs actual column.** There is exactly one time
value that does double duty — `expected_or_actual` — disambiguated by the
separate `is_actual` boolean. Confirmed directly by watching one real
departure event accumulate rows over time (`rid 202608218732588`, BRGHTN
departure, scheduled 07:58):

```
scheduled  working  expected_or_actual  is_actual  source  received_at
07:58      07:58    07:58               f          TD      06:47:38
07:58      07:58    07:58               f          TD      06:48:05
07:58      07:58    07:58               f          Darwin  06:58:25
07:58      07:58    07:58               t          TD      06:58:55
```

This table is **append-only / event-log shaped, not upsert-in-place**: every
new message inserts a new row rather than replacing the previous forecast.
The last row's `is_actual` flip to `true` (sourced from `TD` — Train
Describer berth data) is the moment this specific event stopped being a
forecast and became a confirmed actual. `source` blends multiple real feeds,
not pure Darwin Push Port: real distinct values seen are `Darwin`, `TD`,
`TRUST`, `Trust`, `CIS`, `GPS`, `Workstation`, and blank — `TD` rows are
consistently the ones carrying `is_actual = true`.

**`delay_minutes` is already computed, not raw for the consumer to diff.**
Verified against real nonzero examples — it's exactly
`expected_or_actual − scheduled`, in minutes, every time:

```
tiploc    scheduled  expected_or_actual  delay_minutes
GODSTON   08:05      08:20               15   (08:20-08:05=15 ✓)
POLGATE   07:57      08:16              19   (08:16-07:57=19 ✓)
BHAMNWS   08:08      08:14               6   (08:14-08:08=6 ✓)
SOTPKWY   08:09      08:16               7   (08:16-08:09=7 ✓)
HITCHIN   08:04      08:15              11   (08:15-08:04=11 ✓)
```

A live overlay doesn't need to compute lateness itself — it's already there,
consistently, on every row.

## 2. Activation lead time — measured, not assumed

Picked 20 real services from `schedules` (STP-resolved, exactly per the
established method) spread across ATOCs and departure times on 2026-08-20 —
the most recent **fully elapsed** day (today, 2026-08-21, is still in
progress as of this investigation — 07:03 UTC — so later services today
have no data yet simply because they haven't run; that's not a finding,
it's just incomplete-day noise, so I used the last complete day instead).
For each, matched to `darwin_movements` on tiploc + scheduled time, and
retrieved the earliest `received_at` at that same origin tiploc, converting
`schedules`' local-clock times through `Europe/London` (2026-08-20 is BST,
UTC+1) rather than assuming UTC — an early version of this query was off by
exactly one hour before this was caught and fixed.

**14 of 20 matched** (6 explained below in a way that's actually informative
— not noise). Real leads, sorted:

```
train_uid  atoc  tiploc    sched(BST)  lead
G85875     NT    SBRN      15:26       -0:01   (first row essentially AT departure)
P02516     LO    EUSTON    17:14        0:16
L84450     SW    WEYBDGB   23:33        0:27
Y65564     LO    CRYSTLP   06:32        0:40
G59060     LO    STFD      09:05        0:45
J03430     SE    LEWISHM   00:37        1:00
C22649     TL    SUTTON    05:46        1:00
G61893     LO    CHINGFD   22:08        1:08
L84483     SW    STAINES   04:53        1:10
C14626     SR    EDINBUR   08:31        1:30
W45584     TL    BEDFDM    03:14        2:00
Y80671     GW    TWYFORD   15:45        3:38
L37354     CH    AYLSBRY   06:46        4:00
G66721     XC    BRSTLTM   08:01        4:00
```

**This is not a hard, consistent window.** Range is -1 minute to 4 hours —
an over-4-hour spread. Median is ~1h04m, but there's no clean cutoff and no
clean per-TOC rule either: London Overground (`LO`) appears 4 times and
stays under ~1h10m every time, but Chiltern (`CH`) and CrossCountry (`XC`)
both show a full 4 hours, and Great Western (`GW`) shows 3h38m — TOC alone
doesn't explain most of the spread, and neither does time-of-day (early-
morning, midday, and evening departures all appear at both ends of the
range).

**A second, arguably more important finding: lead time isn't even a single
property of a train — it's per calling point.** Pulled the full first-
appearance-per-stop breakdown for one real service (a Southern local
stopper, `rid 202608218732588`, Brighton–Littlehampton–Barnham) already
sampled for §1:

```
tiploc    sched   first_seen(UTC)   implied lead
BRGHTN    07:58   06:47:38          ~1h10m
HOVE      08:02   05:32:04          ~2h30m
ALDTON    08:04   04:04:03          ~4h00m
STHWICK   08:11   05:11:03          ~3h00m
...(9 more stops, all clustered ~2h30m)...
LTLHMPT   08:48   05:48:04          ~3h00m
FORD      09:01   06:31:05          ~2h30m
BRHM      09:06   03:06:03          ~6h00m
```

**Same train, same day: lead ranges from ~1h10m to a full 6 hours across its
own calling points**, with most intermediate stops clustering tightly
around 2h30m but the origin (Brighton) and the final stop (Barnham) sitting
well outside that cluster in opposite directions. Whatever "first appears in
darwin_movements" is measuring, it is not a single per-train activation
event with one lead time — it varies by location, and a live overlay design
needs to reason about "when does data for *this specific calling point*
typically start", not "when does data for *this train* start."

## 3. Cancellation-as-absence — re-confirmed, with one real, important caveat

Sampled 6 more single-date STP-Cancellation records (different TOCs/dates
than the two already checked previously — Eurostar `C00354` and Chiltern
`L38221`), each cross-checked against the P/O schedule that would otherwise
have applied that exact date.

**2 of 6 are clean, direct re-confirmations — zero rows, no complications:**

```
G26275 (SN) Victoria 22:05, cancelled 2026-08-16 — 0 darwin rows that exact date
L37520 (CH) Marylebone 20:44, cancelled 2026-08-14 — 0 darwin rows that exact date
```

Checked both for a same-slot substitute schedule too (see below) — neither
has one; these are unambiguous.

**4 of 6 initially looked like counterexamples — nonzero rows on the exact
cancelled date — and this is worth reporting in full rather than smoothing
over.** First pass (a 3-day window around the cancelled date) showed rows
for all 6; narrowing to the *exact* cancelled calendar date still showed 4
of 6 with real rows (3–7 each). Investigated each directly rather than
either dismissing or accepting at face value: **every one of the 4 traces to
a different train_uid — a same-day Overlay or New/VSTP-style schedule —
occupying the exact same tiploc+time slot.** E.g. `G39547` (AW, Merthyr
17:39, cancelled 2026-08-16): a real Overlay, `Y62663`, is scheduled at the
identical MERTHYR 17:39 slot that exact day. Same pattern confirmed for the
other 3 (`W45620`→`W45578` overlay at BRGHTN; `G59023`/`G59093`→`F23815`
new-schedule at STFD).

**Conclusion, re-confirmed across 8 total cases now (2 original + 6 here):
a cancelled schedule's own identity never surfaces in `darwin_movements`.**
What looked like exceptions were real substitute trains taking the same
public timetable slot — a genuinely common, real operational pattern (a
relief/diverted service re-using a cancelled train's advertised slot), not
evidence against the finding. **The caveat this surfaces for live-overlay
design**: tiploc+time is not always a unique key even within one day —
before concluding "no live data for train X" means "the platform was
empty," a live overlay must check whether a same-day Overlay/New schedule
occupies the identical slot, or it will misattribute a real substitute
train's data to the cancelled one (or vice versa).

## 4. Bottom line — proposed cutoff logic, grounded in §2's real numbers

**Do not reuse the Darwin LDBWS REST ±120/119-minute figure — it doesn't
apply here at all.** That number governs `timeOffset` on a completely
different product (`GetDepBoardWithDetails`, a polled REST query-range
parameter), not Push Port's own activation/publishing behavior. Conflating
the two would be applying an unrelated system's parameter to this one.

Given §2's real spread (-1 min to 4h, no fixed constant, varies by
location not just by train), a single hard threshold is the wrong shape.
Proposed **three-tier logic, scoped per calling point being displayed** (not
per train — §2's within-train spread makes a per-train rule unsound):

- **More than 4 hours before scheduled time: absence is normal.** Every
  matched case in the sample had appeared within 4 hours; nothing to flag.
- **Within 4 hours, before scheduled time: absence is "not yet published",
  not a gap.** Median first-appearance was ~1h04m before; most of the
  sample (11/14) had appeared by T-1h30m, but a real minority took the full
  window, so don't alarm on this — treat it as expected variability.
- **At or after the scheduled time: this is the real hard deadline.** No
  case in the sample had genuine first-appearance *after* its own scheduled
  time (the closest, `G85875`, appeared essentially coincident with
  departure, -1 min). If a calling point still has no row once its own
  scheduled time has passed, that's the point to treat it as "record
  expected but absent" rather than "still pending" — everything else in
  this sample had already resolved one way or the other by then.

**Two caveats to carry into the actual design, not just this report:**
- Apply this per calling point, not per train (§2's within-train spread).
- Before treating an absence as a real gap, rule out the cancellation
  scenario from §3 — check whether the *schedule itself* was cancelled or
  superseded for that date before concluding "Darwin should have data here
  and doesn't."

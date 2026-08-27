# Manual live-verification walkthrough — point-to-point last-mile / Mapbox

For Aaron to run himself. Two prerequisites first, then the 9 steps map onto
a handful of curl commands plus two dashboard checks.

## Prereq A — fix the actual blocker: JOURNEY_SEARCH_RESOLVE_URL

Confirmed live: `/api/journey-search` reaches the real VPS fine; `/api/resolve-address`
returns `503 upstream_unavailable` on every call, which is `api/resolve-address.mjs`
short-circuiting before any network call happens. Since both files read the same
`JOURNEY_SEARCH_KEY` and that one demonstrably works, the missing piece is
**`JOURNEY_SEARCH_RESOLVE_URL`**.

1. Vercel dashboard → `main` project → Settings → Environment Variables.
2. Find `JOURNEY_SEARCH_URL` (e.g. `https://<subdomain>.srhq.uk/journey-search`) —
   copy its host.
3. Add `JOURNEY_SEARCH_RESOLVE_URL` = same host, path `/resolve-address` instead
   of `/journey-search`. Set it for Production (and Preview if you want to test
   there too).
4. **Redeploy** — Vercel serverless functions only pick up new/changed env vars
   on a fresh deployment, not on the already-running one. Easiest: Deployments →
   latest → "Redeploy".
5. Re-run the Prereq-A curl below to confirm it's fixed before moving on.

```bash
curl -s -X POST https://srhq.uk/api/resolve-address \
  -H "Content-Type: application/json" -H "Origin: https://srhq.uk" \
  -d '{"query": "SW1A 1AA"}' -w "\nHTTP:%{http_code}\n"
```
Expect: no longer `503 upstream_unavailable`. Next most likely response if
`MAPBOX_TOKEN` also isn't loaded server-side: `503 {"error":"MAPBOX_TOKEN not set"}`
— that's Step 1 below, not this prereq.

## Prereq B — confirm MAPBOX_TOKEN in Coolify

Coolify dashboard → the `srhq-journey-search` application → **Terminal** tab
(no SSH needed, this runs inside the live container):

```bash
python3 -c "import os; print('SET' if os.environ.get('MAPBOX_TOKEN') else 'MISSING')"
```
Must print `SET`. If `MISSING`: check the variable is attached to *this*
application (not just defined at the team/project level but not linked), and
that the app was actually redeployed after adding it — same "new deployment
picks up new env vars" rule as Vercel.

---

## Step 1 — token loads + trivial real call

Same Coolify Terminal tab:
```bash
curl -s "https://api.mapbox.com/geocoding/v5/mapbox.places/London.json?access_token=$MAPBOX_TOKEN&limit=1" -w "\nHTTP:%{http_code}\n"
```
Expect `200` and a real JSON body with a `features` array. A `401` here means
the token itself is bad (typo'd when pasted into Coolify) — separate from the
env-var-name question, which Prereq B already answered.

## Step 2 — real geocoding, response shape

Once Prereq A is fixed, everything from here runs from **your own machine**
against the public endpoint — no VPS access needed at all:
```bash
curl -s -X POST https://srhq.uk/api/resolve-address \
  -H "Content-Type: application/json" -H "Origin: https://srhq.uk" \
  -d '{"query": "SW1A 1AA"}' -w "\nHTTP:%{http_code}\n"
```
Check the response has `found: true`, `station: {tiploc, crs, name}`,
`walk: {distance_meters, duration_seconds}`, `cycle_estimate: {duration_seconds}`,
`banner: {show, reason}`, `correction_applied` — matches what `handle_resolve_address`
in `service.py` is supposed to return. If any field is missing/renamed compared
to that, that's a real parsing bug to report back.

## Step 3 — real Directions call, units sanity

Same response as Step 2 — eyeball `walk.distance_meters` and
`walk.duration_seconds` against a mental map of SW1A 1AA → nearest station
(should be plausible walking distance in **meters**, not miles-sized numbers
like `0.6`, and duration in **seconds**, not minutes-sized numbers like `8`).

## Step 4 — three sanity-check locations, live

```bash
for q in "Hathersage" "Chipping Campden" "Bishops Castle"; do
  echo "=== $q ==="
  curl -s -X POST https://srhq.uk/api/resolve-address \
    -H "Content-Type: application/json" -H "Origin: https://srhq.uk" \
    -d "{\"query\": \"$q\"}"
  echo
done
```
Compare against the offline predictions in `point-to-point-last-mile-build.md`:
- Hathersage: `banner.show` should be `false`, walk distance ~900m.
- Chipping Campden: **the one to actually look at** — the offline estimate put
  it right on the `MAX_CYCLABLE_METERS` (8000m) boundary. Whatever the real
  routed distance comes back as here settles it either way; no code change
  needed regardless of which side it lands on unless the constant needs
  nudging.
- Bishops Castle: `banner.show` should be `true`, walk distance ~13000m.

If any of these differ wildly from the geography (e.g. Hathersage comes back
10km), that's a bug — check whether `geocode_address` is resolving to the
right place at all (Mapbox forward-geocoding a bare place name with no
postcode can be ambiguous; try a postcode instead if so).

## Step 5 — ambiguity correction firing correctly

Query something close to Birmingham Moor Street/New Street (both stations are
within ~550m of central Birmingham) and something near just one of Manchester's
termini (Piccadilly or Victoria, which are ~850m apart — beyond the 1.5x
ratio from most points near either one):
```bash
curl -s -X POST https://srhq.uk/api/resolve-address -H "Content-Type: application/json" -H "Origin: https://srhq.uk" -d '{"query": "New Street Station, Birmingham"}'
curl -s -X POST https://srhq.uk/api/resolve-address -H "Content-Type: application/json" -H "Origin: https://srhq.uk" -d '{"query": "Manchester Piccadilly Station"}'
```
Check `correction_applied` in each response — expect `true`-leaning for the
Birmingham case (ambiguous enough that the 2nd candidate gets checked) and
more likely `false` for the Manchester case, though the *actual* trigger
depends on where Mapbox geocodes the free-text query to, not just station
distance — this is exactly why it needs a live check rather than trusting the
offline synthetic test. To confirm the actual Directions-call count matched
(not just the boolean), see Step 9's usage-counter delta.

## Step 6 — full real path

Already exercised by every curl above (that's the point of testing via the
public URL rather than `service.py` functions directly). Additionally worth
one deliberate negative test — wrong internal key, straight to confirm the
proxy really is gating on it and not silently bypassing:
this one you can't trigger from outside since the proxy always attaches the
correct key server-side; if you want to test a *wrong* key reaching the VPS
directly, you'd need the VPS's own resolve-address URL and could send a
bad `X-Internal-Key` header directly to it — only doable with VPS/network
access, skip unless you specifically want to check the VPS's own auth
independent of Vercel.

## Step 7 — bad input

```bash
curl -s -X POST https://srhq.uk/api/resolve-address \
  -H "Content-Type: application/json" -H "Origin: https://srhq.uk" \
  -d '{"query": "asdkjfhaskjdfh1234xyz not a real place"}' -w "\nHTTP:%{http_code}\n"
```
Expect a clean `200` (or a deliberate error status, but NOT a 500 or a raw
Python traceback) with `{"found": false, "error": "No address/postcode match for '...'"}`.
Per the code (`handle_resolve_address`), Mapbox returning zero features for a
nonsense query is handled gracefully — this should not crash.

## Step 8 — scope/permission errors

Watch every response above for `502 {"error": "mapbox request failed: ..."}`
— that error text comes straight from Python's `urllib.error.URLError`, so
if it ever shows an HTTP 401/403 from Mapbox specifically, **stop and check
the Mapbox dashboard token scopes immediately** rather than assuming it's a
code bug — this is exactly the case flagged in the original ask as something
to report precisely, not route around.

## Step 9 — usage counters actually incrementing

Needs Postgres access — either via Coolify's own database service UI if it
exposes a query console, or from the Coolify Terminal tab if `psql` and
`DATABASE_URL` are available in that container (they may not be — `service.py`
connects via `psycopg2` directly, not necessarily via a `psql` client binary
being installed):
```bash
psql "$DATABASE_URL" -c "SELECT * FROM api_usage ORDER BY month, product;"
```
Run once before any of the curls above, once after. Confirm:
- `geocoding` calls increased by exactly the number of `/resolve-address`
  requests made (one geocode per request, success or not).
- `directions_baseline` increased by the same count (one per *successful*
  geocode that then tried nearest-station resolution).
- `directions_correction` increased only for requests where `correction_applied`
  came back `true` in Step 5 — this is the number that actually proves the
  ambiguity-ratio gating is spending calls only when it says it is, not just
  reporting the flag correctly.

If there's no query console and no `psql` in the container, this step may
need `MAPBOX_TOKEN`'s neighbor secret `DATABASE_URL` pasted into a local
`psql`/GUI client from your own machine instead, if the VPS Postgres is
reachable from outside — depends on how it's firewalled, not something I can
tell from here.

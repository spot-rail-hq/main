# Phase A, step 1, Part 2 — schema enrichment, applied

Applied directly to `naptan_stations` on the live `srhq-infra` Postgres.
No walking edges computed or stored — schema only, as scoped. Part 1's
report (`walking-transfer-phaseA-step1-part1.md`) is the reasoning this
implements; short version: **no duplicate-resolution mechanism added**,
because none of the 13 sub-150m pairs turned out to need one.

---

## Schema diff

```
 Column  |         Type          | Nullable |        Default
---------+-----------------------+----------+-----------------------
 tiploc  | text                  | not null |
 crs     | text                  |          |
 name    | text                  |          |
 lat     | double precision      |          |
 lon     | double precision      |          |
+geog    | geography(Point,4326) |          |
+mode    | text                  | not null | 'rail'::text
+network | text                  | not null | 'National Rail'::text
Indexes:
    "naptan_stations_pkey" PRIMARY KEY, btree (tiploc)
+   "idx_naptan_stations_geog" gist (geog)
```

## 1. Geometry column + spatial index

`geog geography(Point, 4326)`, populated from existing `lat`/`lon` for
every row that has them (2,626/2,637 — the same 11 null-coordinate rows
already known from the Phase A investigation). GiST index built and
**confirmed actually used** — `EXPLAIN` on a real `ST_DWithin` query shows
`Index Scan using idx_naptan_stations_geog`, not a fallback sequential
scan.

**Re-ran the exact three radius counts from the Phase A report against the
new column** to confirm the enrichment changed nothing about the
underlying data: 175 / 534 / 1,042 at 800/1200/1600m — identical to the
on-the-fly-cast numbers from before.

## 2. Mode/network

`mode` (default `'rail'`) and `network` (default `'National Rail'`),
populated from **real schedule data**, not a hand-maintained list: a
tiploc is set to `mode='metro'` only if it has at least one real
`calling_points`/`schedules` row *and* every one of those rows is operated
under ATOC `TW` (Tyne & Wear Metro) or `LT` (London Underground) — zero
genuine-other-operator presence. This is re-derivable against any future
backfill rather than a static list that goes stale.

Investigated this properly before running it, not by assumption — an
earlier, cruder attempt (checking `train_category = 'OL'`) looked promising
but was wrong: Newcastle Airport Metro Station has real non-`OL` category
rows too, which turned out to just be the *same* Tyne & Wear Metro operator
(`TW`) running under `OO`/`EE` categories for some workings — category
alone wasn't a clean signal, ATOC is.

**Complete, verified result — exactly 3 of 2,637 rows are `metro`:**

```
AIRP    | APN | Newcastle Airport Metro Station | metro | Tyne & Wear Metro
SEABURN | SEB | Seaburn Rail Station            | metro | Tyne & Wear Metro
SNDRMNK | STZ | St Peters Rail Station          | metro | Tyne & Wear Metro
```

All three are real Tyne & Wear Metro stations on the Sunderland extension,
registered in NROD's CIF feed despite not being National Rail. Checked the
edge case this could get wrong before trusting it: **Gunnersbury, Kew
Gardens, Queens Park, Harlesden, and Kenton** all carry genuine London
Underground (`LT`) schedule presence too, but also carry 1,400-2,100 real
*other*-operator calling points each (Overground/SWR services sharing the
same tracks) — correctly stayed `mode='rail'`, not misclassified as metro
just for having some LU trains.

**Final counts**: `2,634` rail, `3` metro, `2,637` total.

---

## Not done, per Part 1's conclusion

No exclusion list, no merge table, no `SAME_STATION`-style mapping added
for the 13 sub-150m pairs — investigation showed none of them are actual
duplicates, so there's nothing here to resolve.

## Explicitly not done, per this task's own scope

No walking edges computed or stored yet — that's step 2. No changes to
any other table, no code changes in any repo (this was a direct schema
change on the VPS Postgres, not a file-based diff — there's no git repo
tracking `naptan_stations`' schema to commit).

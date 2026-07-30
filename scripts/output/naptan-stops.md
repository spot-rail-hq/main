# NaPTAN stop extract

Generated 2026-07-30T13:18:04.152Z

Source: `https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv` — 435,193 rows parsed.

## In-scope networks

| Code | Network | Mode | Stops | Sourced | Δ |
|---|---|---|---:|---:|---:|
| LU | London Underground | underground | 272 | 272 | 0 |
| DL | Docklands Light Railway | dlr | 45 | 45 | 0 |
| CR | London Trams | tram | 39 | 39 | 0 |
| MA | Manchester Metrolink | tram | 99 | 99 | 0 |
| NO | Nottingham Express Transit | tram | 50 | 51 | -1 |
| SY | South Yorkshire Supertram | tram | 51 | 48 | +3 |
| WM | West Midlands Metro | tram | 47 | — | — |
| BP | Blackpool Tramway | tram | 40 | 38 | +2 |
| TW | Tyne and Wear Metro | metro | 60 | 60 | 0 |
| GL | Glasgow Subway | subway | 15 | 15 | 0 |
| ED | Edinburgh Trams | tram | 23 | 23 | 0 |
| | **Total** | | **741** | 728 | +13 |

## Excluded

| Reason | Count |
|---|---:|
| heritage / preserved railways (allowlist excludes by construction) | 195 |
| non-rail (cable car, air-rail links, shuttles) | 6 |
| other unrecognised systems | 0 |
| local-area duplicate MET rows | 11 |

## Overrides applied (misfiled ATCO system codes)

| ATCO | Name | Filed as | Corrected to |
|---|---|---|---|
| 9400ZZBPSUST | Battersea Power Station Underground Station | BP | LU |
| 9400ZZNEUGST | Nine Elms Underground Station | NE | LU |
| 9400ZZTWWJN | Newhaven (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJO | Ocean Terminal (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJP | Port of Leith (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJQ | The Shore (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJR | Foot of the Walk (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJS | Balfour Street (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJT | McDonald Road (Edinburgh Trams) | TW | ED |
| 9400ZZTWWJU | Picardy Place (Edinburgh Trams) | TW | ED |

# Wikipedia coverage scoping report — naptan_stations

Generated: 2026-07-15T20:20:03.338Z
Updated: 2026-07-16T10:58:42.691Z (Phase 1 abbreviation re-test + geo-match-town-article detection folded in)

## Match rate (Phase 1)
- Auto-matched: 2577 / 2637
- Needs manual review: 60 / 2637

## Tier breakdown (Phase 2)
- no-article: 60
- stub (extract < 400 chars): 2099
- substantive (extract >= 400 chars): 472
- geo-match-town-article (geo-confidence match landed on a town/place article, not a dedicated station article — see geoMatchTownArticleDetail in the JSON report for handling rules): 6

## geo-match-town-article — full list (6 stations)
- **ADL** (Adlington (Lancs) Rail Station) — matched "Adlington, Lancashire" (Village and civil parish in Lancashire, England)
- **ARM** (Armadale (W Lothian) Rail Station) — matched "Armadale, West Lothian" (Town in West Lothian, Scotland)
- **BIB** (Bishop's Lydeard Rail Station) — matched "Bishops Lydeard" (Village and civil parish in Somerset, England)
- **BMY** (Bramley (Hants) Rail Station) — matched "Bramley, Hampshire" (Village and parish in Hampshire, England)
- **SNN** (Swinton (Manchester) Rail Station) — matched "Swinton, Greater Manchester" (Town in Greater Manchester, England)
- **WCH** (Whitchurch (Hants) Rail Station) — matched "Whitchurch, Hampshire" (Town in Hampshire, England)

Handling (agreed 2026-07-16, applies at full rollout time): keep the already-extracted notable_features as-is; change source attribution to make the town-article origin explicit (e.g. "Source: Wikipedia (Placename)" not "...(Placename railway station)"); do NOT auto-populate a Wikipedia deep-link, since there's no dedicated station page to send a reader to.

## Sample substantive entries
### London Victoria Rail Station (VIC) — matched "London Victoria station", 1318 chars
> Victoria station, also known as London Victoria, is a central London railway terminus and connected London Underground station in Victoria, in the City of Westminster, managed by Network Rail. Named after the nearby Victoria Street, the mainline station is a terminus of the Brighton Main Line to Gatwick Airport and Brighton and the Chatham Main Line to Ramsgate and Dover via Chatham. From the main lines, trains can connect to the Catford Loop Line, the Dartford Loop Line, the Sutton & Mole Valle…

### Barking Rail Station (BKG) — matched "Barking station", 1123 chars
> Barking is an interchange station in the town of Barking in the London Borough of Barking and Dagenham, East London. It is on the London, Tilbury and Southend line, 7 miles 42 chains (12.1 km) down the line from Fenchurch Street in Central London. On the London Underground, it is on the District line and is the eastern terminus of the Hammersmith & City line. On the London Overground, it is on the Suffragette line. The station was opened by the London, Tilbury and Southend Railway on 13 April 18…

### Upminster Rail Station (UPM) — matched "Upminster station", 1037 chars
> Upminster is an interchange station in the town of Upminster in the London Borough of Havering, East London. It is on the London, Tilbury and Southend line, 15 miles 20 chains (24.5 km) down the line from Fenchurch Street in Central London. It is the eastern terminus of the District line on the London Underground and the eastern terminus of the Liberty line on the London Overground. The station was originally opened on 1 May 1885 by the London, Tilbury and Southend Railway on a new direct route …

### Three Bridges Rail Station (TBD) — matched "Three Bridges railway station", 967 chars
> Three Bridges railway station serves the village of Three Bridges, a district of the town of Crawley, in West Sussex, England. This station is where the Arun Valley Line and the Brighton Main Line diverge. Greater Thameslink Railway operates all services, under two brands. Firstly Thameslink operates the majority of services at the station, between Bedford and Brighton, Bedford and Three Bridges, Cambridge and Brighton, and Peterborough and Horsham. The second, the Southern-branded service also …

### Stirling Rail Station (STG) — matched "Stirling", 936 chars
> Stirling is a city in central Scotland, 26 miles (42 km) north-east of Glasgow and 37 miles (60 km) north-west of Edinburgh. The city is surrounded by rich farmland and had a royal citadel, the medieval old town with its merchants and tradesmen, the Old Bridge and the port are all linked in to its history. Situated on the River Forth, Stirling is the administrative centre for the Stirling council area, and is traditionally the county town and historic county of Stirlingshire. Stirling's key posi…

### Ferriby Rail Station (FRY) — matched "Ferriby railway station", 886 chars
> Ferriby railway station serves the village of North Ferriby in the East Riding of Yorkshire, England. The station, and all trains serving it, are operated by Northern. It is situated on the former Hull and Selby Railway, 7+1⁄2 miles (12.1 km) west of Hull Paragon. It has a slightly unusual layout, in that the eastbound platform is located on the main running line but the westbound one is on a loop which continues on towards Brough. The line from Gilberdyke towards Hull through here was quadruple…

### Canary Wharf (CWX) — matched "Canary Wharf railway station", 864 chars
> Canary Wharf is an Elizabeth line station in Canary Wharf on the Isle of Dogs in east London, England. The station forms an artificial island in the West India Docks. The five upper levels of the station are a mixed-use development known as Crossrail Place. It is on the Abbey Wood branch of the Elizabeth line between Whitechapel and Custom House. Construction began in May 2009, and the station opened on 24 May 2022 when the section between Paddington and Abbey Wood stations began services. Durin…

### Parson Street Rail Station (PSN) — matched "Parson Street railway station", 857 chars
> Parson Street railway station serves the western end of Bedminster in Bristol, England. It also serves other surrounding suburbs including Bishopsworth, Ashton Vale and Ashton Gate, along with Bristol City FC. It is 2 miles (3.2 km) from Bristol Temple Meads, and 120 miles (193 km) from London Paddington. Its three letter station code is PSN. It was opened in 1927 by the Great Western Railway, and was rebuilt in 1933. The station, which has two through-lines and two platforms, plus one freight l…


## Needs manual review — breakdown by cause
- disambiguation-only-likely-has-article: 24 (untouched)
- unverified-page-found: 1 (untouched)
- no-page-found-any-candidate: 25 (untouched)
- mixed-other (abbreviation mismatch): 10 remaining (11 resolved via the abbreviation table in Phase 1, LAY additionally resolved via the '(England)' fallback candidate)

## Needs manual review (first 30 of 60)
- **ADV** (Andover Rail Station): No Wikipedia page found for any candidate title.
- **ALX** (Alexandria Rail Station): No Wikipedia page found for any candidate title.
- **APN** (Newcastle Airport Metro Station): No Wikipedia page found for any candidate title.
- **ASF** (Ashfield Rail Station): No Wikipedia page found for any candidate title.
- **BCZ** (Brent Cross West Station): No Wikipedia page found for any candidate title.
- **BLM** (Belmont Rail Station): No Wikipedia page found for any candidate title.
- **BTR** (Braintree Rail Station): No Wikipedia page found for any candidate title.
- **CBK** (Cranbrook Rail Station): No Wikipedia page found for any candidate title.
- **CHR** (Christchurch Rail Station): No Wikipedia page found for any candidate title.
- **CTM** (Chatham Rail Station): No Wikipedia page found for any candidate title.
- **DMG** (Dinas (Rhondda) Rail Station): No Wikipedia page found for any candidate title.
- **DVN** (Davenport Rail Station): No Wikipedia page found for any candidate title.
- **FRF** (Fairfield Rail Station): No Wikipedia page found for any candidate title.
- **GCL** (Glasgow Central Low Level Rail Station): No Wikipedia page found for any candidate title.
- **GQL** (Glasgow Queen Street Low Level Rail Station): No Wikipedia page found for any candidate title.
- **HFX** (Halifax Rail Station): No Wikipedia page found for any candidate title.
- **HGM** (Higham Rail Station): No Wikipedia page found for any candidate title.
- **HIG** (Highbridge & Burnham-on-Sea Rail Station): No Wikipedia page found for any candidate title.
- **KNG** (Kingston Rail Station): No Wikipedia page found for any candidate title.
- **KTR** (Kintore Railway Station): No Wikipedia page found for any candidate title.
- **LAG** (Langwith - Whaley Thorns Rail Station): No Wikipedia page found for any candidate title.
- **LIF** (Lichfield Trent Valley High Level Rail Station): No Wikipedia page found for any candidate title.
- **LVL** (Liverpool Lime Street Low Level Rail Station): No Wikipedia page found for any candidate title.
- **MFD** (Minffordd Ffestiniog Railway Station): No Wikipedia page found for any candidate title.
- **MTO** (Marton Rail Station): No Wikipedia page found for any candidate title.
- **MUF** (Manchester United FC Rail Station): Found a page ("Manchester United F.C.") but couldn't confirm it's the right one — title doesn't match and no coordinates to check.
- **NAR** (Narberth Rail Station): No Wikipedia page found for any candidate title.
- **NBE** (Newbridge Rail Station): No Wikipedia page found for any candidate title.
- **NCO** (Newcourt Rail Station): No Wikipedia page found for any candidate title.
- **NMK** (Newmarket Rail Station): No Wikipedia page found for any candidate title.

Full CRS lists per tier and the complete review list are in wikipedia-coverage-report.json.

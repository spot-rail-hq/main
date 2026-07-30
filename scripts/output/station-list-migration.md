# station-list.json migration

Generated 2026-07-30T13:17:24.571Z

| | rows |
|---|---:|
| before | 2629 |
| removed (closed) | 1 |
| existing rows kept | 2628 |
| appended non-CRS stops | 632 |
| suppressed within 150m (recorded as interchange) | 109 |
| **after** | **3260** |

`atco` backfilled on 2621/2628 existing rows via exact 5dp coordinate join.

## Rows keeping CRS as identity (atco null)

| CRS | Name |
|---|---|
| BDS | Bond Street |
| BGV | Barking Riverside |
| CUS | Custom House |
| CWX | Canary Wharf |
| STQ | Southampton Town Quay |
| TCR | Tottenham Court Road |
| WWC | Woolwich |

## Per network

| Network | Extracted | Appended | Suppressed |
|---|---:|---:|---:|
| London Underground | 272 | 213 | 59 |
| Manchester Metrolink | 99 | 92 | 7 |
| Tyne and Wear Metro | 60 | 50 | 10 |
| South Yorkshire Supertram | 51 | 48 | 3 |
| Nottingham Express Transit | 50 | 47 | 3 |
| West Midlands Metro | 47 | 42 | 5 |
| Docklands Light Railway | 45 | 36 | 9 |
| Blackpool Tramway | 40 | 39 | 1 |
| London Trams | 39 | 32 | 7 |
| Edinburgh Trams | 23 | 20 | 3 |
| Glasgow Subway | 15 | 13 | 2 |

## Kept despite being within 150m (names disagree)

| Distance | ATCO | Name | Nearest CRS |
|---:|---|---|---|
| 133 m | 9400ZZWMBS | St Chad's | BSW Birmingham Snow Hill Rail Station |
| 148 m | 9400ZZWMAS | Albert Street | BMO Birmingham Moor Street Rail Station |
| 149 m | 9400ZZDLWIQ | West India Quay | CWX Canary Wharf |

## Suppressed stops

| ATCO | Name | Network | Onto CRS | Distance | Matched by |
|---|---|---|---|---:|---|
| 9400ZZTWAPT | Newcastle Airport | Tyne and Wear Metro | APN | 0 m | name match |
| 9400ZZLUHOH | Harrow-on-the-Hill | London Underground | HOH | 1 m | name match |
| 9400ZZNOHKL | Hucknall | Nottingham Express Transit | HKN | 1 m | name match |
| 9400ZZTWBRW | Brockley Whins | Tyne and Wear Metro | BNR | 1 m | name match |
| 9400ZZTWSTP | St Peter's | Tyne and Wear Metro | STZ | 1 m | name match |
| 9400ZZCRELM | Elmers End | London Trams | ELE | 2 m | name match |
| 9400ZZLUHR5 | Heathrow Terminal 5 | London Underground | HWV | 2 m | name match |
| 9400ZZLUSKT | South Kenton | London Underground | SOK | 3 m | name match |
| 9400ZZLUCWR | Canada Water | London Underground | ZCW | 5 m | name match |
| 9400ZZLUKSL | Kensal Green | London Underground | KNL | 5 m | name match |
| 9400ZZLUNWY | North Wembley | London Underground | NWB | 5 m | name match |
| 9400ZZLUUPM | Upminster | London Underground | UPM | 5 m | name match |
| 9400ZZLUKEN | Kenton | London Underground | KNT | 7 m | name match |
| 9400ZZLUWWL | Walthamstow Central | London Underground | WHC | 7 m | name match |
| 9400ZZGLPRT | Partick | Glasgow Subway | PTK | 9 m | name match |
| 9400ZZSYMHI | Meadowhall Interchange | South Yorkshire Supertram | MHS | 10 m | name match |
| 9400ZZLUSTD | Stratford | London Underground | SRA | 11 m | name match |
| 9400ZZLUWRP | West Ruislip | London Underground | WRU | 11 m | name match |
| 9400ZZDLWLA | Woolwich Arsenal | Docklands Light Railway | WWA | 12 m | name match |
| 9400ZZLUAMS | Amersham | London Underground | AMR | 12 m | name match |
| 9400ZZLUKWG | Kew Gardens | London Underground | KWG | 13 m | name match |
| 9400ZZLUWIM | Wimbledon | London Underground | WIM | 13 m | name match |
| 9400ZZCRBIR | Birkbeck | London Trams | BIK | 14 m | name match |
| 9400ZZLUGBY | Gunnersbury | London Underground | GUN | 14 m | name match |
| 9400ZZLUHSN | Harlesden | London Underground | HDN | 15 m | name match |
| 9400ZZDLLIM | Limehouse | Docklands Light Railway | LHS | 16 m | name match |
| 9400ZZLUCYD | Chorleywood | London Underground | CLW | 16 m | name match |
| 9400ZZLUWPL | Whitechapel | London Underground | ZLW | 16 m | name match |
| 9400ZZDLSTD | Stratford | Docklands Light Railway | SRA | 17 m | name match |
| 9400ZZLUCST | Cannon Street | London Underground | CST | 17 m | name match |
| 9400ZZLUSGP | Stonebridge Park | London Underground | SBP | 17 m | name match |
| 9400ZZLUCAL | Chalfont & Latimer | London Underground | CFO | 18 m | name match |
| 9400ZZLUEUS | Euston | London Underground | EUS | 18 m | name match |
| 9400ZZLUGFD | Greenford | London Underground | GFD | 18 m | name match |
| 9400ZZLUBKG | Barking | London Underground | BKG | 22 m | name match |
| 9400ZZLUFCN | Farringdon | London Underground | ZFD | 22 m | name match |
| 9400ZZLUWBN | West Brompton | London Underground | WBP | 23 m | name match |
| 9400ZZDLGRE | Greenwich | Docklands Light Railway | GNW | 24 m | name match |
| 9400ZZTWNDP | Northumberland Park | Tyne and Wear Metro | NOP | 24 m | name match |
| 9400ZZLURMD | Richmond | London Underground | RMD | 25 m | name match |
| 9400ZZLUSRP | South Ruislip | London Underground | SRU | 25 m | name match |
| 9400ZZWMJQ | Jewellery Quarter | West Midlands Metro | JEQ | 25 m | name match |
| 9400ZZLUEBY | Ealing Broadway | London Underground | EAL | 28 m | name match |
| 9400ZZLURKW | Rickmansworth | London Underground | RIC | 29 m | name match |
| 9400ZZLUWYC | Wembley Central | London Underground | WMB | 29 m | name match |
| 9400ZZLUMYB | Marylebone | London Underground | MYB | 30 m | name match |
| 9400ZZLUKSX | King's Cross St. Pancras | London Underground | KGX | 31 m | curated same-station |
| 9400ZZLUTMH | Tottenham Hale | London Underground | TOM | 31 m | name match |
| 9400ZZLUWJN | Willesden Junction | London Underground | WIJ | 32 m | name match |
| 9400ZZTWSBN | Seaburn | Tyne and Wear Metro | SEB | 32 m | name match |
| 9400ZZLUKSH | Kentish Town | London Underground | KTN | 33 m | name match |
| 9400ZZLUBKF | Blackfriars | London Underground | BFR | 34 m | name match |
| 9400ZZLUBLR | Blackhorse Road | London Underground | BHO | 35 m | name match |
| 9400ZZCRMJT | Mitcham Junction | London Trams | MIJ | 36 m | name match |
| 9400ZZLUHAI | Highbury & Islington | London Underground | HHY | 36 m | name match |
| 9400ZZLUHR4 | Heathrow Terminal 4 | London Underground | HAF | 36 m | name match |
| 9400ZZLUQPS | Queen's Park | London Underground | QPW | 36 m | name match |
| 9400ZZMAPIC | Piccadilly | Manchester Metrolink | MAN | 36 m | name match |
| 9400ZZLUKOY | Kensington (Olympia) | London Underground | KPA | 39 m | name match |
| 9400ZZLUBLM | Balham | London Underground | BAL | 40 m | name match |
| 9400ZZLUFPK | Finsbury Park | London Underground | FPK | 41 m | name match |
| 9400ZZDLCUS | Custom House (for ExCel) | Docklands Light Railway | CUS | 42 m | name match |
| 9400ZZCRWMB | Wimbledon | London Trams | WIM | 44 m | name match |
| 9400ZZTWHPW | Heworth | Tyne and Wear Metro | HEW | 45 m | name match |
| 9400ZZEDPKS | Edinburgh Park Station | Edinburgh Trams | EDP | 46 m | name match |
| 9400ZZLUHAW | Harrow & Wealdstone | London Underground | HRW | 46 m | name match |
| 9400ZZLUWHM | West Ham | London Underground | WEH | 47 m | name match |
| 9400ZZDLSHA | Shadwell | Docklands Light Railway | SDE | 50 m | name match |
| 9400ZZTWEBN | East Boldon | Tyne and Wear Metro | EBL | 51 m | name match |
| 9400ZZCRBEK | Beckenham Junction | London Trams | BKJ | 53 m | name match |
| 9400ZZLUODS | Old Street | London Underground | OLD | 53 m | name match |
| 9400ZZMANAV | Navigation Road | Manchester Metrolink | NVR | 54 m | name match |
| 9400ZZNONOT | Nottingham Station | Nottingham Express Transit | NOT | 54 m | name match |
| 9400ZZLUMGT | Moorgate | London Underground | MOG | 55 m | name match |
| 9400ZZMAAIR | Manchester Airport | Manchester Metrolink | MIA | 55 m | name match |
| 9400ZZWMHA | The Hawthorns | West Midlands Metro | THW | 59 m | name match |
| 9400ZZWMDP | Dudley Port | West Midlands Metro | DDP | 67 m | name match |
| 9400ZZMAALT | Altrincham | Manchester Metrolink | ALT | 67 m | name match |
| 9400ZZWMWR | Wolverhampton Station | West Midlands Metro | WVH | 68 m | name match |
| 9400ZZCRECR | East Croydon | London Trams | ECR | 70 m | name match |
| 9400ZZNOBWL | Bulwell | Nottingham Express Transit | BLW | 70 m | name match |
| 9400ZZSYSHU | Sheffield Stn - Hallam Uni | South Yorkshire Supertram | SHF | 70 m | name match |
| 9400ZZLUPAC | Paddington | London Underground | PAD | 73 m | name match |
| 9400ZZDLSIT | Stratford International | Docklands Light Railway | SFA | 77 m | name match |
| 9400ZZEDHAY | Haymarket | Edinburgh Trams | HYM | 80 m | name match |
| 9400ZZLUNBP | Newbury Park | London Underground | NRC | 80 m | name match |
| 9400ZZMAGMX | Deansgate-Castlefield | Manchester Metrolink | DGT | 81 m | name match |
| 9400ZZMAVIC | Victoria | Manchester Metrolink | MCV | 82 m | name match |
| 9400ZZCRWCR | West Croydon | London Trams | WCY | 86 m | name match |
| 9400ZZLUBXN | Brixton | London Underground | BRX | 90 m | name match |
| 9400ZZDLWHM | West Ham | Docklands Light Railway | WEH | 93 m | name match |
| 9400ZZLUWHP | West Hampstead | London Underground | WHD | 93 m | name match |
| 9400ZZMARRS | Rochdale | Manchester Metrolink | RCD | 102 m | name match |
| 9400ZZLUVXL | Vauxhall | London Underground | VXH | 104 m | name match |
| 9400ZZEDGAT | Edinburgh Gateway | Edinburgh Trams | EGY | 108 m | name match |
| 9400ZZLUBND | Bond Street | London Underground | BDS | 108 m | name match |
| 9400ZZSYRTH | Rotherham Station | South Yorkshire Supertram | RMC | 108 m | name match |
| 9400ZZTWCST | Central Station | Tyne and Wear Metro | NCL | 108 m | curated same-station |
| 9400ZZWMNWS | Grand Central | West Midlands Metro | BHM | 108 m | curated same-station |
| 9400ZZBPNRS | North Station | Blackpool Tramway | BPN | 111 m | name match |
| 9400ZZLUWLO | Waterloo | London Underground | WAT | 116 m | name match |
| 9400ZZGLBUC | Buchanan Street | Glasgow Subway | GLQ | 125 m | curated same-station |
| 9400ZZLUSBC | Shepherd's Bush (Central) | London Underground | SPB | 129 m | name match |
| 9400ZZTWSND | Sunderland | Tyne and Wear Metro | SUN | 134 m | name match |
| 9400ZZDLLEW | Lewisham | Docklands Light Railway | LEW | 139 m | name match |
| 9400ZZLULVT | Liverpool Street | London Underground | LST | 140 m | name match |
| 9400ZZTWMNS | Manors | Tyne and Wear Metro | MAS | 140 m | name match |
| 9400ZZLUEAC | Elephant & Castle | London Underground | EPH | 142 m | name match |
| 9400ZZLUHRC | Heathrow Terminals 2 & 3 | London Underground | LHR | 145 m | name match |

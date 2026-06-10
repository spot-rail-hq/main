// UK network — real lat/lng coords for Leaflet map.
// Coords are approximate station/city locations.

const STATIONS = {
  'Inverness':    [57.4800, -4.2236],
  'Aberdeen':     [57.1435, -2.0981],
  'Dundee':       [56.4568, -2.9713],
  'Glasgow':      [55.8586, -4.2579],
  'Edinburgh':    [55.9521, -3.1883],
  'Newcastle':    [54.9683, -1.6174],
  'Carlisle':     [54.8902, -2.9331],
  'York':         [53.9583, -1.0933],
  'Leeds':        [53.7946, -1.5492],
  'Hull':         [53.7440, -0.3456],
  'Preston':      [53.7563, -2.7083],
  'Manchester':   [53.4775, -2.2307],
  'Liverpool':    [53.4078, -2.9783],
  'Sheffield':    [53.3781, -1.4620],
  'Holyhead':     [53.3090, -4.6320],
  'Crewe':        [53.0899, -2.4328],
  'Derby':        [52.9160, -1.4630],
  'Nottingham':   [52.9476, -1.1468],
  'Shrewsbury':   [52.7114, -2.7495],
  'Birmingham':   [52.4778, -1.8996],
  'Norwich':      [52.6272, 1.3080],
  'Cambridge':    [52.1942, 0.1372],
  'Oxford':       [51.7535, -1.2700],
  'Swansea':      [51.6265, -3.9418],
  'Cardiff':      [51.4757, -3.1799],
  'Bristol':      [51.4492, -2.5808],
  'Reading':      [51.4584, -0.9710],
  'London':       [51.5285, -0.1240],
  'Southampton':  [50.9072, -1.4169],
  'Brighton':     [50.8290, -0.1410],
  'Dover':        [51.1279, 1.3134],
  'Exeter':       [50.7290, -3.5430],
  'Plymouth':     [50.3780, -4.1427],
  'Penzance':     [50.1186, -5.5348],
};

// Each route carries a `geometry` array of [lat,lng] waypoints that follow the
// actual railway corridor (hand-traced from OSM/ORM). Includes the named stations
// but adds intermediate waypoints so the line bends correctly across the country.

const ROUTES = [
  {
    id: 'wcml', name: 'West Coast Main Line', color: 'var(--color-accent-turquoise)',
    operator: 'Avanti West Coast · Caledonian Sleeper · LNR',
    classes: ['390', '805', '350', '730'],
    freq: '~3 trains per hour',
    journey: 'London Euston ↔ Glasgow Central · 4h 10m',
    about: 'The primary rail corridor between London, the West Midlands, the North West, and Scotland. Electrified at 25kV AC throughout.',
    path: ['London', 'Birmingham', 'Crewe', 'Preston', 'Carlisle', 'Glasgow'],
    geometry: [
      [51.5285, -0.1240], [51.5331, -0.1337], [51.6820, -0.3650], // Euston → Watford
      [51.9038, -0.7500], [52.0406, -0.7594], // Leighton Buzzard → Milton Keynes
      [52.2053, -0.8902], [52.4778, -1.8996], // Northampton → New St (Birmingham)
      [52.7114, -2.7495], [53.0899, -2.4328], // Wolverhampton → Crewe
      [53.2267, -2.4297], [53.3820, -2.6630], // Hartford → Warrington Bank Quay
      [53.6097, -2.7500], [53.7563, -2.7083], // Wigan → Preston
      [54.0466, -2.8007], [54.3050, -2.7450], // Lancaster → Oxenholme
      [54.5767, -2.7620], [54.8902, -2.9331], // Penrith → Carlisle
      [55.0610, -3.3170], [55.4060, -3.6390], // Lockerbie → Beattock summit
      [55.6500, -3.9500], [55.8586, -4.2579], // Motherwell → Glasgow Central
    ],
  },
  {
    id: 'ecml', name: 'East Coast Main Line', color: 'var(--color-accent-amber)',
    operator: 'LNER · Lumo · Grand Central · Hull Trains',
    classes: ['800', '801', '803', '802'],
    freq: '~2 trains per hour',
    journey: "London King's Cross ↔ Edinburgh Waverley · 4h 20m",
    about: 'The fast east-side corridor from London to the North East and Scotland, via Peterborough, York and Newcastle.',
    path: ['London', 'York', 'Newcastle', 'Edinburgh'],
    geometry: [
      [51.5308, -0.1238], [51.7760, -0.2090], // King's Cross → Hatfield
      [51.9500, -0.1986], [52.3555, -0.2750], // Stevenage → Huntingdon
      [52.5751, -0.2425], [52.9540, -0.1649], // Peterborough → Grantham
      [53.2324, -0.5384], [53.5700, -0.6620], // Newark → Retford
      [53.7200, -0.9450], [53.9583, -1.0933], // Doncaster → York
      [54.2753, -1.4139], [54.5742, -1.2349], // Northallerton → Darlington
      [54.7752, -1.5849], [54.9683, -1.6174], // Durham → Newcastle
      [55.2078, -1.5397], [55.4175, -1.7070], // Morpeth → Alnmouth
      [55.5784, -1.9910], [55.7700, -2.2550], // Berwick → Dunbar outskirts
      [55.9995, -2.5180], [55.9521, -3.1883], // Dunbar → Edinburgh Waverley
    ],
  },
  {
    id: 'gwml', name: 'Great Western Main Line', color: 'var(--color-accent-magenta)',
    operator: 'GWR · Heathrow Express',
    classes: ['800', '802', '387', '166'],
    freq: '~4 trains per hour',
    journey: 'London Paddington ↔ Cardiff / Swansea',
    about: "Brunel's line to the West — now fully electrified to Cardiff and worked by Hitachi IETs.",
    path: ['London', 'Reading', 'Bristol', 'Cardiff', 'Swansea'],
    geometry: [
      [51.5168, -0.1772], [51.5075, -0.3260], // Paddington → Ealing Broadway
      [51.4600, -0.5893], [51.4584, -0.9710], // Slough → Reading
      [51.4530, -1.3215], [51.4630, -1.6300], // Didcot-ish → Swindon
      [51.4790, -2.0840], [51.4492, -2.5808], // Chippenham → Bristol Temple Meads
      [51.5120, -2.6480], [51.5800, -2.9850], // Severn Tunnel Jn (real geometry dips NW)
      [51.5870, -3.0040], // Severn Tunnel W portal
      [51.5390, -3.0790], [51.4757, -3.1799], // Newport → Cardiff Central
      [51.5540, -3.4680], [51.6265, -3.9418], // Bridgend/Pt Talbot → Swansea
    ],
  },
  {
    id: 'midland', name: 'Midland Main Line', color: 'var(--color-accent-lime)',
    operator: 'East Midlands Railway',
    classes: ['810', '222', '158'],
    freq: '~2 trains per hour',
    journey: 'London St Pancras ↔ Sheffield · 2h',
    about: 'Connects London to the East Midlands and South Yorkshire, operated by bi-mode Class 810 Auroras.',
    path: ['London', 'Derby', 'Nottingham', 'Sheffield'],
    geometry: [
      [51.5320, -0.1260], [51.7520, -0.3360], // St Pancras → Luton
      [51.8780, -0.4200], [52.1378, -0.4662], // Bedford
      [52.3806, -0.6890], [52.5720, -1.1250], // Kettering → Market Harborough
      [52.6360, -1.1330], [52.8720, -1.3390], // Leicester → Loughborough
      [52.9160, -1.4630], // Derby
      [52.9476, -1.1468], // Nottingham (branch joins)
      [53.0820, -1.4790], [53.2470, -1.4200], // Alfreton → Chesterfield
      [53.3781, -1.4620], // Sheffield
    ],
  },
  {
    id: 'xc', name: 'CrossCountry', color: '#9D7CFF',
    operator: 'CrossCountry',
    classes: ['220', '221', '170'],
    freq: '1 train per hour',
    journey: 'Aberdeen ↔ Penzance · the longest scheduled journey in Britain',
    about: "The UK's spine connector — bypasses London to link Scotland, the North East, Midlands and South West.",
    path: ['Aberdeen', 'Edinburgh', 'Newcastle', 'York', 'Sheffield', 'Birmingham', 'Bristol', 'Exeter', 'Plymouth', 'Penzance'],
    geometry: [
      [57.1435, -2.0981], [56.7010, -2.4700], [56.4568, -2.9713], // Aberdeen → Dundee
      [56.1700, -3.1700], [55.9521, -3.1883], // Kirkcaldy → Edinburgh
      [55.7700, -2.2550], [55.5784, -1.9910], [54.9683, -1.6174], // Berwick → Newcastle
      [54.5742, -1.2349], [53.9583, -1.0933], // Darlington → York
      [53.7200, -1.2100], [53.3781, -1.4620], // Leeds dip avoided; straight to Sheffield
      [53.0100, -1.4850], [52.6500, -1.5950], // Chesterfield → Burton area
      [52.4778, -1.8996], // Birmingham New Street
      [52.1870, -2.2210], [51.9000, -2.0780], // Worcester → Cheltenham
      [51.6650, -2.4150], [51.4492, -2.5808], // Bristol Parkway → Temple Meads
      [51.1500, -2.9800], [50.9710, -3.2230], // Taunton → Tiverton
      [50.7290, -3.5430], // Exeter
      [50.5280, -3.6130], [50.4660, -3.7760], // Newton Abbot → Dawlish coast
      [50.3780, -4.1427], // Plymouth
      [50.3870, -4.7570], [50.2600, -5.0500], // Liskeard → Truro area
      [50.1186, -5.5348], // Penzance
    ],
  },
  {
    id: 'swml', name: 'South Western Main Line', color: 'var(--color-accent-turquoise)',
    operator: 'South Western Railway',
    classes: ['444', '450', '458', '701'],
    freq: '~4 trains per hour',
    journey: 'London Waterloo ↔ Exeter (West of England line)',
    about: "Third-rail electrified to Weymouth plus the diesel West of England line out to Exeter via Salisbury.",
    path: ['London', 'Southampton', 'Exeter'],
    geometry: [
      [51.5031, -0.1132], [51.3780, -0.3220], // Waterloo → Woking area
      [51.2400, -0.5760], [51.0680, -1.3130], // Basingstoke (branch split in reality)
      [51.0690, -1.4780], [51.0630, -1.3130], // Winchester
      [50.9072, -1.4169], // Southampton Central
      // West of England branch cuts back inland
      [51.0360, -1.5500], [51.0730, -1.7970], // Salisbury area
      [51.0070, -2.3900], [50.9230, -2.9180], // Yeovil Jn → Axminster
      [50.8100, -3.1200], [50.7290, -3.5430], // Honiton → Exeter St Davids
    ],
  },
  {
    id: 'bml', name: 'Brighton Main Line', color: '#FF7A6B',
    operator: 'Southern · Thameslink · Gatwick Express',
    classes: ['377', '700', '387'],
    freq: '~8 trains per hour',
    journey: 'London Victoria / Bridge ↔ Brighton · 55m',
    about: 'One of the busiest commuter corridors in the UK. Third-rail 750V DC throughout.',
    path: ['London', 'Brighton'],
    geometry: [
      [51.4952, -0.1440], // Victoria
      [51.4100, -0.1910], // East Croydon
      [51.3200, -0.1200], // Redhill
      [51.1537, -0.1821], // Gatwick Airport
      [51.0770, -0.1730], // Three Bridges
      [51.0100, -0.1410], // Haywards Heath
      [50.9120, -0.1310], // Burgess Hill
      [50.8290, -0.1410], // Brighton
    ],
  },
  {
    id: 'c2c', name: 'High Speed 1 · Kent', color: 'var(--color-accent-amber)',
    operator: 'Southeastern',
    classes: ['395', '375', '377', '707'],
    freq: '~4 trains per hour',
    journey: 'London St Pancras ↔ Ashford / Dover · via HS1',
    about: 'High Speed 1 domestic services run by Class 395 Javelins at 140 mph.',
    path: ['London', 'Dover'],
    geometry: [
      [51.5320, -0.1260], // St Pancras
      [51.5450, 0.0040], // Stratford International
      [51.4750, 0.2450], // Ebbsfleet International
      [51.3460, 0.4850], // Medway viaduct area
      [51.2470, 0.6400], // Ashford area
      [51.1650, 0.8720], // Folkestone West
      [51.1279, 1.3134], // Dover Priory
    ],
  },
  {
    id: 'anglia', name: 'Great Eastern Main Line', color: 'var(--color-accent-lime)',
    operator: 'Greater Anglia',
    classes: ['745', '755', '720'],
    freq: '~3 trains per hour',
    journey: 'London Liverpool Street ↔ Norwich · 1h 50m',
    about: 'Operated by Stadler Class 745 FLIRTs — among the newest long-distance EMUs in Britain.',
    path: ['London', 'Norwich'],
    geometry: [
      [51.5180, -0.0815], // Liverpool Street
      [51.5860, 0.0660], // Stratford-ish / Chelmsford approach
      [51.7363, 0.4686], // Chelmsford
      [51.8884, 0.9027], // Colchester
      [51.9985, 1.1610], // Manningtree
      [52.0567, 1.1483], // Ipswich
      [52.2380, 1.1700], // Stowmarket
      [52.4430, 1.1960], // Diss
      [52.6272, 1.3080], // Norwich
    ],
  },
  {
    id: 'transpennine', name: 'TransPennine (North)', color: 'var(--color-accent-magenta)',
    operator: 'TransPennine Express · Northern',
    classes: ['802', '185', '397', '195'],
    freq: '~2 trains per hour',
    journey: 'Liverpool ↔ Manchester ↔ Leeds ↔ Newcastle',
    about: 'The main east–west link across northern England.',
    path: ['Liverpool', 'Manchester', 'Leeds', 'York', 'Newcastle'],
    geometry: [
      [53.4078, -2.9783], // Liverpool Lime St
      [53.4560, -2.7300], // Newton-le-Willows
      [53.4775, -2.2307], // Manchester
      [53.5640, -2.1290], // Stalybridge
      [53.6000, -1.9720], // Diggle
      [53.6450, -1.7800], // Marsden
      [53.6480, -1.7830], // Huddersfield
      [53.7220, -1.6520], // Dewsbury
      [53.7946, -1.5492], // Leeds
      [53.8670, -1.3690], // Garforth
      [53.9583, -1.0933], // York
      [54.2753, -1.4139], [54.5742, -1.2349], // Northallerton → Darlington
      [54.9683, -1.6174], // Newcastle
    ],
  },
  {
    id: 'northwales', name: 'North Wales Coast Line', color: '#9D7CFF',
    operator: 'Avanti West Coast · Transport for Wales',
    classes: ['221', '197', '67'],
    freq: '~1 train per hour',
    journey: 'Holyhead ↔ Crewe (→ London / Manchester)',
    about: 'Serves the Irish ferry port at Holyhead and runs along the scenic North Wales coast.',
    path: ['Holyhead', 'Crewe'],
    geometry: [
      [53.3090, -4.6320], // Holyhead
      [53.2240, -4.3010], // Bangor
      [53.2820, -3.8300], // Llanfairfechan
      [53.2900, -3.7280], // Llandudno Jn
      [53.3260, -3.4850], // Rhyl
      [53.2870, -3.2050], // Flint
      [53.1930, -3.0540], // Chester
      [53.1010, -2.7470], // Beeston area
      [53.0899, -2.4328], // Crewe
    ],
  },
  {
    id: 'welsh', name: 'Welsh Marches', color: '#FF7A6B',
    operator: 'Transport for Wales',
    classes: ['197', '175', '158'],
    freq: '~1 train per hour',
    journey: 'Cardiff ↔ Shrewsbury ↔ Manchester',
    about: 'The main inland route through mid-Wales and the borders.',
    path: ['Cardiff', 'Shrewsbury', 'Crewe', 'Manchester'],
    geometry: [
      [51.4757, -3.1799], // Cardiff
      [51.5870, -3.0080], // Newport
      [51.6540, -2.9730], // Cwmbran
      [51.8170, -3.0150], // Abergavenny
      [52.0580, -2.7150], // Hereford
      [52.2910, -2.7290], // Leominster
      [52.3670, -2.7300], // Ludlow
      [52.5080, -2.7620], // Craven Arms
      [52.7114, -2.7495], // Shrewsbury
      [52.9580, -2.5170], // Whitchurch
      [53.0899, -2.4328], // Crewe
      [53.1900, -2.3940], [53.4775, -2.2307], // Sandbach → Manchester Piccadilly
    ],
  },
  {
    id: 'scotland-h', name: 'Highland Main Line', color: 'var(--color-accent-turquoise)',
    operator: 'ScotRail · Caledonian Sleeper',
    classes: ['158', '170', 'Mk5'],
    freq: '~5 trains per day',
    journey: 'Edinburgh ↔ Perth ↔ Inverness',
    about: 'Single track through the Cairngorms — ScotRail services and the overnight Caledonian Sleeper.',
    path: ['Edinburgh', 'Inverness'],
    geometry: [
      [55.9521, -3.1883], // Edinburgh
      [56.0010, -3.7790], // Falkirk Grahamston
      [56.1177, -3.9360], // Stirling
      [56.3940, -3.4340], // Perth
      [56.5770, -3.5880], // Dunkeld
      [56.7100, -3.8430], // Pitlochry
      [56.8400, -3.8850], // Blair Atholl
      [57.0760, -4.1790], // Dalwhinnie
      [57.1170, -3.8290], // Kingussie
      [57.2060, -3.8250], // Aviemore
      [57.3920, -4.0730], // Carrbridge
      [57.4800, -4.2236], // Inverness
    ],
  },
];

Object.assign(window, { STATIONS, ROUTES });

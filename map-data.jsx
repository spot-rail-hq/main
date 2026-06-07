// High-fidelity geographic mapping points [Latitude, Longitude]
const STATIONS = {
  "London King's Cross": [51.5320, -0.1239],
  "Peterborough": [52.5740, -0.2505],
  "York": [53.9579, -1.0929],
  "Newcastle": [54.9682, -1.6172],
  "Edinburgh Waverley": [55.9521, -3.1883],
  "London Euston": [51.5284, -0.1332],
  "Rugby": [52.3752, -1.2530],
  "Crewe": [53.0895, -2.4335],
  "Preston": [53.7553, -2.7073],
  "Glasgow Central": [55.8591, -4.2581],
  "London Paddington": [51.5167, -0.1772],
  "Reading": [51.4587, -0.9713],
  "Swindon": [51.5652, -1.7854],
  "Bristol Temple Meads": [51.4496, -2.5810],
  "Cardiff Central": [51.4761, -3.1790]
};

const ROUTES = [
  {
    id: "ecml",
    name: "East Coast Main Line",
    color: "#FF4500", // Signature Red-Orange
    journey: "Approx. 4h 20m from London to Edinburgh",
    freq: "Every 30 minutes",
    operator: "LNER, Lumia Trains, Grand Central",
    classes: ["800", "801", "803", "91"],
    about: "The premier high-speed arterial corridor flanking the eastern coastline of Britain.",
    path: ["London King's Cross", "Peterborough", "York", "Newcastle", "Edinburgh Waverley"],
    geometry: [
      [51.5320, -0.1239],
      [52.0000, -0.1800],
      [52.5740, -0.2505],
      [53.0000, -0.6400],
      [53.6000, -1.0000],
      [53.9579, -1.0929],
      [54.5000, -1.5500],
      [54.9682, -1.6172],
      [55.3000, -2.0000],
      [55.9521, -3.1883]
    ]
  },
  {
    id: "wcml",
    name: "West Coast Main Line",
    color: "#007FFF", // Electric Azure Blue
    journey: "Approx. 4h 30m from London to Glasgow",
    freq: "Every 20 minutes",
    operator: "Avanti West Coast, London Northwestern Railway",
    classes: ["390", "221", "805", "807"],
    about: "One of the busiest mixed-traffic rail corridors in Europe, linking the capital to the West Midlands and Scotland.",
    path: ["London Euston", "Rugby", "Crewe", "Preston", "Glasgow Central"],
    geometry: [
      [51.5284, -0.1332],
      [52.0406, -0.7586],
      [52.3752, -1.2530],
      [52.7500, -2.0000],
      [53.0895, -2.4335],
      [53.4800, -2.6200],
      [53.7553, -2.7073],
      [54.2000, -2.8000],
      [54.8900, -2.9300],
      [55.5000, -3.5000],
      [55.8591, -4.2581]
    ]
  },
  {
    id: "gwml",
    name: "Great Western Main Line",
    color: "#008080", // British Racing Teal
    journey: "Approx. 1h 45m from London to Cardiff",
    freq: "Every 15 minutes",
    operator: "Great Western Railway",
    classes: ["800", "802", "387"],
    about: "Brunel's historic corridor heading west out of London, fully electrified up to South Wales.",
    path: ["London Paddington", "Reading", "Swindon", "Bristol Temple Meads", "Cardiff Central"],
    geometry: [
      [51.5167, -0.1772],
      [51.4800, -0.6000],
      [51.4587, -0.9713],
      [51.5000, -1.3000],
      [51.5652, -1.7854],
      [51.5000, -2.2000],
      [51.4496, -2.5810],
      [51.5500, -2.7000],
      [51.5800, -3.0000],
      [51.4761, -3.1790]
    ]
  }
];
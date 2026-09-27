/**
 * The browser preview's campus. Every demo location (the fake cast's phones,
 * the seeded trails) sits within about 400 m of this point, so the map has
 * somewhere believable to draw. Never used on a phone.
 */
export const DEMO_CENTRE = { lat: 6.517, lon: 3.39 };

// --- the drawn campus -------------------------------------------------------------
//
// Below: a small campus drawn as GeoJSON around DEMO_CENTRE, for the browser
// preview's map (which cannot reach a tile server). It is laid out on a
// 390 x 844 sketch, 1.3 m to a unit, with the centre at (195, 422), so the
// preview matches the approved mock. Buildings get their names as labels, and
// `demoPlace` names the building nearest a point so the demo can say
// "settled at Labs".

import type { Cell } from "./types";

type Pos = [number, number];

const M_PER_DEG = 111_320;
const SCALE = 1.3;

/** A sketch point (x right, y down, in sketch units) as [lon, lat]. */
const at = (x: number, y: number): Pos => {
  const east = (x - 195) * SCALE;
  const north = (422 - y) * SCALE;
  const lat = DEMO_CENTRE.lat + north / M_PER_DEG;
  const lon = DEMO_CENTRE.lon + east / (M_PER_DEG * Math.cos((DEMO_CENTRE.lat * Math.PI) / 180));
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
};

/** A rectangle with rounded corners, as a closed ring. */
function roundRect(x: number, y: number, w: number, h: number, r: number): Pos[] {
  const ring: Pos[] = [];
  const corners: [number, number, number][] = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= 4; i += 1) {
      const a = ((start + i * 22.5) * Math.PI) / 180;
      ring.push(at(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  }
  ring.push(ring[0]!);
  return ring;
}

const poly = (kind: string, ring: Pos[], name?: string): GeoJSON.Feature<GeoJSON.Polygon> => ({
  type: "Feature",
  properties: { kind, name: name ?? null },
  geometry: { type: "Polygon", coordinates: [ring] },
});

const line = (kind: string, pts: [number, number][]): GeoJSON.Feature<GeoJSON.LineString> => ({
  type: "Feature",
  properties: { kind },
  geometry: { type: "LineString", coordinates: pts.map(([x, y]) => at(x, y)) },
});

/** Named buildings and grounds, with where their label sits (sketch units). */
const PLACES: { name: string; rect: [number, number, number, number]; label: [number, number]; green?: boolean }[] = [
  { name: "Library", rect: [10, 120, 86, 120], label: [53, 140] },
  { name: "Main Hall", rect: [130, 110, 118, 70], label: [189, 130] },
  { name: "Hostel B", rect: [18, 330, 76, 110], label: [56, 350] },
  { name: "Canteen", rect: [310, 290, 92, 120], label: [356, 312] },
  { name: "Labs", rect: [226, 500, 54, 140], label: [253, 520] },
  { name: "Main gate", rect: [20, 740, 120, 90], label: [80, 760] },
  { name: "Sports field", rect: [236, 96, 170, 130], label: [320, 116], green: true },
  { name: "Quad", rect: [-10, 520, 160, 190], label: [70, 610], green: true },
];

/** Unnamed buildings. */
const OTHERS: [number, number, number, number][] = [
  [140, 190, 100, 50],
  [182, 300, 80, 54],
  [182, 392, 72, 56],
  [310, 720, 90, 120],
];

/** The campus as one FeatureCollection: `kind` is park, water, road, path or building. */
export const CAMPUS: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    poly("park", [at(-200, 505), at(60, 505), at(120, 540), at(150, 600), at(150, 700), at(-200, 725), at(-200, 505)]),
    poly("park", roundRect(236, 96, 170, 130, 28)),
    poly("water", [at(300, 560), at(340, 545), at(400, 560), at(600, 600), at(600, 700), at(380, 690), at(330, 660), at(300, 560)]),
    line("road", [[-300, 322], [420, 250], [700, 218]]),
    line("road", [[96, -300], [110, -20], [170, 900], [184, 1150]]),
    line("road", [[-300, 486], [-20, 470], [60, 461], [120, 458], [200, 465], [260, 468], [340, 450], [420, 430], [700, 360]]),
    line("road", [[262, -300], [270, -20], [300, 900], [308, 1150]]),
    line("path", [[140, 380], [280, 360]]),
    line("path", [[200, 470], [215, 760]]),
    line("path", [[20, 180], [120, 170]]),
    line("path", [[-10, 640], [160, 650]]),
    ...PLACES.filter((p) => !p.green).map((p) => poly("building", roundRect(...p.rect, 10), p.name)),
    ...OTHERS.map((r) => poly("building", roundRect(...r, 10))),
  ],
};

/** Where to write each place's name, as [lon, lat]. Green ones are grounds, not buildings. */
export const CAMPUS_LABELS: { name: string; at: Pos; green: boolean }[] = PLACES.map((p) => ({
  name: p.name,
  at: at(p.label[0], p.label[1]),
  green: !!p.green,
}));

/** The whole campus, [west, south, east, north]. */
export const CAMPUS_BOUNDS: [number, number, number, number] = [...at(-10, 850), ...at(410, -10)] as [number, number, number, number];

/**
 * The demo's name for a place: the building or ground whose outline is
 * nearest `cell` (within about 70 m), or null. Demo only: a real phone has no
 * names for places.
 */
export function demoPlace(cell: Cell): string | null {
  let best: { name: string; d: number } | null = null;
  for (const p of PLACES) {
    const [x, y, w, h] = p.rect;
    const [w0, s0] = at(x, y + h);
    const [e0, n0] = at(x + w, y);
    const dLat = cell.lat < s0 ? s0 - cell.lat : cell.lat > n0 ? cell.lat - n0 : 0;
    const dLon = cell.lon < w0 ? w0 - cell.lon : cell.lon > e0 ? cell.lon - e0 : 0;
    const d = Math.hypot(dLat * M_PER_DEG, dLon * M_PER_DEG * Math.cos((cell.lat * Math.PI) / 180));
    if (d < 70 && (!best || d < best.d)) best = { name: p.name, d };
  }
  return best?.name ?? null;
}

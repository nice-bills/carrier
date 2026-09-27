import type { Cell, Route, TrailPoint } from "./types";

/**
 * Pure geometry and wording for the spread map, shared by the screen and both
 * map components. No device modules, no React.
 */

const R_EARTH = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance between two cells, in metres. */
export function haversine(a: Cell, b: Cell): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How far a payment travelled: the sum of the straight hops between its points. */
export function routeMetres(r: Route): number {
  let m = 0;
  for (let i = 1; i < r.points.length; i += 1) m += haversine(r.points[i - 1]!.cell, r.points[i]!.cell);
  return m;
}

/** "640 m", "1.2 km". */
export function distanceText(m: number): string {
  if (m < 995) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

/** "4h 12m", "12m", "2d 3h", "under a minute". */
export function durationText(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Spoken form of `durationText`. */
export function durationSpoken(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (m < 1) return "under a minute";
  if (m < 60) return plural(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return `${plural(h, "hour")} ${plural(m % 60, "minute")}`;
  return `${plural(Math.floor(h / 24), "day")} ${plural(h % 24, "hour")}`;
}

export const firstPoint = (r: Route) => r.points.find((p) => p.kind === "sent") ?? r.points[0];
export const settledPoint = (r: Route) => r.points.find((p) => p.kind === "settled");
/** When a route last moved. */
export const lastAt = (r: Route) => r.points.reduce((t, p) => Math.max(t, p.at), 0);

/** Milliseconds from signing to settling, or null if it has not settled (or we lack either end). */
export function settleMs(r: Route): number | null {
  const a = firstPoint(r);
  const b = settledPoint(r);
  return a && b && r.settled ? Math.max(0, b.at - a.at) : null;
}

/** People who held it: every point but the settlement. */
export const hands = (r: Route) => r.points.filter((p) => p.kind !== "settled").length;

/** Routes with a point since local midnight. */
export function today(routes: readonly Route[], now = Date.now()): Route[] {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return routes.filter((r) => r.points.some((p) => p.at >= midnight));
}

/** Bounds of some cells as [[west, south], [east, north]], or null for none. */
export function boundsOf(cells: readonly Cell[]): [[number, number], [number, number]] | null {
  if (!cells.length) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const c of cells) {
    w = Math.min(w, c.lon);
    e = Math.max(e, c.lon);
    s = Math.min(s, c.lat);
    n = Math.max(n, c.lat);
  }
  // A single cell (or a straight line of them) still gets a block or two of room.
  const pad = 0.0015;
  if (e - w < pad) {
    w -= pad / 2;
    e += pad / 2;
  }
  if (n - s < pad) {
    s -= pad / 2;
    n += pad / 2;
  }
  return [
    [w, s],
    [e, n],
  ];
}

/**
 * A gentle arc between two points, so hops read as hand-to-hand moves rather
 * than roads. Bends to the left of travel by a fifth of the hop's length.
 */
function arc(a: Cell, b: Cell, steps = 12): [number, number][] {
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const dx = (b.lon - a.lon) * k;
  const dy = b.lat - a.lat;
  const cx = (a.lon + b.lon) / 2 + (-dy * 0.2) / k;
  const cy = (a.lat + b.lat) / 2 + dx * 0.2;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * a.lon + 2 * u * t * cx + t * t * b.lon, u * u * a.lat + 2 * u * t * cy + t * t * b.lat]);
  }
  return out;
}

/** A route's line: arcs between consecutive points that are not in the same cell. */
export function routeLine(r: Route): [number, number][] {
  const pts = r.points;
  if (!pts.length) return [];
  const out: [number, number][] = [[pts[0]!.cell.lon, pts[0]!.cell.lat]];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!.cell;
    const b = pts[i]!.cell;
    if (a.lat === b.lat && a.lon === b.lon) continue;
    out.push(...arc(a, b).slice(1));
  }
  return out;
}

export type Dot = "hop" | "me" | "settled";

/** What a point is drawn as: settled green, this phone amber, anyone else ink. */
export const dotOf = (p: TrailPoint, me: string): Dot => (p.kind === "settled" ? "settled" : p.who === me ? "me" : "hop");

/**
 * The map's shapes: every route's line (`line` is "focus" for the chosen one,
 * "faint" for the others, "spread" for everyone's today) and,
 * in `today` mode, every point as a dot. In `route` mode the chosen route's
 * points are drawn as pins instead (see `pinsFor`).
 */
export function shapes(routes: readonly Route[], focus: Route | null, me: string, mode: "route" | "today") {
  const lines: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
    type: "FeatureCollection",
    features: routes
      .filter((r) => r.points.length > 1)
      // the chosen route last, so it draws on top
      .sort((a, b) => Number(a.id === focus?.id) - Number(b.id === focus?.id))
      .map((r) => ({
        type: "Feature",
        // No feature `id`: a note key of all digits would be taken for a number too big to encode.
        properties: { line: mode === "today" ? "spread" : r.id === focus?.id ? "focus" : "faint" },
        geometry: { type: "LineString", coordinates: routeLine(r) },
      })),
  };
  // One dot per cell and kind, however many routes passed through it; busier cells draw bigger.
  const dots = new Map<string, { cell: Cell; dot: Dot; n: number }>();
  if (mode === "today") {
    for (const r of routes) {
      for (const p of r.points) {
        const dot = dotOf(p, me);
        const k = `${p.cell.lat},${p.cell.lon},${dot}`;
        const d = dots.get(k);
        if (d) d.n += 1;
        else dots.set(k, { cell: p.cell, dot, n: 1 });
      }
    }
  }
  const points: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: "FeatureCollection",
    features: [...dots.values()]
      // settled and "you" on top
      .sort((a, b) => ORDER[a.dot] - ORDER[b.dot])
      .map((d) => ({
        type: "Feature",
        properties: { dot: d.dot, r: Math.min(12, (d.dot === "hop" ? 6 : d.dot === "me" ? 9 : 11) + d.n - 1) },
        geometry: { type: "Point", coordinates: [d.cell.lon, d.cell.lat] },
      })),
  };
  return { lines, points };
}

const ORDER: Record<Dot, number> = { hop: 0, me: 1, settled: 2 };

export interface Pin {
  key: string;
  cell: Cell;
  dot: Dot;
  /** Two letters, or "You". */
  face: string;
  /** "10:04", or "Settled". */
  tag: string;
  /** Which side of the pin the tag sits, away from the line. */
  side: "left" | "right";
}

/** The chosen route's pins, one per point, with a time tag on the side facing the middle of the route (so it stays on screen). */
export function pinsFor(r: Route, me: string, time: (ms: number) => string): Pin[] {
  const lons = r.points.map((p) => p.cell.lon);
  const mid = (Math.min(...lons) + Math.max(...lons)) / 2;
  return r.points.map((p) => {
    const dot = dotOf(p, me);
    return {
      key: `${p.kind}${p.seq}`,
      cell: p.cell,
      dot,
      face: dot === "me" ? "You" : p.who.slice(0, 2),
      tag: p.kind === "settled" ? "Settled" : time(p.at),
      side: p.cell.lon > mid ? "left" : "right",
    };
  });
}

import { DEMO_CENTRE } from "../map/demoCampus";
import type { LocationService } from "../map/location";
import { pointAt } from "../map/trail";
import { roundCell, type Cell, type PointKind, type Route, type TrailPoint } from "../map/types";
import { cast } from "./services";

/**
 * Where the preview's cast stand on the demo campus, and the trails the
 * preview starts with. Every place is within about 400 m of `DEMO_CENTRE`
 * (0.001° is about 110 m here), and every point goes through `roundCell`
 * like a real fix would.
 */

const at = (dLat: number, dLon: number): Cell => roundCell(DEMO_CENTRE.lat + dLat, DEMO_CENTRE.lon + dLon);

type Who = keyof typeof cast;

/** Where each phone in the cast is right now. */
export const places: Record<Who, Cell> = {
  me: at(0.0006, -0.0004), // the library steps
  chidi: at(0.0009, -0.0001),
  mei: at(0.0003, -0.0008),
  zanele: at(0.0007, -0.0006),
  ama: at(-0.0021, 0.0012),
  kofi: at(0.0025, 0.0019),
  tunde: at(-0.0028, -0.0015),
};

/** The fake device's location: wherever "me" stands. Permission is always granted. */
export function demoLocation(): LocationService {
  return {
    request: async () => true,
    fix: async () => places.me,
  };
}

const MIN = 60_000;
const key = (w: Who) => cast[w].publicKey.toBase58();

/** One stop on a seeded trail: who, where, and how many minutes ago. */
type Stop = [kind: PointKind, seq: number, who: Who, where: Cell, minutesAgo: number];

export function trailOf(stops: Stop[], now = Date.now()): TrailPoint[] {
  return stops.map(([kind, seq, who, where, ago]) => pointAt(seq, kind, key(who), where, now - ago * MIN));
}

/** A made-up note hash for a route that is only on the map, never in a pocket. */
const routeId = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

/**
 * Routes the preview's phone already knows, besides its two slips: one it
 * sent, one it carried that settled, and a few it only saw in passing.
 */
export function seededRoutes(now = Date.now()): { route: Route; at: number }[] {
  const route = (n: number, amount: string, to: Who, mine: boolean, settled: boolean, stops: Stop[]) => {
    const points = trailOf(stops, now);
    return { route: { id: routeId(n), amount, to: key(to), points, settled, mine }, at: Math.max(...points.map((p) => p.at)) };
  };
  return [
    // You paid Kofi; Chidi is carrying it across campus.
    route(1, "2 USDC", "kofi", true, false, [
      ["sent", 0, "me", places.me, 52],
      ["hop", 0, "chidi", at(0.0011, 0.0004), 47],
    ]),
    // Mei paid Kofi; it went Ama, you, Chidi, then to Kofi, and settled a few hours later.
    route(2, "6 USDC", "kofi", true, true, [
      ["sent", 0, "mei", at(-0.0024, -0.002), 310],
      ["hop", 0, "ama", at(-0.0013, -0.0011), 292],
      ["hop", 1, "me", at(-0.0002, -0.0001), 270],
      ["hop", 2, "chidi", at(0.0011, 0.0009), 251],
      ["hop", 3, "kofi", at(0.0022, 0.0018), 236],
      ["settled", 4, "kofi", at(0.0022, 0.0018), 118],
    ]),
    // Seen in passing: other people's payments whose trails crossed this phone's.
    route(3, "3.5 USDC", "zanele", false, false, [
      ["sent", 0, "tunde", places.tunde, 95],
      ["hop", 0, "mei", at(-0.0016, -0.0013), 81],
      ["hop", 1, "chidi", at(-0.0004, -0.0009), 64],
    ]),
    route(4, "1 USDC", "ama", false, true, [
      ["sent", 0, "zanele", at(0.0017, -0.0024), 460],
      ["hop", 0, "kofi", at(0.0004, -0.0019), 441],
      ["hop", 1, "ama", at(-0.0009, -0.0005), 430],
      ["settled", 2, "ama", at(-0.0009, -0.0005), 400],
    ]),
    route(5, "9 USDC", "chidi", false, false, [
      ["sent", 0, "ama", places.ama, 30],
      ["hop", 0, "zanele", at(-0.0005, 0.0021), 21],
    ]),
    route(6, "4 USDC", "tunde", false, true, [
      ["sent", 0, "kofi", at(0.0031, 0.0006), 720],
      ["hop", 0, "mei", at(0.0018, -0.0007), 705],
      ["hop", 1, "tunde", at(0.0008, -0.0026), 690],
      ["settled", 2, "tunde", at(-0.0002, -0.0029), 610],
    ]),
  ];
}

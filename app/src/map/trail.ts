import type { HandoffOffer } from "@carrier/mesh";
import { roundCell, type Cell, type PointKind, type Route, type TrailPoint } from "./types";

/**
 * Trails on the wire and on disk.
 *
 * A trail arrives from whoever handed us the slip, next to the offer and
 * outside anything signed, so it is untrusted input like every other field a
 * peer sends. `parseTrail` keeps only well-formed points, re-rounds every cell
 * (a peer cannot plant a precise location on this phone), and never throws: a
 * bad trail costs the trail, never the handoff.
 */

/**
 * An offer with the note's trail beside it. The trail is not part of the
 * signed bundle or the mesh wire format: it rides next to the offer, and a
 * phone that does not know about it never sees it. Unknown until parsed.
 */
export type TrailedOffer = HandoffOffer & { trail?: unknown };

/** Points one trail may hold, on the wire and on disk. */
export const MAX_TRAIL = 16;
/** Routes kept on this phone, newest first. */
export const MAX_ROUTES = 200;
/** Routes untouched for this long are forgotten. */
export const ROUTE_TTL_MS = 14 * 86_400_000;

const KINDS: readonly PointKind[] = ["sent", "hop", "settled"];
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const KIND_ORDER: Record<PointKind, number> = { sent: 0, hop: 1, settled: 2 };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** One point, or null if any field is off. The cell is re-rounded. */
export function parsePoint(x: unknown): TrailPoint | null {
  if (!isObj(x) || !isObj(x.cell)) return null;
  const { seq, kind, who, at } = x;
  const { lat, lon } = x.cell;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 255) return null;
  if (typeof kind !== "string" || !KINDS.includes(kind as PointKind)) return null;
  if (typeof who !== "string" || !KEY.test(who)) return null;
  if (!finite(at)) return null;
  if (!finite(lat) || lat < -90 || lat > 90 || !finite(lon) || lon < -180 || lon > 180) return null;
  return { seq, kind: kind as PointKind, who, at, cell: roundCell(lat, lon) };
}

/** A trail from a peer or from disk: well-formed points only, at most `MAX_TRAIL`. */
export function parseTrail(x: unknown): TrailPoint[] {
  if (!Array.isArray(x)) return [];
  const out: TrailPoint[] = [];
  for (const p of x.slice(0, MAX_TRAIL)) {
    const ok = parsePoint(p);
    if (ok) out.push(ok);
  }
  return mergeTrail([], out);
}

const pointKey = (p: TrailPoint) => `${p.kind}:${p.seq}`;
const byOrder = (a: TrailPoint, b: TrailPoint) => a.seq - b.seq || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

/**
 * Merge `incoming` into `known` by (seq, kind), the first one seen winning, in
 * route order. Over `MAX_TRAIL`, the payer's point stays and the oldest hops go.
 */
export function mergeTrail(known: readonly TrailPoint[], incoming: readonly TrailPoint[]): TrailPoint[] {
  const seen = new Map<string, TrailPoint>();
  for (const p of [...known, ...incoming]) if (!seen.has(pointKey(p))) seen.set(pointKey(p), p);
  const all = [...seen.values()].sort(byOrder);
  if (all.length <= MAX_TRAIL) return all;
  const sent = all.filter((p) => p.kind === "sent");
  const rest = all.filter((p) => p.kind !== "sent");
  return [...sent, ...rest.slice(-(MAX_TRAIL - sent.length))].sort(byOrder);
}

/** A route as this phone keeps it: the contract's shape plus when it last changed. */
export interface StoredRoute extends Route {
  /** Milliseconds since the epoch this route last changed. Drives the order and the expiry. */
  at: number;
}

/** Stored routes from disk: malformed ones dropped, points re-checked. */
export function parseRoutes(x: unknown, now = Date.now()): StoredRoute[] {
  if (!Array.isArray(x)) return [];
  const out: StoredRoute[] = [];
  for (const r of x.slice(0, MAX_ROUTES * 2)) {
    if (!isObj(r)) continue;
    const { id, amount, to, settled, mine, at } = r;
    if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id)) continue;
    if (typeof amount !== "string" || amount.length > 64 || typeof to !== "string" || !KEY.test(to) || !finite(at)) continue;
    out.push({ id, amount, to, points: parseTrail(r.points), settled: settled === true, mine: mine === true, at });
  }
  return pruneRoutes(out, now);
}

/** Newest first, nothing older than `ROUTE_TTL_MS`, at most `MAX_ROUTES`. */
export function pruneRoutes(routes: readonly StoredRoute[], now = Date.now()): StoredRoute[] {
  return routes
    .filter((r) => now - r.at < ROUTE_TTL_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ROUTES);
}

/** A point at `cell`, rounded again in case the caller passed a raw fix. */
export function pointAt(seq: number, kind: PointKind, who: string, cell: Cell, at = Date.now()): TrailPoint {
  return { seq, kind, who, at, cell: roundCell(cell.lat, cell.lon) };
}

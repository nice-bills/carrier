/**
 * The spread map's data: where each handoff of a payment happened, rounded so
 * it names a building rather than a person.
 *
 * A trail rides along with the slip from phone to phone (outside the signed
 * bundle, so it is a claim, not evidence), and each phone adds its own point
 * when it takes part. Only phones whose owner turned the map on add points.
 */

/** A location rounded to a grid of about 100 m (see roundCell). */
export interface Cell {
  lat: number;
  lon: number;
}

export type PointKind = "sent" | "hop" | "settled";

export interface TrailPoint {
  /** 0 for the payer's signing, then the hop's seq; settled uses the last seq + 1. */
  seq: number;
  kind: PointKind;
  /** Base58 key of whoever was holding the phone at this point. */
  who: string;
  /** Milliseconds since the epoch. */
  at: number;
  cell: Cell;
}

/** One payment's journey, as far as this phone knows it. */
export interface Route {
  /** noteKey(bundle): the same key slips and receipts use. */
  id: string;
  amount: string;
  /** Base58 key of the payee. */
  to: string;
  points: TrailPoint[];
  settled: boolean;
  /** Whether this phone held it at some point (false for routes only seen in passing). */
  mine: boolean;
}

/** Grid step in degrees: 0.001° of latitude is about 111 m. */
export const CELL_STEP = 0.001;

/** Snap a GPS fix to the centre of its grid cell. */
export function roundCell(lat: number, lon: number): Cell {
  const snap = (v: number) => Math.round((Math.floor(v / CELL_STEP) + 0.5) * CELL_STEP * 1e6) / 1e6;
  return { lat: snap(lat), lon: snap(lon) };
}

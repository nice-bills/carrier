import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { CELL_STEP, roundCell, type TrailPoint } from "./types";
import { MAX_ROUTES, MAX_TRAIL, ROUTE_TTL_MS, mergeTrail, parseRoutes, parseTrail, type StoredRoute } from "./trail";

/**
 * The map's privacy and its wire checks: what a location becomes before it is
 * kept, and what survives of a trail a stranger sends.
 */

const who = Keypair.generate().publicKey.toBase58();
const pt = (seq: number, kind: TrailPoint["kind"], lat = 6.5175, lon = 3.3905, at = 1_700_000_000_000): TrailPoint => ({
  seq,
  kind,
  who,
  at,
  cell: { lat, lon },
});

describe("rounding a fix to a cell", () => {
  it("snaps to the centre of a grid cell about 100 m across", () => {
    expect(roundCell(6.51712, 3.39049)).toEqual({ lat: 6.5175, lon: 3.3905 });
    expect(roundCell(-33.86881, 151.20929)).toEqual({ lat: -33.8685, lon: 151.2095 });
    expect(CELL_STEP * 111_000).toBeGreaterThan(100);
  });

  it("maps two people 30 m apart in one cell to the same place", () => {
    // 0.00027° of latitude is about 30 m.
    const a = roundCell(6.51705, 3.39012);
    const b = roundCell(6.51705 + 0.00027, 3.39012 + 0.00027);
    expect(a).toEqual(b);
    // Nothing finer than the grid survives.
    expect(Math.round((a.lat % CELL_STEP) / CELL_STEP * 2)).toBe(1);
  });

  it("is stable: a rounded cell rounds to itself", () => {
    for (const [lat, lon] of [[6.5175, 3.3905], [-0.0005, -179.9995], [89.9995, 0.0005]]) {
      expect(roundCell(lat!, lon!)).toEqual({ lat, lon });
    }
  });
});

describe("a trail from a peer", () => {
  it("keeps well-formed points and re-rounds their cells", () => {
    const got = parseTrail([{ ...pt(0, "sent"), cell: { lat: 6.51712, lon: 3.39049 } }]);
    expect(got).toEqual([{ ...pt(0, "sent"), cell: { lat: 6.5175, lon: 3.3905 } }]);
  });

  it("drops anything malformed, quietly", () => {
    const good = pt(1, "hop");
    const bad: unknown[] = [
      null,
      "point",
      [],
      { ...good, cell: undefined },
      { ...good, cell: { lat: 91, lon: 0 } },
      { ...good, cell: { lat: 0, lon: -180.5 } },
      { ...good, cell: { lat: NaN, lon: 0 } },
      { ...good, cell: { lat: "6.5", lon: 3.3 } },
      { ...good, seq: -1 },
      { ...good, seq: 1.5 },
      { ...good, seq: 256 },
      { ...good, kind: "teleport" },
      { ...good, who: "not a key" },
      { ...good, who: "0".repeat(44) },
      { ...good, who: 42 },
      { ...good, at: Infinity },
      { ...good, at: "yesterday" },
    ];
    // One at a time, since a trail is only read up to its cap.
    for (const b of bad) expect(parseTrail([b, good, b])).toEqual([good]);
    for (const x of [undefined, null, "[]", 7, {}, { length: 3 }]) expect(parseTrail(x)).toEqual([]);
  });

  it("reads no more than the cap", () => {
    const long = Array.from({ length: 40 }, (_, i) => pt(i, "hop"));
    const got = parseTrail(long);
    expect(got).toHaveLength(MAX_TRAIL);
    expect(got.map((p) => p.seq)).toEqual(Array.from({ length: MAX_TRAIL }, (_, i) => i));
  });

  it("merges by seq and kind, the first one seen winning", () => {
    const known = [pt(0, "sent", 6.5175), pt(0, "hop", 6.5185)];
    const incoming = [pt(0, "sent", 6.5195), pt(1, "hop", 6.5205), pt(0, "hop", 6.5215)];
    const merged = mergeTrail(known, incoming);
    expect(merged.map((p) => `${p.kind}${p.seq}@${p.cell.lat}`)).toEqual(["sent0@6.5175", "hop0@6.5185", "hop1@6.5205"]);
  });

  it("keeps the payer's point when a trail outgrows the cap", () => {
    const merged = mergeTrail([pt(0, "sent")], Array.from({ length: 20 }, (_, i) => pt(i, "hop")));
    expect(merged).toHaveLength(MAX_TRAIL);
    expect(merged[0]!.kind).toBe("sent");
    expect(merged.at(-1)!.seq).toBe(19);
  });
});

describe("routes on disk", () => {
  const route = (n: number, at: number): StoredRoute => ({
    id: n.toString(16).padStart(64, "0"),
    amount: "1 USDC",
    to: who,
    points: [pt(0, "sent")],
    settled: false,
    mine: true,
    at,
  });

  it("forgets routes older than two weeks and keeps the newest few hundred", () => {
    const now = 1_800_000_000_000;
    const stale = route(1, now - ROUTE_TTL_MS - 1);
    const many = Array.from({ length: MAX_ROUTES + 20 }, (_, i) => route(i + 2, now - i * 1000));
    const got = parseRoutes([stale, ...many, { id: "junk" }, null], now);
    expect(got).toHaveLength(MAX_ROUTES);
    expect(got[0]!.id).toBe(many[0]!.id);
    expect(got.some((r) => r.id === stale.id)).toBe(false);
  });
});

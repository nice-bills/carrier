import { describe, expect, it } from "vitest";
import { RANKS, rankFor } from "../../../app/src/rank.js";

/**
 * Rank is the game's status symbol, and it is deliberately the same quantity
 * the protocol needs to be hard to fake. These tests pin that: handoffs must
 * never move it, only distinct people.
 */

describe("rank", () => {
  it("starts dormant and climbs with distinct people", () => {
    expect(rankFor(0).current.name).toBe("Dormant");
    expect(rankFor(1).current.name).toBe("Exposed");
    expect(rankFor(3).current.name).toBe("Carrier");
    expect(rankFor(6).current.name).toBe("Vector");
    expect(rankFor(10).current.name).toBe("Superspreader");
  });

  it("holds rank between thresholds rather than drifting", () => {
    expect(rankFor(4).current.name).toBe("Carrier");
    expect(rankFor(5).current.name).toBe("Carrier");
    expect(rankFor(6).current.name).toBe("Vector");
  });

  it("reports progress toward the next rank", () => {
    // Carrier at 3, Vector at 6: four met is one third of the way.
    const state = rankFor(4);
    expect(state.next!.name).toBe("Vector");
    expect(state.progress).toBeCloseTo(1 / 3, 6);
    expect(state.caption).toBe("2 more to vector");
  });

  it("tops out without a next rank or a broken bar", () => {
    const top = rankFor(25);
    expect(top.next).toBeNull();
    expect(top.progress).toBe(1);
    expect(top.caption).toBe("nothing left to reach");
  });

  it("never produces a NaN progress", () => {
    for (let met = 0; met <= 30; met += 1) {
      const p = rankFor(met).progress;
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("is defined in ascending order, so the scan finds the right rank", () => {
    // rankFor walks the list and keeps the last match; out-of-order thresholds
    // would silently return the wrong rank rather than throwing.
    const thresholds = RANKS.map((r) => r.at);
    expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildSpread,
  generations,
  reproductionNumber,
  superspreaders,
  type SettledLineage,
} from "./lineage.js";

const settled = (...lineage: string[]): SettledLineage => ({
  lineage,
  noteHash: lineage.join("|"),
});

describe("spread", () => {
  it("builds a transmission tree from settled lineages", () => {
    const spread = buildSpread([
      settled("alice", "bob", "carol"),
      settled("alice", "dave"),
    ]);

    expect(spread.origins).toEqual(["alice"]);
    expect(spread.longestChain).toBe(2);
    expect(spread.carriers.get("alice")!.passedTo).toEqual(
      new Set(["bob", "dave"]),
    );
    expect(spread.carriers.get("carol")!.receivedFrom).toEqual(new Set(["bob"]));
    // carol is an endpoint: she received but never passed on.
    expect(spread.carriers.get("carol")!.passedTo.size).toBe(0);
  });

  it("counts repeated routes as weight, not as new edges", () => {
    const spread = buildSpread([
      settled("alice", "bob"),
      settled("alice", "bob"),
      settled("alice", "bob"),
    ]);

    expect(spread.edges).toHaveLength(1);
    expect(spread.edges[0]).toMatchObject({ from: "alice", to: "bob", weight: 3 });
  });

  it("measures whether the thing is actually spreading", () => {
    // A chain: everyone passes to exactly one person except the last.
    const chain = buildSpread([settled("a", "b", "c", "d")]);
    expect(reproductionNumber(chain)).toBeCloseTo(0.75, 2);

    // A fan: one person reaches three, who reach nobody.
    const fan = buildSpread([
      settled("a", "b"),
      settled("a", "c"),
      settled("a", "d"),
    ]);
    expect(reproductionNumber(fan)).toBeCloseTo(0.75, 2);

    // Everyone passing to two people is unambiguously growing.
    const growing = buildSpread([
      settled("a", "b"),
      settled("a", "c"),
      settled("b", "d"),
      settled("b", "e"),
      settled("c", "f"),
      settled("c", "g"),
    ]);
    expect(reproductionNumber(growing)).toBeGreaterThan(0.8);
  });

  it("ranks by distinct people reached, not by volume", () => {
    const spread = buildSpread([
      // busy: carried a lot, but always between the same two people.
      settled("busy", "same"),
      settled("busy", "same"),
      settled("busy", "same"),
      settled("busy", "same"),
      // wide: fewer notes, but three different recipients.
      settled("wide", "one"),
      settled("wide", "two"),
      settled("wide", "three"),
    ]);

    const top = superspreaders(spread, 2);
    expect(top[0]!.key).toBe("wide");
    // This is the anti-sybil property in the ranking: a pocket of your own
    // phones is a very small set of distinct recipients, so volume alone
    // cannot buy a place at the top.
    expect(top[0]!.passedTo.size).toBe(3);
    expect(top[1]!.key).toBe("busy");
    expect(top[1]!.passedTo.size).toBe(1);
  });

  it("places everyone at their distance from an origin", () => {
    const spread = buildSpread([
      settled("root", "a", "b", "c"),
      settled("root", "x"),
    ]);

    const depth = generations(spread);
    expect(depth.get("root")).toBe(0);
    expect(depth.get("a")).toBe(1);
    expect(depth.get("b")).toBe(2);
    expect(depth.get("c")).toBe(3);
    expect(depth.get("x")).toBe(1);
  });

  it("takes the shorter route when someone is reachable two ways", () => {
    const spread = buildSpread([
      settled("root", "long1", "long2", "target"),
      settled("root", "target"),
    ]);

    // Reached directly and via a three-hop path; the map should show it next to
    // the origin rather than out at the end of the long branch.
    expect(generations(spread).get("target")).toBe(1);
  });

  it("copes with nothing having settled yet", () => {
    const empty = buildSpread([]);
    expect(empty.carriers.size).toBe(0);
    expect(empty.origins).toEqual([]);
    expect(reproductionNumber(empty)).toBe(0);
    expect(superspreaders(empty)).toEqual([]);
    expect(generations(empty).size).toBe(0);
  });

  it("ignores a note that never left the sender", () => {
    // Settled with no carriers at all: lineage is just the sender.
    const spread = buildSpread([settled("alone")]);
    expect(spread.edges).toEqual([]);
    expect(spread.origins).toEqual([]); // never passed anything on
    expect(spread.carriers.get("alone")!.carried).toBe(1);
  });
});

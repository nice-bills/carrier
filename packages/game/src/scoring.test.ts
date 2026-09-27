import { describe, expect, it } from "vitest";
import { EncounterHistory } from "./strain.js";
import {
  DEFAULT_RULES,
  handoffValue,
  scoreLineages,
  splitBounty,
  standingOf,
  standings,
  type ScoringRules,
} from "./scoring.js";

/**
 * The scoring rule is the anti-sybil measure, so these tests are the security
 * argument rather than arithmetic checks. The ones that matter are the attack
 * groups: keys that only ever met each other have to earn nothing.
 */

/** Keys with full standing: seeds, i.e. anchored to something that costs money. */
function established(...keys: string[]): EncounterHistory {
  return new EncounterHistory(keys);
}

const total = (awards: { points: number }[]) => awards.reduce((n, a) => n + a.points, 0);

/** Every ordered pair of distinct keys, as one-hop lineages. */
function allPairs(keys: string[]): string[][] {
  const out: string[][] = [];
  for (const a of keys) for (const b of keys) if (a !== b) out.push([a, b]);
  return out;
}

describe("handoff value", () => {
  it("is worth most the first time two people meet", () => {
    const history = established("a", "b");
    const first = handoffValue("a", "b", history, DEFAULT_RULES);

    history.record("a", "b");
    const second = handoffValue("a", "b", history, DEFAULT_RULES);

    history.record("a", "b");
    const third = handoffValue("a", "b", history, DEFAULT_RULES);

    expect(first).toBe(DEFAULT_RULES.basePoints);
    expect(second).toBeCloseTo(first / 2, 6);
    expect(third).toBeCloseTo(first / 3, 6);
  });

  it("does not care which direction the note travelled", () => {
    const history = established("a", "b");
    history.record("a", "b");

    // Meeting is symmetric. If it were not, two phones could alternate
    // direction and keep claiming a first encounter forever.
    expect(handoffValue("b", "a", history)).toBeCloseTo(
      handoffValue("a", "b", history),
      6,
    );
  });

  it("is nearly worthless when one side is a key nobody has met", () => {
    const history = established("known");
    // `stranger` has no record at all — indistinguishable from a phone taken
    // out of a drawer a minute ago.
    expect(handoffValue("known", "stranger", history)).toBe(0);

    // Meeting another nobody changes nothing: standing is conferred, not counted.
    history.record("stranger", "someone");
    expect(handoffValue("known", "stranger", history)).toBe(0);

    // Meeting someone with standing does.
    history.record("stranger", "known");
    const vouched = handoffValue("known", "stranger", history);
    expect(vouched).toBeGreaterThan(0);
    expect(vouched).toBeLessThan(DEFAULT_RULES.basePoints);
  });
});

describe("scoring lineages", () => {
  it("credits both sides of a handoff", () => {
    const awards = scoreLineages([["a", "b"]], established("a", "b"));
    expect(awards).toHaveLength(2);
    expect(awards[0]!.points).toBeCloseTo(awards[1]!.points, 6);
  });

  it("rewards reaching new people over carrying volume", () => {
    const history = established("wide", "busy", "p1", "p2", "p3", "partner");

    const awards = scoreLineages(
      [
        // wide meets three different people, once each.
        ["wide", "p1"],
        ["wide", "p2"],
        ["wide", "p3"],
        // busy does four handoffs, all with the same person.
        ["busy", "partner"],
        ["busy", "partner"],
        ["busy", "partner"],
        ["busy", "partner"],
      ],
      history,
    );

    const points = new Map(awards.map((a) => [a.key, a.points]));
    expect(points.get("wide")!).toBeGreaterThan(points.get("busy")!);
    // busy did *more* handoffs and still scored less, which is the whole point.
    const wideHandoffs = awards.find((a) => a.key === "wide")!.handoffs;
    const busyHandoffs = awards.find((a) => a.key === "busy")!.handoffs;
    expect(busyHandoffs).toBeGreaterThan(wideHandoffs);
  });

  it("scores a chain so every carrier in it earns", () => {
    const awards = scoreLineages(
      [["a", "b", "c", "d"]],
      established("a", "b", "c", "d"),
    );
    expect(awards.map((a) => a.key).sort()).toEqual(["a", "b", "c", "d"]);
    // The middle of a chain took part in two handoffs, the ends in one.
    const byKey = new Map(awards.map((a) => [a.key, a]));
    expect(byKey.get("b")!.handoffs).toBe(2);
    expect(byKey.get("a")!.handoffs).toBe(1);
    expect(byKey.get("b")!.points).toBeGreaterThan(byKey.get("a")!.points);
  });
});

describe("standing", () => {
  it("is 1 at a seed and 0 for a key with no path to one", () => {
    const h = new EncounterHistory(["seed"]);
    h.record("x", "y");
    expect(standingOf("seed", h)).toBe(1);
    expect(standingOf("x", h)).toBe(0);
    expect(standingOf("never-seen", h)).toBe(0);
  });

  it("rises as a key meets more people who have it", () => {
    const h = new EncounterHistory(["s1", "s2", "s3", "s4", "s5"]);
    h.record("newcomer", "s1");
    const one = standingOf("newcomer", h);
    h.record("newcomer", "s2");
    h.record("newcomer", "s3");
    const three = standingOf("newcomer", h);
    h.record("newcomer", "s4");
    h.record("newcomer", "s5");
    const five = standingOf("newcomer", h);
    expect(one).toBeGreaterThan(0);
    expect(three).toBeGreaterThan(one);
    expect(five).toBe(1);
  });

  it("does not let one key vouch for unlimited others", () => {
    const h = new EncounterHistory(["seed"]);
    const met = Array.from({ length: 30 }, (_, i) => `k${i}`);
    for (const k of met) h.record("seed", k);
    const conferred = met.reduce((n, k) => n + standingOf(k, h), 0);
    // A seed passes on at most damping × vouchCapacity / T of standing in all.
    const cap =
      (DEFAULT_RULES.damping! * DEFAULT_RULES.vouchCapacity!) / DEFAULT_RULES.standingThreshold;
    expect(conferred).toBeLessThanOrEqual(cap + 1e-9);
  });
});

describe("sybil attacks", () => {
  it("two phones bouncing a note earn nothing", () => {
    const attacker = Array.from({ length: 20 }, () => ["phone1", "phone2"]);
    const awards = scoreLineages(attacker, new EncounterHistory(["ada", "grace"]));
    expect(total(awards)).toBe(0);

    // Two real people meeting once are worth the full base.
    const honest = scoreLineages([["ada", "grace"]], new EncounterHistory(["ada", "grace"]));
    expect(total(honest)).toBe(DEFAULT_RULES.basePoints);
  });

  it("a ring of fresh keys scores ~0 however many keys it adds", () => {
    // The audit's probe: a 5-key ring, then every key meeting every other, then
    // new keys joining. Under distinct-partner counting this reached full
    // standing and paid every new key full points. Now none of it has standing.
    const seeds = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const history = new EncounterHistory(seeds);
    // The honest world exists alongside, and is scored in the same history.
    const honestAwards = scoreLineages(allPairs(seeds), history);

    const ring = Array.from({ length: 5 }, (_, i) => `ring${i}`);
    const ringLineages = [
      ...ring.map((k, i) => [k, ring[(i + 1) % ring.length]!]),
      ...allPairs(ring),
    ];
    const joiners = Array.from({ length: 20 }, (_, i) => `fresh${i}`);
    for (const j of joiners) for (const r of ring) ringLineages.push([r, j]);

    const ringAwards = scoreLineages(ringLineages, history);
    expect(total(ringAwards)).toBeLessThan(1e-9);
    for (const k of [...ring, ...joiners]) expect(standingOf(k, history)).toBe(0);

    // And therefore the ring draws nothing from a bounty shared with honest play.
    const split = splitBounty(1_000_000n, [...honestAwards, ...ringAwards].sort((a, b) => b.points - a.points));
    for (const k of [...ring, ...joiners]) expect(split.get(k) ?? 0n).toBe(0n);
  });

  it("a ring attached by one real encounter gains a bounded amount, not a key-count amount", () => {
    const seeds = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const base = new EncounterHistory(seeds);
    base.recordLineage(["s1", "s2", "s3", "s4", "s5", "s6", "s1"]);
    // The attacker's main key genuinely meets one seed.
    base.record("attacker", "s1");

    const withRing = (size: number) => {
      const h = new EncounterHistory(seeds);
      h.recordLineage(["s1", "s2", "s3", "s4", "s5", "s6", "s1"]);
      h.record("attacker", "s1");
      const ring = ["attacker", ...Array.from({ length: size }, (_, i) => `sybil${i}`)];
      for (const [a, b] of allPairs(ring)) h.record(a, b);
      const all = standings(h);
      return ring.reduce((n, k) => n + (all.get(k) ?? 0), 0);
    };

    const small = withRing(5);
    const large = withRing(50);
    // Total standing in the attacker's region is capped by what flows over the
    // single attack edge, amplified by at most 1 / (1 − 0.8) — not by key count.
    expect(large).toBeLessThan(small * 1.5);
    expect(large).toBeLessThan(2);
    // One seed's full vouching budget, amplified, is the ceiling.
    expect(standingOf("attacker", base)).toBeLessThan(1);
  });
});

describe("rules validation", () => {
  const bad: [string, Partial<ScoringRules>][] = [
    ["zero threshold", { standingThreshold: 0 }],
    ["negative threshold", { standingThreshold: -1 }],
    ["NaN threshold", { standingThreshold: Number.NaN }],
    ["infinite threshold", { standingThreshold: Number.POSITIVE_INFINITY }],
    ["NaN base points", { basePoints: Number.NaN }],
    ["damping of 1", { damping: 1 }],
    ["amplifying rules", { damping: 0.9, vouchCapacity: 10 }],
  ];
  for (const [name, override] of bad) {
    it(`rejects ${name}`, () => {
      const rules = { ...DEFAULT_RULES, ...override };
      expect(() => scoreLineages([["a", "b"]], established("a", "b"), rules)).toThrow(RangeError);
      expect(() => handoffValue("a", "b", established("a", "b"), rules)).toThrow(RangeError);
    });
  }
});

describe("splitting the bounty", () => {
  it("pays out in proportion to points and balances exactly", () => {
    const awards = [
      { key: "a", points: 300, handoffs: 3 },
      { key: "b", points: 100, handoffs: 1 },
    ];
    const split = splitBounty(1_000_000n, awards);

    expect(split.get("a")).toBe(750_000n);
    expect(split.get("b")).toBe(250_000n);
    // Nothing is lost to rounding: a vault that cannot pay out its own dust
    // accumulates unclaimable balance forever.
    expect([...split.values()].reduce((n, v) => n + v, 0n)).toBe(1_000_000n);
  });

  it("balances even when the shares do not divide evenly", () => {
    const awards = [
      { key: "a", points: 1, handoffs: 1 },
      { key: "b", points: 1, handoffs: 1 },
      { key: "c", points: 1, handoffs: 1 },
    ];
    const split = splitBounty(100n, awards);
    expect([...split.values()].reduce((n, v) => n + v, 0n)).toBe(100n);
  });

  it("rejects a negative bounty and non-finite points", () => {
    expect(() => splitBounty(-1n, [{ key: "a", points: 1, handoffs: 1 }])).toThrow(RangeError);
    expect(() => splitBounty(10n, [{ key: "a", points: Number.NaN, handoffs: 1 }])).toThrow(
      RangeError,
    );
    expect(() => splitBounty(10n, [{ key: "a", points: -5, handoffs: 1 }])).toThrow(RangeError);
  });

  it("pays nobody when nobody scored", () => {
    expect(splitBounty(1000n, []).size).toBe(0);
    expect(
      splitBounty(1000n, [{ key: "a", points: 0, handoffs: 0 }]).size,
    ).toBe(0);
  });
});

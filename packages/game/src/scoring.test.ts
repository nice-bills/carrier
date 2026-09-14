import { describe, expect, it } from "vitest";
import { EncounterHistory } from "./strain.js";
import {
  DEFAULT_RULES,
  handoffValue,
  scoreLineages,
  splitBounty,
} from "./scoring.js";

/**
 * The scoring rule is the anti-sybil measure, so these tests are the security
 * argument rather than arithmetic checks. The one that matters is the last
 * group: a person with two phones has to earn approximately nothing.
 */

/** Give keys enough of a social record that standing is not the binding term. */
function established(...keys: string[]): EncounterHistory {
  const h = new EncounterHistory();
  for (const key of keys) {
    for (let i = 0; i < DEFAULT_RULES.standingThreshold; i += 1) {
      h.record(key, `witness-${key}-${i}`);
    }
  }
  return h;
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

    history.record("stranger", "someone");
    const oneFriend = handoffValue("known", "stranger", history);
    expect(oneFriend).toBeGreaterThan(0);
    expect(oneFriend).toBeLessThan(DEFAULT_RULES.basePoints);
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

describe("the two-phone attack", () => {
  it("earns approximately nothing", () => {
    // One person, two phones, bouncing a note between them all afternoon.
    const attacker = Array.from({ length: 20 }, () => ["phone1", "phone2"]);
    const attackerAwards = scoreLineages(attacker, new EncounterHistory());
    const attackerTotal = attackerAwards.reduce((n, a) => n + a.points, 0);

    // Two real people who each know other people, meeting twice.
    const honest = new EncounterHistory();
    for (const key of ["ada", "grace"]) {
      for (let i = 0; i < DEFAULT_RULES.standingThreshold; i += 1) {
        honest.record(key, `friend-${key}-${i}`);
      }
    }
    const honestAwards = scoreLineages([["ada", "grace"]], honest);
    const honestTotal = honestAwards.reduce((n, a) => n + a.points, 0);

    // Twenty fake handoffs are worth less than a single honest one, and the
    // attacker paid a transaction fee for every one of them.
    //
    // Not zero, and it is worth being exact about why. Two phones meeting each
    // other do give each other one distinct partner, which is a third of the
    // standing threshold — so they crawl up to a third of standing and no
    // further, while novelty decays as 1/n. The series converges: twenty
    // handoffs buy about 0.87 of one genuine encounter, and the next twenty buy
    // far less than that.
    expect(attackerTotal).toBeLessThan(honestTotal);
    expect(attackerTotal / honestTotal).toBeLessThan(1);

    // Doubling the effort does not come close to doubling the take.
    const twiceAsHard = scoreLineages(
      Array.from({ length: 40 }, () => ["phone1", "phone2"]),
      new EncounterHistory(),
    ).reduce((n, a) => n + a.points, 0);
    expect(twiceAsHard).toBeLessThan(attackerTotal * 1.3);
  });

  it("does not let an attacker buy standing with more of their own phones", () => {
    // Six phones, all in one pocket, meeting only each other.
    const phones = ["p1", "p2", "p3", "p4", "p5", "p6"];
    const lineages: string[][] = [];
    for (const a of phones) {
      for (const b of phones) {
        if (a !== b) lineages.push([a, b]);
      }
    }

    const history = new EncounterHistory();
    const awards = scoreLineages(lineages, history);
    const attackerTotal = awards.reduce((n, a) => n + a.points, 0);

    // A clique does eventually build standing among itself — it cannot be
    // stopped, only priced. What it cannot do is beat the same number of real
    // encounters, because every repeat inside the clique decays.
    const honest = new EncounterHistory();
    const realPeople = ["a", "b", "c", "d", "e", "f"];
    const realLineages: string[][] = [];
    for (const a of realPeople) {
      for (const b of realPeople) {
        if (a !== b) realLineages.push([a, b]);
      }
    }
    const honestTotal = scoreLineages(realLineages, honest).reduce(
      (n, a) => n + a.points,
      0,
    );

    // Same structure scores the same — so the clique's ceiling is exactly "as
    // good as that many genuine people", never better. Buying more phones buys
    // proportionally more cost, not more advantage.
    expect(attackerTotal).toBeCloseTo(honestTotal, 6);
  });
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

  it("pays nobody when nobody scored", () => {
    expect(splitBounty(1000n, []).size).toBe(0);
    expect(
      splitBounty(1000n, [{ key: "a", points: 0, handoffs: 0 }]).size,
    ).toBe(0);
  });
});

import type { EncounterHistory } from "./strain.js";

/**
 * What spreading is worth.
 *
 * This is the anti-sybil design made concrete rather than described. A hop is
 * cryptographic proof that two *keys* met — never that two *people* did — and
 * no radio or graph technique can close that gap, because one person holding
 * two phones is two keys that genuinely were in the same place. Distance
 * bounding answers the opposite question (are these two far apart pretending to
 * be close), and graph sybil detection only resolves large clusters, not pairs.
 *
 * So the defence is economic. Points for a handoff are multiplied by two terms
 * that a pocket full of your own phones cannot satisfy:
 *
 *   novelty  — collapses as the same pair meets repeatedly
 *   standing — near zero for a key nobody else has ever met
 *
 * The attacker's two phones meet only each other: novelty decays toward nothing
 * and standing never rises, so the chain earns approximately zero while still
 * costing transaction fees. The cheat is not detected. It is made pointless.
 */

export interface ScoringRules {
  /**
   * How many distinct partners a key needs before it counts as a real person.
   * Below this it earns a fraction, scaled linearly.
   */
  readonly standingThreshold: number;
  /** Points a genuinely novel handoff between two established keys is worth. */
  readonly basePoints: number;
}

export const DEFAULT_RULES: ScoringRules = {
  standingThreshold: 3,
  basePoints: 100,
};

/**
 * Value of one handoff, before it is shared between the two devices.
 *
 * `history` must describe the world *before* this handoff, otherwise a pair's
 * first meeting already counts as a repeat and nothing is ever novel.
 */
export function handoffValue(
  from: string,
  to: string,
  history: EncounterHistory,
  rules: ScoringRules = DEFAULT_RULES,
): number {
  // 1 for a first meeting, 1/2 for the second, 1/3 for the third...
  const novelty = 1 / (1 + history.timesMet(from, to));

  // A key nobody else has met is indistinguishable from a phone you just took
  // out of a drawer, so it carries almost no weight until others have met it.
  const standingOf = (key: string) =>
    Math.min(1, history.distinctPartners(key) / rules.standingThreshold);

  // The weaker of the two: a well-connected person handing to a drawer phone
  // should not be worth a full-value encounter either.
  const standing = Math.min(standingOf(from), standingOf(to));

  return rules.basePoints * novelty * standing;
}

export interface Award {
  key: string;
  points: number;
  /** Handoffs this key took part in within the scored lineages. */
  handoffs: number;
}

/**
 * Score a set of settled lineages.
 *
 * Both parties to a handoff are credited equally: receiving is as much work as
 * giving, and rewarding only the giver would make accepting a stranger's note
 * a pure cost. History accumulates as lineages are scored, so a pair that
 * appears repeatedly is worth less each time it does.
 */
export function scoreLineages(
  lineages: readonly (readonly string[])[],
  history: EncounterHistory,
  rules: ScoringRules = DEFAULT_RULES,
): Award[] {
  const points = new Map<string, number>();
  const handoffs = new Map<string, number>();

  const add = (key: string, value: number) => {
    points.set(key, (points.get(key) ?? 0) + value);
    handoffs.set(key, (handoffs.get(key) ?? 0) + 1);
  };

  for (const lineage of lineages) {
    for (let i = 0; i + 1 < lineage.length; i += 1) {
      const from = lineage[i]!;
      const to = lineage[i + 1]!;

      // Value is read before recording, so this meeting is judged against the
      // history that preceded it rather than one that already includes it.
      const value = handoffValue(from, to, history, rules);
      add(from, value / 2);
      add(to, value / 2);

      history.record(from, to);
    }
  }

  return [...points.entries()]
    .map(([key, p]) => ({ key, points: p, handoffs: handoffs.get(key) ?? 0 }))
    .sort((a, b) => b.points - a.points);
}

/**
 * Split a bounty in proportion to points.
 *
 * Integer arithmetic throughout, with the remainder going to the top scorer
 * rather than being lost to rounding — the pot has to balance exactly or the
 * vault ends up holding dust nobody can claim.
 */
export function splitBounty(bounty: bigint, awards: readonly Award[]): Map<string, bigint> {
  const split = new Map<string, bigint>();
  const total = awards.reduce((n, a) => n + a.points, 0);
  if (total <= 0 || awards.length === 0) return split;

  // Scale to integers before dividing: floating point shares of a bigint pot
  // do not round predictably, and this has to add up.
  const SCALE = 1_000_000n;
  const weights = awards.map((a) =>
    BigInt(Math.round((a.points / total) * Number(SCALE))),
  );
  const weightTotal = weights.reduce((n, w) => n + w, 0n);
  if (weightTotal === 0n) return split;

  let handedOut = 0n;
  awards.forEach((award, i) => {
    const share = (bounty * weights[i]!) / weightTotal;
    split.set(award.key, share);
    handedOut += share;
  });

  const dust = bounty - handedOut;
  if (dust > 0n) {
    const top = awards[0]!.key;
    split.set(top, (split.get(top) ?? 0n) + dust);
  }

  return split;
}

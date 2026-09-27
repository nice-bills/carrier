import type { EncounterHistory } from "./strain.js";

/**
 * What spreading is worth.
 *
 * A hop is cryptographic proof that two *keys* met — never that two *people*
 * did — and no radio or graph technique can close that gap, because one person
 * holding two phones is two keys that genuinely were in the same place. Keys are
 * free, so any rule that only counts keys (distinct partners, handoffs, chain
 * length) can be farmed by a pocket full of phones meeting each other.
 *
 * So standing is not counted, it is *conferred*. It starts at a set of seed keys
 * that cost something to hold — a bonded pouch, independent settlement history,
 * an organiser's list — and flows outward along encounters:
 *
 *   standing(seed) = 1
 *   standing(k)    = min(1, Σ over partners p of  standing(p) · share(p) / T)
 *   share(p)       = damping · min(1, vouchCapacity / partners(p))
 *
 * Each key can pass on at most `damping · vouchCapacity` of its own standing in
 * total, however many keys it meets, and the rules require that to be less
 * than `T` (the standing threshold). That makes the whole map a contraction:
 * standing is only ever created at seeds, and any region of the graph holds at
 * most `1 / (1 − damping · vouchCapacity / T)` times what flows into it across
 * its edges to the rest.
 *
 * What this prevents:
 *   - A ring or clique of fresh keys that never met anyone with standing has
 *     standing exactly 0, however many keys or handoffs it adds, so it scores
 *     0 and draws nothing from a bounty.
 *   - A ring attached to the honest world through a few real encounters gets
 *     standing bounded by those encounters, not by the number of keys in it.
 *
 * What it does not prevent:
 *   - An attacker who genuinely meets people with standing earns standing, and
 *     can pass a bounded amount of it to their own extra keys. The bound scales
 *     with those real encounters; it is not zero.
 *   - It is only as good as the seed set. A seed that vouches for sybils, or a
 *     cheap way to become a seed, defeats it. Choosing seeds is policy the
 *     caller owns.
 *   - Honest players far from any seed have low standing until they meet
 *     someone closer. That is the price of not trusting keys by count.
 *
 * Points for a handoff are then `basePoints × novelty × min(standing)`, where
 * novelty collapses as the same pair meets repeatedly.
 */

export interface ScoringRules {
  /**
   * Standing a key must be conferred, summed over its partners, before it counts
   * fully. Must be finite and positive.
   */
  readonly standingThreshold: number;
  /** Points a genuinely novel handoff between two established keys is worth. */
  readonly basePoints: number;
  /** Fraction of a key's standing that flows to each partner. In [0, 1). */
  readonly damping?: number;
  /**
   * Partners a key can vouch for at full strength. Beyond this its vouching is
   * split, so meeting more keys does not create more standing.
   */
  readonly vouchCapacity?: number;
}

export const DEFAULT_RULES: ScoringRules = {
  standingThreshold: 3,
  basePoints: 100,
  damping: 0.8,
  vouchCapacity: 3,
};

const DEFAULT_DAMPING = 0.8;
const DEFAULT_VOUCH_CAPACITY = 3;

/** Throws unless the rules describe a bounded, finite scoring. */
export function validateRules(rules: ScoringRules): void {
  const { standingThreshold: t, basePoints } = rules;
  const damping = rules.damping ?? DEFAULT_DAMPING;
  const capacity = rules.vouchCapacity ?? DEFAULT_VOUCH_CAPACITY;
  if (!Number.isFinite(t) || t <= 0) {
    throw new RangeError(`standingThreshold must be finite and positive, got ${t}`);
  }
  if (!Number.isFinite(basePoints) || basePoints < 0) {
    throw new RangeError(`basePoints must be finite and non-negative, got ${basePoints}`);
  }
  if (!Number.isFinite(damping) || damping < 0 || damping >= 1) {
    throw new RangeError(`damping must be in [0, 1), got ${damping}`);
  }
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new RangeError(`vouchCapacity must be finite and positive, got ${capacity}`);
  }
  if (damping * capacity >= t) {
    // At or above this, a clique of fresh keys amplifies any trickle of
    // standing into full standing for all of them.
    throw new RangeError("damping × vouchCapacity must be below standingThreshold");
  }
}

const TOLERANCE = 1e-12;
/** Past this a factor is too close to 1 to settle in reasonable time; fail loudly. */
const MAX_ROUNDS = 100_000;

const cache = new WeakMap<
  EncounterHistory,
  { version: number; rules: ScoringRules; standing: Map<string, number> }
>();

/**
 * Standing of every key the history knows, in [0, 1]. Seeds are 1; a key with
 * no path to a seed is 0. See the module comment for the rule.
 */
export function standings(
  history: EncounterHistory,
  rules: ScoringRules = DEFAULT_RULES,
): Map<string, number> {
  validateRules(rules);
  const hit = cache.get(history);
  if (hit && hit.version === history.version && hit.rules === rules) return hit.standing;

  const damping = rules.damping ?? DEFAULT_DAMPING;
  const capacity = rules.vouchCapacity ?? DEFAULT_VOUCH_CAPACITY;
  const t = rules.standingThreshold;

  const keys = new Set<string>([...history.keys(), ...history.seeds]);
  const share = new Map<string, number>();
  for (const k of keys) {
    share.set(k, damping * Math.min(1, capacity / Math.max(1, history.distinctPartners(k))));
  }

  // Least fixed point, iterated up from "only seeds have standing". The map is
  // monotone and (by validateRules) a contraction with factor c, so the error
  // after n rounds is at most c^n; the round budget is derived from c so a
  // factor close to 1 gets enough rounds rather than a silently wrong answer.
  const c = (damping * capacity) / t;
  const rounds = c <= 0 ? 2 : Math.min(MAX_ROUNDS, Math.ceil(Math.log(TOLERANCE) / Math.log(c)) + 2);
  let current = new Map<string, number>();
  for (const k of keys) current.set(k, history.isSeed(k) ? 1 : 0);
  let converged = false;
  for (let round = 0; round < rounds; round += 1) {
    const next = new Map<string, number>();
    let delta = 0;
    for (const k of keys) {
      let value: number;
      if (history.isSeed(k)) {
        value = 1;
      } else {
        let inflow = 0;
        for (const p of history.partnersOf(k)) inflow += current.get(p)! * share.get(p)!;
        value = Math.min(1, inflow / t);
      }
      delta = Math.max(delta, Math.abs(value - current.get(k)!));
      next.set(k, value);
    }
    current = next;
    if (delta < TOLERANCE) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error(`standing did not converge within ${rounds} rounds`);
  }

  cache.set(history, { version: history.version, rules, standing: current });
  return current;
}

/** Standing of one key. See `standings`. */
export function standingOf(
  key: string,
  history: EncounterHistory,
  rules: ScoringRules = DEFAULT_RULES,
): number {
  return standings(history, rules).get(key) ?? 0;
}

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

  // The weaker of the two: a well-connected person handing to a drawer phone
  // should not be worth a full-value encounter either.
  const all = standings(history, rules);
  const standing = Math.min(all.get(from) ?? 0, all.get(to) ?? 0);

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
  validateRules(rules);
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
  if (typeof bounty !== "bigint" || bounty < 0n) {
    throw new RangeError(`bounty must be a non-negative bigint, got ${String(bounty)}`);
  }
  for (const a of awards) {
    if (!Number.isFinite(a.points) || a.points < 0) {
      throw new RangeError(`points for ${a.key} must be finite and non-negative, got ${a.points}`);
    }
  }
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

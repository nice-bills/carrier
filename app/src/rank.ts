/**
 * Rank, and why it counts what it counts.
 *
 * Distinct people met — never handoffs. That is not a cosmetic choice: it makes
 * the status people chase identical to the quantity a sybil cannot farm. Passing
 * the same note back and forth with one accomplice moves the handoff count and
 * leaves rank exactly where it was, so the thing players optimise for is the
 * thing the protocol wanted anyway.
 *
 * The names are an epidemic on purpose. You are not levelling up an account,
 * you are becoming more infectious.
 */

export interface Rank {
  /** Distinct people required to hold this rank. */
  readonly at: number;
  readonly name: string;
  readonly colour: string;
}

export const RANKS: readonly Rank[] = [
  { at: 0, name: "Dormant", colour: "#5F736D" },
  { at: 1, name: "Exposed", colour: "#8DA09A" },
  { at: 3, name: "Carrier", colour: "#E4913C" },
  { at: 6, name: "Vector", colour: "#3FBFA0" },
  { at: 10, name: "Superspreader", colour: "#E6EDEA" },
];

export interface RankState {
  current: Rank;
  next: Rank | null;
  /** 0–1 toward the next rank; 1 at the top. */
  progress: number;
  /** Ready-made line for the UI, so the screen holds no copy logic. */
  caption: string;
}

export function rankFor(peopleMet: number): RankState {
  let current = RANKS[0]!;
  for (const rank of RANKS) {
    if (peopleMet >= rank.at) current = rank;
  }

  const next = RANKS.find((r) => r.at > peopleMet) ?? null;
  if (!next) {
    return { current, next: null, progress: 1, caption: "nothing left to reach" };
  }

  const span = next.at - current.at;
  const done = peopleMet - current.at;
  const remaining = next.at - peopleMet;

  return {
    current,
    next,
    // Guard the span: two ranks defined at the same threshold would divide by
    // zero and render a NaN-width bar rather than failing loudly.
    progress: span > 0 ? done / span : 1,
    caption: `${remaining} more to ${next.name.toLowerCase()}`,
  };
}

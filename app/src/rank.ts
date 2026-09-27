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
 *
 * Colours are theme tokens chosen to read at 4.5:1 or better on paper, and
 * the rank name is always shown in text beside them: colour is never the only
 * signal.
 */

import { C } from "./theme";

export interface Rank {
  /** Distinct people required to hold this rank. */
  readonly at: number;
  readonly name: string;
  readonly colour: string;
}

export const RANKS: readonly Rank[] = [
  { at: 0, name: "Dormant", colour: C.ink3 },
  { at: 1, name: "Exposed", colour: C.denim },
  { at: 3, name: "Carrier", colour: C.stampInk },
  { at: 6, name: "Vector", colour: C.paidInk },
  { at: 10, name: "Superspreader", colour: C.ink },
];

export interface RankState {
  current: Rank;
  next: Rank | null;
  /** 0–1 toward the next rank; 1 at the top. */
  progress: number;
  /** Ready-made line for the UI, so the screen holds no copy logic. */
  caption: string;
}

export function rankFor(peopleMetRaw: number): RankState {
  // NaN, negatives and fractions would otherwise compare their way to the top
  // rank or to a NaN progress bar. Anything that is not a count is zero.
  const peopleMet =
    Number.isFinite(peopleMetRaw) && peopleMetRaw > 0 ? Math.floor(peopleMetRaw) : 0;
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

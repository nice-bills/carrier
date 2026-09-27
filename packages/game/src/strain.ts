import type { PublicKey } from "@solana/web3.js";

/**
 * Carrier, played as an epidemic.
 *
 * The payments engine underneath is unchanged: a strain travels as a note, and
 * a note only moves when two devices are physically near each other and both
 * sign the handoff. What the game adds is a reason to want it to spread, and a
 * scoring rule that decides what spreading is worth.
 *
 * The reason this works as a game and not as a gimmick: you cannot play it from
 * a chair. Reaching people is the only move, and the chain of who reached whom
 * is signed by both parties rather than reported by either.
 */

export interface Strain {
  /** Note hash of the originating release. Identifies the epidemic. */
  readonly id: string;
  readonly name: string;
  /** Who released it. */
  readonly patientZero: string;
  /** Total prize, split along the lineage by `scoreLineage`. */
  readonly bounty: bigint;
  /** Unix seconds after which it stops spreading and pays out. */
  readonly endsAt: bigint;
}

/** One device's view of a strain it is carrying. */
export interface Infection {
  readonly strain: string;
  /** How many handoffs away from patient zero this device sits. */
  readonly generation: number;
  /** When this device caught it. */
  readonly caughtAt: bigint;
  /** Who gave it to them. */
  readonly from: string;
}

/**
 * Who has met whom, as far as settled lineages reveal.
 *
 * The game needs this because the scoring rule is built on novelty, and novelty
 * is only meaningful against a record of what has already happened. It is
 * reconstructed from settlement events rather than self-reported, so a device
 * cannot improve its own standing by lying about who it has met.
 */
export class EncounterHistory {
  private readonly pairs = new Map<string, number>();
  private readonly partners = new Map<string, Set<string>>();
  private readonly seedKeys: Set<string>;
  private changes = 0;

  /**
   * `seeds` are the keys standing is anchored to: keys that cost something to
   * hold, such as a bonded pouch or independent settlement history. Without
   * seeds nobody has standing, because nothing distinguishes a real person from
   * a key generated a second ago.
   */
  constructor(seeds: Iterable<string> = []) {
    this.seedKeys = new Set(seeds);
  }

  private static pairKey(a: string, b: string): string {
    // Unordered: meeting is symmetric, and treating A→B and B→A as different
    // pairs would let two phones alternate direction to dodge the decay.
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  record(a: string, b: string): void {
    const key = EncounterHistory.pairKey(a, b);
    this.pairs.set(key, (this.pairs.get(key) ?? 0) + 1);

    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const set = this.partners.get(x!) ?? new Set<string>();
      set.add(y!);
      this.partners.set(x!, set);
    }
    this.changes += 1;
  }

  /** Absorb a whole settled chain. */
  recordLineage(lineage: readonly string[]): void {
    for (let i = 0; i + 1 < lineage.length; i += 1) {
      this.record(lineage[i]!, lineage[i + 1]!);
    }
  }

  /** Mark a key as a trust anchor (bonded, or with independent history). */
  addSeed(key: string): void {
    if (!this.seedKeys.has(key)) {
      this.seedKeys.add(key);
      this.changes += 1;
    }
  }

  isSeed(key: string): boolean {
    return this.seedKeys.has(key);
  }

  get seeds(): ReadonlySet<string> {
    return this.seedKeys;
  }

  timesMet(a: string, b: string): number {
    return this.pairs.get(EncounterHistory.pairKey(a, b)) ?? 0;
  }

  /** How many different keys this key is known to have met. */
  distinctPartners(key: string): number {
    return this.partners.get(key)?.size ?? 0;
  }

  /** The distinct keys this key is known to have met. */
  partnersOf(key: string): ReadonlySet<string> {
    return this.partners.get(key) ?? EMPTY;
  }

  /** Every key that has met anyone. */
  keys(): IterableIterator<string> {
    return this.partners.keys();
  }

  /** Bumps whenever the record changes, so derived values can be cached. */
  get version(): number {
    return this.changes;
  }

  get population(): number {
    return this.partners.size;
  }
}

const EMPTY: ReadonlySet<string> = new Set();

export const keyOf = (k: PublicKey | string): string =>
  typeof k === "string" ? k : k.toBase58();

/**
 * Reading settlement data as an epidemic.
 *
 * Every settled note publishes its lineage — the sender, then each carrier in
 * order. That is a transmission chain, and enough of them make a transmission
 * *tree*: who handed to whom, how far anything travelled, who moved the most.
 *
 * This is the whole basis of the contagion surface. The spread map is not a
 * decoration layered on top of payments; it is what the settlement events
 * already say, drawn. Nothing here needs a second protocol.
 */

export interface SettledLineage {
  /** Sender first, then each carrier in hop order. */
  readonly lineage: string[];
  readonly noteHash: string;
  readonly settledAt?: number;
}

export interface SpreadEdge {
  from: string;
  to: string;
  /** How many distinct notes passed along this edge. */
  weight: number;
}

export interface Carrier {
  key: string;
  /** Distinct people this key handed something to. */
  passedTo: Set<string>;
  /** Distinct people this key received from. */
  receivedFrom: Set<string>;
  /** Notes that travelled through this key. */
  carried: number;
}

export interface Spread {
  carriers: Map<string, Carrier>;
  edges: SpreadEdge[];
  /** Keys that originated something and were never handed anything. */
  origins: string[];
  /** Longest chain observed, in hops. */
  longestChain: number;
}

export function buildSpread(settled: readonly SettledLineage[]): Spread {
  const carriers = new Map<string, Carrier>();
  const edgeIndex = new Map<string, SpreadEdge>();
  let longestChain = 0;

  const touch = (key: string): Carrier => {
    let c = carriers.get(key);
    if (!c) {
      c = { key, passedTo: new Set(), receivedFrom: new Set(), carried: 0 };
      carriers.set(key, c);
    }
    return c;
  };

  for (const { lineage } of settled) {
    if (lineage.length === 0) continue;
    longestChain = Math.max(longestChain, lineage.length - 1);

    for (const key of lineage) touch(key).carried += 1;

    for (let i = 0; i + 1 < lineage.length; i += 1) {
      const from = lineage[i]!;
      const to = lineage[i + 1]!;
      touch(from).passedTo.add(to);
      touch(to).receivedFrom.add(from);

      const id = `${from}->${to}`;
      const existing = edgeIndex.get(id);
      if (existing) existing.weight += 1;
      else edgeIndex.set(id, { from, to, weight: 1 });
    }
  }

  const origins = [...carriers.values()]
    .filter((c) => c.receivedFrom.size === 0 && c.passedTo.size > 0)
    .map((c) => c.key);

  return { carriers, edges: [...edgeIndex.values()], origins, longestChain };
}

/**
 * Average number of distinct people each carrier passed to.
 *
 * Borrowed from epidemiology and meant literally: above 1.0 the thing is
 * spreading, below 1.0 it is dying out. Counts *distinct* recipients rather
 * than handoffs, so passing the same note back and forth does not inflate it.
 */
export function reproductionNumber(spread: Spread): number {
  const spreaders = [...spread.carriers.values()].filter(
    (c) => c.passedTo.size > 0 || c.receivedFrom.size > 0,
  );
  if (spreaders.length === 0) return 0;
  const total = spreaders.reduce((n, c) => n + c.passedTo.size, 0);
  return total / spreaders.length;
}

/**
 * Who moved the most — by distinct recipients, not volume.
 *
 * Deliberately not "most notes carried": that rewards sitting in a busy room,
 * while reaching new people is the behaviour that actually makes a mesh work.
 * It is also the harder number to fake, since a pocket full of your own phones
 * is a very small set of distinct recipients.
 */
export function superspreaders(spread: Spread, limit = 5): Carrier[] {
  return [...spread.carriers.values()]
    .filter((c) => c.passedTo.size > 0)
    .sort((a, b) => b.passedTo.size - a.passedTo.size || b.carried - a.carried)
    .slice(0, limit);
}

/**
 * How far each key sits from the nearest origin, in hops.
 *
 * Breadth-first from every origin at once, so a key reachable by two routes
 * takes the shorter one. Unreachable keys are omitted rather than given
 * Infinity — a caller drawing a map wants only what it can place.
 */
export function generations(spread: Spread): Map<string, number> {
  const depth = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const edge of spread.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }

  const queue: string[] = [];
  for (const origin of spread.origins) {
    depth.set(origin, 0);
    queue.push(origin);
  }

  // A read index rather than `queue.shift()`, which is O(n) per call and makes
  // the walk quadratic on a large spread.
  for (let head = 0; head < queue.length; head += 1) {
    const key = queue[head]!;
    const here = depth.get(key)!;
    for (const next of outgoing.get(key) ?? []) {
      if (depth.has(next)) continue; // already reached by a shorter route
      depth.set(next, here + 1);
      queue.push(next);
    }
  }

  return depth;
}

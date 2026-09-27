import { Keypair } from "@solana/web3.js";

/**
 * The preview's cast, in a module of its own so `services.ts` and `places.ts`
 * can both use it without importing each other.
 */

const seeded = (n: number) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 31 + 11) & 255));

/** The cast. Keys are fixed so screenshots are stable. */
export const cast = {
  me: seeded(1),
  ama: seeded(2),
  chidi: seeded(3),
  mei: seeded(4),
  zanele: seeded(5),
  kofi: seeded(6),
  tunde: seeded(7),
};

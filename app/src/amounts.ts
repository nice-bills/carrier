import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";

/**
 * Showing an amount honestly.
 *
 * A note names a pouch, not a mint, and a phone with no signal cannot look the
 * pouch up. But the pouch address is derived from `["pouch", owner, mint]`, and
 * the bundle carries the owner, so for mints we know about we can check which
 * one it is and show real units. Anything else is shown as raw base units with
 * no decimal point, rather than guessing six decimals.
 */

export const PROGRAM_ID = new PublicKey("CJBPBb6WBPWptmpiW4Kdb7SeRC7Cmob5YAaBtKSMXBvt");

export interface KnownMint {
  mint: PublicKey;
  symbol: string;
  decimals: number;
}

export const KNOWN_MINTS: KnownMint[] = [
  // USDC, mainnet and devnet.
  { mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), symbol: "USDC", decimals: 6 },
  { mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), symbol: "USDC", decimals: 6 },
];

const cache = new Map<string, KnownMint | null>();

export function mintOf(bundle: Bundle): KnownMint | null {
  const k = `${bundle.owner.toBase58()}:${bundle.note.pouch.toBase58()}`;
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  let found: KnownMint | null = null;
  for (const m of KNOWN_MINTS) {
    try {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("pouch"), bundle.owner.toBuffer(), m.mint.toBuffer()],
        PROGRAM_ID,
      );
      if (pda.equals(bundle.note.pouch)) {
        found = m;
        break;
      }
    } catch {
      // not derivable: leave unknown
    }
  }
  cache.set(k, found);
  return found;
}

export function formatUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** "12.5 USDC", or "12500000 units" when the mint is not one we recognise. */
export function formatAmount(bundle: Bundle): { text: string; spoken: string } {
  const m = mintOf(bundle);
  if (m) {
    const v = formatUnits(bundle.note.amount, m.decimals);
    return { text: `${v} ${m.symbol}`, spoken: `${v} ${m.symbol}` };
  }
  const v = bundle.note.amount.toString();
  return { text: `${v} units`, spoken: `${v} base units of an unrecognised token` };
}

/** Totals per recognised token. Unrecognised tokens are counted, never summed. */
export function totals(bundles: Bundle[]): { known: { symbol: string; text: string }[]; unknown: number } {
  const sums = new Map<string, { m: KnownMint; sum: bigint }>();
  let unknown = 0;
  for (const b of bundles) {
    const m = mintOf(b);
    if (!m) {
      unknown += 1;
      continue;
    }
    const k = m.mint.toBase58();
    const cur = sums.get(k) ?? { m, sum: 0n };
    cur.sum += b.note.amount;
    sums.set(k, cur);
  }
  return {
    known: [...sums.values()].map(({ m, sum }) => ({ symbol: m.symbol, text: `${formatUnits(sum, m.decimals)} ${m.symbol}` })),
    unknown,
  };
}

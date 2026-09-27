import { MAX_NOTE_LIFETIME_SECONDS, SLOTS_PER_EPOCH } from "@carrier/protocol";
import { DEFAULT_NOTE_LIFETIME_SECONDS } from "./config";

/**
 * The phone's own books: what it last knew about its pouch, which slots it has
 * signed, and which of its payments have not been seen to settle.
 *
 * Pure functions over plain data, so they run (and are tested) in Node with no
 * device modules. Everything bigint is stored as a decimal string, because the
 * pocket is written as JSON.
 *
 * Why this matters: a pouch slot signed twice is a double spend, and the
 * program takes the bond for it. The phone therefore records a slot as used
 * *before* it signs against it, never reuses one within an epoch, and when it
 * has no signal it refuses to sign past what the last pouch it saw could
 * cover, less everything it has already signed that has not settled.
 */

/** A pouch as last fetched, in storage form. */
export interface CachedPouch {
  address: string;
  owner: string;
  mint: string;
  committed: string;
  settled: string;
  bond: string;
  epoch: number;
  epochStartedAt: string;
  /** 256-bit settled-slot map as four u64 words, low word first. */
  spent: string[];
  available: string;
  /** When it was fetched, ms since epoch (phone clock). */
  fetchedAt: number;
  /**
   * Per slot, the fingerprint (first 8 bytes of the note hash, little-endian)
   * of the note that settled it. Present on a fresh fetch, not kept on disk.
   */
  fingerprints?: string[];
}

/** The fields of a fetched pouch this module reads. Matches `@carrier/client`'s PouchState. */
export interface PouchLike {
  address: { toBase58(): string };
  owner: { toBase58(): string };
  mint: { toBase58(): string };
  committed: bigint;
  settled: bigint;
  bond: bigint;
  epoch: number;
  epochStartedAt: bigint;
  spent: bigint[];
  available: bigint;
  settledFingerprints?: bigint[];
}

/** A payment this phone signed, kept until it settles, expires or its epoch ends. */
export interface SignedNote {
  hash: string;
  pouch: string;
  to: string;
  epoch: number;
  slot: number;
  amount: string;
  relayFeeBps: number;
  expiry: string;
  /** When it was signed, ms since epoch. */
  at: number;
  /** Seen spent on-chain. Kept briefly for the record, never counted again. */
  settled?: boolean;
}

export function toCached(p: PouchLike, fetchedAt = Date.now()): CachedPouch {
  return {
    address: p.address.toBase58(),
    owner: p.owner.toBase58(),
    mint: p.mint.toBase58(),
    committed: p.committed.toString(),
    settled: p.settled.toString(),
    bond: p.bond.toString(),
    epoch: p.epoch,
    epochStartedAt: p.epochStartedAt.toString(),
    spent: p.spent.map((w) => w.toString()),
    available: p.available.toString(),
    fetchedAt,
    ...(p.settledFingerprints ? { fingerprints: p.settledFingerprints.map((f) => f.toString()) } : {}),
  };
}

/** The program's note fingerprint: the note hash's first 8 bytes as a little-endian u64. */
export function fingerprint(hashHex: string): bigint {
  let f = 0n;
  for (let i = 7; i >= 0; i -= 1) f = (f << 8n) | BigInt(parseInt(hashHex.slice(i * 2, i * 2 + 2), 16));
  return f;
}

/**
 * What a pouch says about one of its slots, for a note with this hash:
 * still open, settled by this very note, or settled by a different note
 * (the sender signed the slot twice, and this note lost).
 */
export function slotVerdict(p: Pick<CachedPouch, "spent" | "fingerprints">, slot: number, hashHex: string): "open" | "ours" | "other" {
  if (!bitSet(p.spent, slot)) return "open";
  const fp = p.fingerprints?.[slot];
  if (fp === undefined) return "ours";
  return BigInt(fp) === fingerprint(hashHex) ? "ours" : "other";
}

const INT = /^\d{1,20}$/;
const isKeyText = (x: unknown) => typeof x === "string" && x.length >= 32 && x.length <= 44;

/** Shape-check a cached pouch read back from disk. Returns null for anything off. */
export function parseCached(x: unknown): CachedPouch | null {
  if (typeof x !== "object" || x === null) return null;
  const c = x as Record<string, unknown>;
  const ints = ["committed", "settled", "bond", "epochStartedAt", "available"] as const;
  if (!isKeyText(c.address) || !isKeyText(c.owner) || !isKeyText(c.mint)) return null;
  if (!ints.every((k) => typeof c[k] === "string" && INT.test(c[k] as string))) return null;
  if (typeof c.epoch !== "number" || !Number.isInteger(c.epoch) || c.epoch < 0) return null;
  if (!Array.isArray(c.spent) || c.spent.length !== 4 || !c.spent.every((w) => typeof w === "string" && INT.test(w))) return null;
  if (typeof c.fetchedAt !== "number" || !Number.isFinite(c.fetchedAt)) return null;
  return c as unknown as CachedPouch;
}

export function parseSigned(x: unknown): SignedNote | null {
  if (typeof x !== "object" || x === null) return null;
  const s = x as Record<string, unknown>;
  if (typeof s.hash !== "string" || !/^[0-9a-f]{64}$/.test(s.hash)) return null;
  if (!isKeyText(s.pouch) || !isKeyText(s.to)) return null;
  if (typeof s.epoch !== "number" || !Number.isInteger(s.epoch)) return null;
  if (typeof s.slot !== "number" || !Number.isInteger(s.slot) || s.slot < 0 || s.slot >= SLOTS_PER_EPOCH) return null;
  if (typeof s.amount !== "string" || !INT.test(s.amount)) return null;
  if (typeof s.expiry !== "string" || !INT.test(s.expiry)) return null;
  if (typeof s.relayFeeBps !== "number") return null;
  if (typeof s.at !== "number") return null;
  return { ...(s as unknown as SignedNote), settled: s.settled === true };
}

/** Is slot `i` marked settled in a four-word spent map? Same layout as the program. */
export function bitSet(spent: readonly (string | bigint)[], i: number): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= SLOTS_PER_EPOCH) return true;
  const word = BigInt(spent[Math.floor(i / 64)] ?? 0);
  return ((word >> BigInt(i % 64)) & 1n) === 1n;
}

/**
 * The cached pouch in the shape `@carrier/client` works with, bigints and
 * `isSlotSpent` restored. Keys are left as strings wrapped in `toBase58`, which
 * is all the slot and balance helpers read.
 */
export function rehydrate(c: CachedPouch) {
  const key = (s: string) => ({ toBase58: () => s, toString: () => s });
  const spent = c.spent.map((w) => BigInt(w));
  return {
    address: key(c.address),
    owner: key(c.owner),
    mint: key(c.mint),
    committed: BigInt(c.committed),
    settled: BigInt(c.settled),
    bond: BigInt(c.bond),
    epoch: c.epoch,
    epochStartedAt: BigInt(c.epochStartedAt),
    spent,
    available: BigInt(c.available),
    isSlotSpent: (i: number) => bitSet(spent, i),
  };
}

/** First slot neither settled on-chain (as last seen) nor signed on this phone. */
export function firstFreeSlot(spent: readonly (string | bigint)[], used: ReadonlySet<number>): number | null {
  for (let i = 0; i < SLOTS_PER_EPOCH; i += 1) {
    if (!used.has(i) && !bitSet(spent, i)) return i;
  }
  return null;
}

/** Slack on the phone's clock when deciding a note can no longer settle. */
const EXPIRY_SLACK_SECONDS = 600n;

/**
 * Signed notes that may still settle against this epoch, and so still claim
 * part of the pouch. A note from an older epoch can never settle (the program
 * checks the epoch), and one past its expiry cannot either.
 */
export function outstanding(signed: readonly SignedNote[], epoch: number, nowSec: bigint): SignedNote[] {
  return signed.filter(
    (s) => !s.settled && s.epoch === epoch && BigInt(s.expiry) + EXPIRY_SLACK_SECONDS > nowSec,
  );
}

/**
 * What this phone may still sign for: the pouch's `available` as last fetched,
 * minus every payment signed here that has not been seen to settle. Never
 * negative. Zero with no pouch.
 */
export function spendable(cache: CachedPouch | null, signed: readonly SignedNote[], nowSec: bigint): bigint {
  if (!cache) return 0n;
  const owed = outstanding(signed, cache.epoch, nowSec).reduce((n, s) => n + BigInt(s.amount), 0n);
  const left = BigInt(cache.available) - owed;
  return left > 0n ? left : 0n;
}

/** When no note from the pouch's current epoch can settle any more (unix seconds). */
export const epochClosesAt = (cache: CachedPouch): bigint =>
  BigInt(cache.epochStartedAt) + MAX_NOTE_LIFETIME_SECONDS;

/**
 * Expiry for a new note: a week from now, but never past the epoch's close.
 * Null when the epoch has (nearly) closed and a note would be born dead.
 */
export function noteExpiry(nowSec: bigint, epochStartedAt: bigint, lifetime = DEFAULT_NOTE_LIFETIME_SECONDS): bigint | null {
  const cap = epochStartedAt + MAX_NOTE_LIFETIME_SECONDS;
  const want = nowSec + lifetime;
  const expiry = want < cap ? want : cap;
  // Less than an hour to live is not worth handing to anyone.
  return expiry - nowSec >= 3600n ? expiry : null;
}

/** How a settled note's money leaves the pouch. Mirrors `split_payout` in rules.rs. */
export function splitPayout(amount: bigint, relayFeeBps: number, relayers: number) {
  const relayFee = (amount * BigInt(relayFeeBps)) / 10_000n;
  const toRecipient = amount - relayFee;
  const perRelayer = relayers > 0 ? relayFee / BigInt(relayers) : 0n;
  const toRelayers = perRelayer * BigInt(relayers);
  return { relayFee, toRecipient, perRelayer, toRelayers, kept: relayFee - toRelayers };
}

/**
 * Parse what someone typed as an amount, in base units. Accepts "5", "5.2",
 * "5,20" (comma decimal), refuses more decimals than the token has, negatives,
 * zero, and anything that is not a number.
 */
export function parseAmount(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(",", ".");
  const m = /^(\d{1,12})(?:\.(\d*))?$/.exec(t) ?? /^()\.(\d+)$/.exec(t);
  if (!m) return null;
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac || "0").padEnd(decimals, "0"));
  return units > 0n ? units : null;
}

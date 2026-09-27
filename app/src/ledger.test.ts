import { describe, expect, it } from "vitest";
import { MAX_NOTE_LIFETIME_SECONDS } from "@carrier/protocol";
import {
  bitSet,
  firstFreeSlot,
  noteExpiry,
  outstanding,
  parseAmount,
  parseCached,
  spendable,
  splitPayout,
  type CachedPouch,
  type SignedNote,
} from "./ledger";

const KEY = "11111111111111111111111111111112";
const pouch = (over: Partial<CachedPouch> = {}): CachedPouch => ({
  address: KEY,
  owner: KEY,
  mint: KEY,
  committed: "25000000",
  settled: "3000000",
  bond: "5000000",
  epoch: 1,
  epochStartedAt: "1000",
  spent: ["11", "0", "0", "0"], // slots 0, 1, 3
  available: "22000000",
  fetchedAt: 0,
  ...over,
});
const signed = (over: Partial<SignedNote> = {}): SignedNote => ({
  hash: "a".repeat(64),
  pouch: KEY,
  to: KEY,
  epoch: 1,
  slot: 2,
  amount: "5000000",
  relayFeeBps: 200,
  expiry: "999999999999",
  at: 0,
  ...over,
});

describe("amounts people type", () => {
  it("parses whole, decimal and comma amounts into base units", () => {
    expect(parseAmount("5", 6)).toBe(5_000_000n);
    expect(parseAmount("2.5", 6)).toBe(2_500_000n);
    expect(parseAmount("2,50", 6)).toBe(2_500_000n);
    expect(parseAmount(".75", 6)).toBe(750_000n);
    expect(parseAmount(" 12. ", 6)).toBe(12_000_000n);
  });
  it("refuses zero, negatives, junk and more decimals than the token has", () => {
    for (const bad of ["", "0", "0.000", "-1", "1e3", "abc", "1.2.3", "0.0000001"]) {
      expect(parseAmount(bad, 6)).toBeNull();
    }
  });
});

describe("slots", () => {
  it("reads the spent map the way the program writes it", () => {
    const words = ["11", "0", (1n << 63n).toString(), "0"];
    expect([0, 1, 2, 3].map((i) => bitSet(words, i))).toEqual([true, true, false, true]);
    expect(bitSet(words, 191)).toBe(true);
    expect(bitSet(words, 256)).toBe(true); // out of range counts as unusable
  });
  it("never picks a slot settled on-chain or signed on this phone", () => {
    expect(firstFreeSlot(["11", "0", "0", "0"], new Set())).toBe(2);
    expect(firstFreeSlot(["11", "0", "0", "0"], new Set([2, 4]))).toBe(5);
    const full = ["18446744073709551615", "18446744073709551615", "18446744073709551615", "18446744073709551615"];
    expect(firstFreeSlot(full, new Set())).toBeNull();
  });
});

describe("what the phone may still sign", () => {
  it("is the cached available minus everything signed here and not seen settled", () => {
    const now = 2000n;
    expect(spendable(pouch(), [], now)).toBe(22_000_000n);
    expect(spendable(pouch(), [signed()], now)).toBe(17_000_000n);
    expect(spendable(pouch(), [signed(), signed({ hash: "b".repeat(64), slot: 4, settled: true })], now)).toBe(17_000_000n);
  });
  it("stops counting notes from older epochs and notes long past expiry", () => {
    const now = 1_000_000n;
    const list = [signed({ epoch: 0 }), signed({ expiry: "10" }), signed({ slot: 5 })];
    expect(outstanding(list, 1, now)).toHaveLength(1);
    expect(spendable(pouch(), list, now)).toBe(17_000_000n);
  });
  it("is never negative and is zero with no pouch", () => {
    expect(spendable(pouch({ available: "1" }), [signed()], 0n)).toBe(0n);
    expect(spendable(null, [], 0n)).toBe(0n);
  });
});

describe("note expiry", () => {
  it("is a week out, capped at the epoch's close", () => {
    const now = 10_000n;
    expect(noteExpiry(now, now)).toBe(now + 7n * 86_400n);
    const started = now - MAX_NOTE_LIFETIME_SECONDS + 86_400n; // closes in a day
    expect(noteExpiry(now, started)).toBe(started + MAX_NOTE_LIFETIME_SECONDS);
  });
  it("refuses to make a note that would be born dead", () => {
    expect(noteExpiry(10_000n, 10_000n - MAX_NOTE_LIFETIME_SECONDS + 60n)).toBeNull();
  });
});

describe("payout split (mirrors rules.rs)", () => {
  it("pays the recipient the rest and splits the fee evenly, keeping dust", () => {
    expect(splitPayout(1_000_000n, 200, 3)).toEqual({ relayFee: 20_000n, toRecipient: 980_000n, perRelayer: 6_666n, toRelayers: 19_998n, kept: 2n });
    expect(splitPayout(1_000_000n, 200, 0).kept).toBe(20_000n);
  });
});

describe("who took a slot", () => {
  it("tells this note's settlement from a double spend by the fingerprint", async () => {
    const { fingerprint, slotVerdict } = await import("./ledger");
    const hash = "0100000000000080" + "ff".repeat(24);
    expect(fingerprint(hash)).toBe(0x8000_0000_0000_0001n); // same vector as state.rs
    const fps = Array.from({ length: 256 }, () => "0");
    fps[3] = fingerprint(hash).toString();
    const p = { spent: ["8", "0", "0", "0"], fingerprints: fps };
    expect(slotVerdict(p, 2, hash)).toBe("open");
    expect(slotVerdict(p, 3, hash)).toBe("ours");
    expect(slotVerdict(p, 3, "02" + hash.slice(2))).toBe("other");
    expect(slotVerdict({ spent: p.spent }, 3, "02" + hash.slice(2))).toBe("ours");
  });
});

describe("cached pouch from disk", () => {
  it("accepts what it wrote and rejects anything malformed", () => {
    expect(parseCached(pouch())).not.toBeNull();
    expect(parseCached({ ...pouch(), spent: ["1"] })).toBeNull();
    expect(parseCached({ ...pouch(), available: "-1" })).toBeNull();
    expect(parseCached(null)).toBeNull();
  });
});

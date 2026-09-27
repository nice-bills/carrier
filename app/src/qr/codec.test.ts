import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { Deflate } from "pako";
import type { Signer } from "@carrier/mesh";
import { Pocket, memoryStore, nowSeconds } from "../pocket";
import { firstFreeSlot, type CachedPouch } from "../ledger";
import { noteKey } from "../chain";
import { MAX_PARTS, PART_CHARS, QrError, SlipReader, fromBase45, keyCode, readKey, readReceipt, receiptCode, slipCodes, toBase45 } from "./codec";

const signer = (kp: Keypair): Signer => ({ publicKey: kp.publicKey, sign: (m) => nacl.sign.detached(m, kp.secretKey) });

async function phone() {
  const kp = Keypair.generate();
  const { pocket } = await Pocket.open(signer(kp), memoryStore());
  return { key: kp.publicKey, pocket };
}

const pouchFor = (owner: Keypair["publicKey"]): CachedPouch => ({
  address: Keypair.generate().publicKey.toBase58(),
  owner: owner.toBase58(),
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  committed: "22000000",
  settled: "0",
  bond: "1000000",
  epoch: 3,
  epochStartedAt: (nowSeconds() - 86_400n).toString(),
  spent: ["0", "0", "0", "0"],
  available: "22000000",
  fetchedAt: Date.now(),
});

/** Everything a camera would read, in the order a flipping code shows it. */
function scanAll(reader: SlipReader, codes: string[]) {
  let last = null;
  for (const c of codes) last = reader.add(c);
  return last;
}

describe("base45", () => {
  it("round-trips every length and matches RFC 9285", () => {
    expect(toBase45(new TextEncoder().encode("AB"))).toBe("BB8");
    expect(toBase45(new TextEncoder().encode("Hello!!"))).toBe("%69 VD92EX0");
    for (let n = 0; n < 40; n++) {
      const b = nacl.randomBytes(n);
      expect(fromBase45(toBase45(b))).toEqual(b);
    }
  });

  it("refuses text that is not base45", () => {
    expect(() => fromBase45("a")).toThrow(QrError);
    expect(() => fromBase45("abc")).toThrow(QrError);
    expect(() => fromBase45("GGW")).toThrow(QrError); // 65535 < value
  });
});

describe("hand over by QR code", () => {
  it("carries a payment from one phone to another: key, slip, receipt", async () => {
    const ada = await phone();
    const bo = await phone(); // carries it
    const cy = await phone(); // is paid
    ada.pocket.observePouch(pouchFor(ada.key));
    const bundle = await ada.pocket.pay({ to: cy.key, amount: 5_000_000n, relayFeeBps: 200, pickSlot: (p, u) => firstFreeSlot(p.spent, u) });
    const hash = noteKey(bundle);

    // Bo shows his code; Ada scans it and shows the slip.
    const bosKey = readKey(keyCode(bo.key))!;
    expect(bosKey.equals(bo.key)).toBe(true);
    const codes = slipCodes(ada.key, ada.pocket.qrOffer(hash, bosKey));
    expect(codes.every((c) => c.length <= PART_CHARS + 16)).toBe(true);

    // Bo's camera catches the parts out of order, with repeats.
    const reader = new SlipReader();
    const got = scanAll(reader, [...codes].reverse().concat(codes));
    expect(got?.kind).toBe("done");
    if (got?.kind !== "done") return;
    expect(got.giver.equals(ada.key)).toBe(true);
    const { receipt } = await bo.pocket.qrTake(got.offer, got.giver);
    expect(bo.pocket.node.holds(hash)).toBe(true);

    // Ada scans Bo's receipt and lets it go.
    const r = readReceipt(receiptCode(hash, bo.key, receipt))!;
    expect(r.noteHash).toBe(hash);
    expect(ada.pocket.acknowledged(r.peer, r.noteHash, r.signature)).toBe(true);
    expect(ada.pocket.node.holds(hash)).toBe(false);
  });

  it("is only good to the key it was signed over to", async () => {
    const ada = await phone();
    const bo = await phone();
    const eve = await phone();
    const cy = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const bundle = await ada.pocket.pay({ to: cy.key, amount: 1_000_000n, relayFeeBps: 200, pickSlot: (p, u) => firstFreeSlot(p.spent, u) });
    const codes = slipCodes(ada.key, ada.pocket.qrOffer(noteKey(bundle), bo.key));
    const got = scanAll(new SlipReader(), codes);
    if (got?.kind !== "done") throw new Error("did not read");
    await expect(eve.pocket.qrTake(got.offer, got.giver)).rejects.toThrow();
    // A receipt signed by the wrong phone does not release it either.
    expect(ada.pocket.acknowledged(eve.key, noteKey(bundle), nacl.randomBytes(64))).toBe(false);
    expect(ada.pocket.node.holds(noteKey(bundle))).toBe(true);
  });

  it("ignores other codes and refuses oversized or broken slips", () => {
    const reader = new SlipReader();
    expect(reader.add("https://example.com")).toBeNull();
    expect(reader.add(`CS1/ABCD/1/${MAX_PARTS + 1}/00`)).toBeNull();
    expect(reader.add("CS1/ABCD/1/2/00")).toEqual({ kind: "progress", got: 1, total: 2 });
    // A part of another slip starts over.
    expect(reader.add("CS1/WXYZ/1/2/00")).toEqual({ kind: "progress", got: 1, total: 2 });
    // A bomb: 256 KB of zeros deflates to a few hundred bytes.
    const d = new Deflate({ level: 9 });
    d.push(new Uint8Array(256 * 1024), true);
    expect(() => new SlipReader().add(`CS1/BOMB/1/1/${toBase45(d.result as Uint8Array)}`)).toThrow(QrError);
    expect(() => new SlipReader().add(`CS1/JUNK/1/1/${toBase45(new TextEncoder().encode("not deflate"))}`)).toThrow(QrError);
    expect(readKey("CK1:not-a-key")).toBeNull();
    expect(readReceipt("CR1/123")).toBeNull();
  });
});

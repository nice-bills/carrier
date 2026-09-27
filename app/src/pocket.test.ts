import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Signer, Transport } from "@carrier/mesh";
import { Pocket, PayError, memoryStore, nowSeconds, type PocketStore } from "./pocket";
import { firstFreeSlot, type CachedPouch } from "./ledger";
import { noteKey } from "./chain";

/**
 * Pay -> hand over -> deliver, in Node. Each phone is a real Pocket; the radio
 * is replaced by a transport that calls the other phone's pocket directly,
 * which is exactly what `NearbyTransport` does after framing and auth.
 */

const signer = (kp: Keypair): Signer => ({
  publicKey: kp.publicKey,
  sign: (m) => nacl.sign.detached(m, kp.secretKey),
});

/** `client` reaching `server` over a perfect radio. */
const link = (server: Pocket, client: PublicKey): Transport => ({
  advertise: async () => {},
  peers: async () => [],
  digests: async () => server.digestsFor(client),
  request: async (_p, hash) => server.offerFor(hash, client),
  acknowledge: async (_p, hash, sig) => server.acknowledged(client, hash, sig),
  stop: async () => {},
});

async function phone(store: PocketStore = memoryStore()) {
  const kp = Keypair.generate();
  const { pocket } = await Pocket.open(signer(kp), store);
  return { kp, key: kp.publicKey, pocket, store };
}

const pouchFor = (owner: PublicKey, available = 22_000_000n): CachedPouch => ({
  address: Keypair.generate().publicKey.toBase58(),
  owner: owner.toBase58(),
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  committed: available.toString(),
  settled: "0",
  bond: "1000000",
  epoch: 3,
  epochStartedAt: (nowSeconds() - 86_400n).toString(),
  spent: ["1", "0", "0", "0"], // slot 0 settled already
  available: available.toString(),
  fetchedAt: Date.now(),
});

const pickSlot = (p: CachedPouch, used: ReadonlySet<number>) => firstFreeSlot(p.spent, used);

/** Hand `hash` from giver to taker the way the app does: intent, then the taker pulls it. */
async function handOver(giver: Awaited<ReturnType<typeof phone>>, taker: Awaited<ReturnType<typeof phone>>, hash: string) {
  giver.pocket.handTo(hash, taker.key);
  return taker.pocket.pull(link(giver.pocket, taker.key), giver.key, [hash]);
}

describe("pay, hand over, deliver", () => {
  it("delivers a payment straight to a recipient standing nearby", async () => {
    const ada = await phone();
    const bo = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));

    const bundle = await ada.pocket.pay({ to: bo.key, amount: 5_000_000n, relayFeeBps: 200, pickSlot });
    const hash = noteKey(bundle);
    expect(bundle.note.slotIndex).toBe(1); // 0 is settled on-chain
    expect(ada.pocket.spendable()).toBe(17_000_000n);

    const got = await handOver(ada, bo, hash);
    expect(got).toHaveLength(1);
    expect(bo.pocket.node.isForMe(hash)).toBe(true);
    // Ada's phone saw Bo's counter-signature and let go of it.
    expect(ada.pocket.node.holds(hash)).toBe(false);
    expect(ada.pocket.passed.map((p) => p.hash)).toEqual([hash]);
    expect(ada.pocket.feed[0]!.kind).toBe("delivered");
    expect(bo.pocket.feed.some((e) => e.kind === "paid-to-you")).toBe(true);
    // Both count the other toward rank.
    expect(ada.pocket.hasMet(bo.key) && bo.pocket.hasMet(ada.key)).toBe(true);
    // Still owed until it settles.
    expect(ada.pocket.spendable()).toBe(17_000_000n);
  });

  it("goes through a carrier who picks up a stamp on the way", async () => {
    const ada = await phone();
    const cy = await phone();
    const bo = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const bundle = await ada.pocket.pay({ to: bo.key, amount: 3_000_000n, relayFeeBps: 200, pickSlot });
    const hash = noteKey(bundle);

    await handOver(ada, cy, hash);
    expect(cy.pocket.node.bundle(hash)!.hops).toHaveLength(1);
    await handOver(cy, bo, hash);
    const delivered = bo.pocket.node.bundle(hash)!;
    expect(bo.pocket.node.isForMe(hash)).toBe(true);
    expect(delivered.hops.map((h) => h.relayer.toBase58())).toEqual([cy.key.toBase58()]);
    expect(cy.pocket.node.holds(hash)).toBe(false);
    expect(cy.pocket.passed[0]!.hop).toBe(0);
  });

  it("serves a note it signed only to the person it was handed to", async () => {
    const ada = await phone();
    const bo = await phone();
    const eve = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const hash = noteKey(await ada.pocket.pay({ to: bo.key, amount: 1_000_000n, relayFeeBps: 0, pickSlot }));

    expect(ada.pocket.digestsFor(eve.key)).toEqual([]);
    expect(await eve.pocket.pull(link(ada.pocket, eve.key), ada.key, [hash])).toHaveLength(0);
    expect(() => ada.pocket.offerFor(hash, eve.key)).toThrow();
    // Once handed to Bo, still not to Eve.
    ada.pocket.handTo(hash, bo.key);
    expect(ada.pocket.digestsFor(eve.key)).toEqual([]);
    expect(ada.pocket.digestsFor(bo.key)).toEqual([hash]);
  });

  it("lets anyone nearby take a note it is carrying for someone else", async () => {
    const ada = await phone();
    const cy = await phone();
    const dee = await phone();
    const bo = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const hash = noteKey(await ada.pocket.pay({ to: bo.key, amount: 1_000_000n, relayFeeBps: 100, pickSlot }));
    await handOver(ada, cy, hash);

    // Dee asks Cy what it could hand over, and takes it.
    const took = await dee.pocket.pull(link(cy.pocket, dee.key), cy.key);
    expect(took.map(noteKey)).toEqual([hash]);
    expect(dee.pocket.feed.find((e) => e.kind === "took")).toBeTruthy();
    expect(cy.pocket.node.holds(hash)).toBe(false);
  });

  it("does not offer back a note this phone already carried or signed", async () => {
    const ada = await phone();
    const cy = await phone();
    const dee = await phone();
    const bo = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const hash = noteKey(await ada.pocket.pay({ to: bo.key, amount: 1_000_000n, relayFeeBps: 100, pickSlot }));
    await handOver(ada, cy, hash);
    await handOver(cy, dee, hash);

    // Dee now holds it. Cy carried it and Ada signed it: neither could take it back.
    expect(dee.pocket.digestsFor(cy.key)).toEqual([hash]);
    expect(cy.pocket.couldTake(hash)).toBe(false);
    expect(ada.pocket.couldTake(hash)).toBe(false);
    expect(await cy.pocket.pull(link(dee.pocket, cy.key), dee.key)).toHaveLength(0);
    expect(dee.pocket.node.holds(hash)).toBe(true);
    expect(bo.pocket.couldTake(hash)).toBe(true);
  });

  it("never offers a payment addressed to this phone", async () => {
    const ada = await phone();
    const bo = await phone();
    const cy = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const hash = noteKey(await ada.pocket.pay({ to: bo.key, amount: 1_000_000n, relayFeeBps: 0, pickSlot }));
    await handOver(ada, bo, hash);
    expect(bo.pocket.digestsFor(cy.key)).toEqual([]);
    expect(() => bo.pocket.handTo(hash, cy.key)).toThrow(/settle it/);
  });
});

describe("slots are never reused", () => {
  it("writes the slot down before signing, and remembers it after a restart", async () => {
    const store = memoryStore();
    const ada = await phone(store);
    const cache = pouchFor(ada.key);
    ada.pocket.observePouch(cache);
    const bo = Keypair.generate().publicKey;
    const a = await ada.pocket.pay({ to: bo, amount: 1_000_000n, relayFeeBps: 0, pickSlot });
    const b = await ada.pocket.pay({ to: bo, amount: 1_000_000n, relayFeeBps: 0, pickSlot });
    expect([a.note.slotIndex, b.note.slotIndex]).toEqual([1, 2]);

    const again = await Pocket.open(signer(ada.kp), store);
    expect([...again.pocket.usedSlots()].sort()).toEqual([1, 2]);
    expect(again.pocket.spendable()).toBe(20_000_000n);
    // Both unsent notes came back too.
    expect(again.pocket.list()).toHaveLength(2);
    const c = await again.pocket.pay({ to: bo, amount: 1_000_000n, relayFeeBps: 0, pickSlot });
    expect(c.note.slotIndex).toBe(3);
  });

  it("remembers that the tips were turned off", async () => {
    const store = memoryStore();
    const ada = await phone(store);
    expect(ada.pocket.tipsOff).toBe(false);
    await ada.pocket.stopTips();
    const again = await Pocket.open(signer(ada.kp), store);
    expect(again.pocket.tipsOff).toBe(true);
  });

  it("signs nothing if the slot cannot be saved", async () => {
    let fail = false;
    const inner = memoryStore();
    const store: PocketStore = { read: inner.read, write: async (t) => { if (fail) throw new Error("disk full"); await inner.write(t); } };
    const ada = await phone(store);
    ada.pocket.observePouch(pouchFor(ada.key));
    await Promise.resolve();
    fail = true;
    await expect(ada.pocket.pay({ to: Keypair.generate().publicKey, amount: 1n, relayFeeBps: 0, pickSlot })).rejects.toBeInstanceOf(PayError);
    expect(ada.pocket.list()).toHaveLength(0);
    expect(ada.pocket.usedSlots().size).toBe(0);
    expect(ada.pocket.spendable()).toBe(22_000_000n);
  });

  it("refuses a slot the picker hands back twice", async () => {
    const ada = await phone();
    ada.pocket.observePouch(pouchFor(ada.key));
    const to = Keypair.generate().publicKey;
    await ada.pocket.pay({ to, amount: 1n, relayFeeBps: 0, pickSlot: () => 7 });
    await expect(ada.pocket.pay({ to, amount: 1n, relayFeeBps: 0, pickSlot: () => 7 })).rejects.toThrow(/slot/);
  });

  it("refuses to sign past what the pouch can cover offline", async () => {
    const ada = await phone();
    ada.pocket.observePouch(pouchFor(ada.key, 5_000_000n));
    const to = Keypair.generate().publicKey;
    await ada.pocket.pay({ to, amount: 4_000_000n, relayFeeBps: 0, pickSlot });
    await expect(ada.pocket.pay({ to, amount: 2_000_000n, relayFeeBps: 0, pickSlot })).rejects.toThrow(/more than your pouch/);
    // With no pouch at all, nothing can be signed.
    const bo = await phone();
    await expect(bo.pocket.pay({ to, amount: 1n, relayFeeBps: 0, pickSlot })).rejects.toThrow(/pouch/);
  });

  it("frees the allowance when the chain shows the slot settled", async () => {
    const ada = await phone();
    const cache = pouchFor(ada.key);
    ada.pocket.observePouch(cache);
    const b = await ada.pocket.pay({ to: Keypair.generate().publicKey, amount: 5_000_000n, relayFeeBps: 0, pickSlot });
    expect(ada.pocket.spendable()).toBe(17_000_000n);
    // Settled: available dropped by the payout and slot 1 is spent.
    const landed = ada.pocket.observePouch({ ...cache, available: "17000000", settled: "5000000", spent: ["3", "0", "0", "0"], fetchedAt: Date.now() + 1 });
    expect(landed.map((s) => s.hash)).toEqual([noteKey(b)]);
    expect(ada.pocket.spendable()).toBe(17_000_000n);
    // The slot stays used for the rest of the epoch.
    expect(ada.pocket.usedSlots().has(1)).toBe(true);
  });

  it("notices a note it carries settling elsewhere, or losing its slot to a double spend", async () => {
    const ada = await phone();
    const cy = await phone();
    const bo = await phone();
    const cache = pouchFor(ada.key);
    ada.pocket.observePouch(cache);
    const one = noteKey(await ada.pocket.pay({ to: bo.key, amount: 1_000_000n, relayFeeBps: 0, pickSlot }));
    const two = noteKey(await ada.pocket.pay({ to: bo.key, amount: 1_000_000n, relayFeeBps: 0, pickSlot }));
    await handOver(ada, cy, one);
    await handOver(ada, cy, two);
    expect(cy.pocket.list()).toHaveLength(2);
    // The chain says slot 1 went to `one`, and slot 2 to some other note.
    const n = cy.pocket.observeOther(cache.address, cache.epoch, (slot, hash) =>
      slot === 1 ? (hash === one ? "ours" : "other") : slot === 2 ? "other" : "open",
    );
    expect(n).toBe(2);
    expect(cy.pocket.list()).toHaveLength(0);
    expect(cy.pocket.feed[0]!.text).toMatch(/signed its slot twice/);
    expect(cy.pocket.feed[1]!.text).toMatch(/Someone else settled it/);
  });
});

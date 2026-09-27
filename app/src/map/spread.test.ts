import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Signer, Transport } from "@carrier/mesh";
import { Pocket, memoryStore, nowSeconds, type PocketStore } from "../pocket";
import { firstFreeSlot, type CachedPouch } from "../ledger";
import { noteKey } from "../chain";
import { parseMessage } from "../transport/messages";
import { roundCell, type Cell } from "./types";

/**
 * Trails riding along with real handoffs: pay, carry, deliver and settle
 * between real Pockets joined by function calls, with the map on or off on
 * each phone and a peer that sends junk where the trail goes.
 */

const signer = (kp: Keypair): Signer => ({
  publicKey: kp.publicKey,
  sign: (m) => nacl.sign.detached(m, kp.secretKey),
});

/** `client` reaching `server`; `tamper` rewrites the trail the server sends. */
const link = (server: Pocket, client: PublicKey, tamper?: (trail: unknown) => unknown): Transport => ({
  advertise: async () => {},
  peers: async () => [],
  digests: async () => server.digestsFor(client),
  request: async (_p, hash) => {
    const offer = server.offerFor(hash, client);
    return tamper ? { ...offer, trail: tamper(offer.trail) } : offer;
  },
  acknowledge: async (_p, hash, sig) => server.acknowledged(client, hash, sig),
  stop: async () => {},
});

async function phone(where: Cell | null, store: PocketStore = memoryStore()) {
  const kp = Keypair.generate();
  const { pocket } = await Pocket.open(signer(kp), store);
  if (where) {
    await pocket.setMapOn(true);
    pocket.setLocator(() => where);
  }
  return { kp, key: kp.publicKey, pocket, store };
}
type Phone = Awaited<ReturnType<typeof phone>>;

const pouchFor = (owner: PublicKey): CachedPouch => ({
  address: Keypair.generate().publicKey.toBase58(),
  owner: owner.toBase58(),
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  committed: "22000000",
  settled: "0",
  bond: "1000000",
  epoch: 3,
  epochStartedAt: (nowSeconds() - 86_400n).toString(),
  spent: ["1", "0", "0", "0"],
  available: "22000000",
  fetchedAt: Date.now(),
});

async function pay(from: Phone, to: PublicKey) {
  from.pocket.observePouch(pouchFor(from.key));
  const b = await from.pocket.pay({ to, amount: 1_000_000n, relayFeeBps: 200, pickSlot: (p, used) => firstFreeSlot(p.spent, used) });
  return noteKey(b);
}

function handOver(giver: Phone, taker: Phone, hash: string, tamper?: (trail: unknown) => unknown) {
  giver.pocket.handTo(hash, taker.key);
  return taker.pocket.pull(link(giver.pocket, taker.key, tamper), giver.key, [hash]);
}

const library = roundCell(6.5176, 3.3896);
const canteen = roundCell(6.5162, 3.3921);
const gate = roundCell(6.5191, 3.3935);

describe("trails travel with slips", () => {
  it("records where it was signed, carried and delivered, on every phone that held it", async () => {
    const ada = await phone(library);
    const bo = await phone(canteen);
    const cy = await phone(gate);
    const hash = await pay(ada, cy.key);
    expect(ada.pocket.trailFor(hash).map((p) => p.kind)).toEqual(["sent"]);

    await handOver(ada, bo, hash);
    // The giver adds the hop point (Ada was at the library when Bo took it).
    const hop0 = bo.pocket.trailFor(hash).find((p) => p.kind === "hop" && p.seq === 0)!;
    expect(hop0).toMatchObject({ who: bo.key.toBase58(), cell: library });
    // Ada keeps the route after the slip has left her pocket.
    expect(ada.pocket.node.holds(hash)).toBe(false);
    expect(ada.pocket.routes()[0]).toMatchObject({ id: hash, mine: true, settled: false });
    expect(ada.pocket.trailFor(hash)).toHaveLength(2);

    await handOver(bo, cy, hash);
    const trail = cy.pocket.trailFor(hash);
    expect(trail.map((p) => `${p.kind}${p.seq}`)).toEqual(["sent0", "hop0", "hop1"]);
    expect(trail[2]!.cell).toEqual(canteen);

    const bundle = cy.pocket.node.bundle(hash)!;
    cy.pocket.settledHere(bundle, ["sig"]);
    const route = cy.pocket.routes().find((r) => r.id === hash)!;
    expect(route.settled).toBe(true);
    expect(route.points.at(-1)).toMatchObject({ kind: "settled", seq: bundle.hops.length + 1, cell: gate });
  });

  it("lets the taker add the point when the giver has the map off", async () => {
    const ada = await phone(null);
    const bo = await phone(canteen);
    const hash = await pay(ada, Keypair.generate().publicKey);
    expect(ada.pocket.trailFor(hash)).toEqual([]);
    await handOver(ada, bo, hash);
    expect(bo.pocket.trailFor(hash)).toMatchObject([{ kind: "hop", seq: 0, who: bo.key.toBase58(), cell: canteen }]);
    // And Ada, map off, still added nothing of her own.
    expect(ada.pocket.routes()).toEqual([]);
  });

  it("carries a trail through a phone with the map off without adding to it", async () => {
    const ada = await phone(library);
    const bo = await phone(null);
    const cy = await phone(null);
    const hash = await pay(ada, Keypair.generate().publicKey);
    await handOver(ada, bo, hash);
    await handOver(bo, cy, hash);
    expect(cy.pocket.trailFor(hash).map((p) => `${p.kind}${p.seq}`)).toEqual(["sent0", "hop0"]);
  });

  it("stores only rounded cells, even from a locator that hands back a raw fix", async () => {
    const ada = await phone({ lat: 6.517123456, lon: 3.390987654 });
    const hash = await pay(ada, Keypair.generate().publicKey);
    expect(ada.pocket.trailFor(hash)[0]!.cell).toEqual(roundCell(6.517123456, 3.390987654));
  });

  it("still completes a handoff when the trail is garbage", async () => {
    const junk: unknown[] = [
      "not a trail",
      { seq: 0 },
      [{ seq: "x" }, null, 7],
      Array.from({ length: 5000 }, () => ({ seq: 0, kind: "hop", who: "x", at: 1, cell: { lat: 999, lon: 0 } })),
      [{ seq: 0, kind: "sent", who: Keypair.generate().publicKey.toBase58(), at: 1, cell: { lat: Infinity, lon: 0 } }],
    ];
    for (const trail of junk) {
      const ada = await phone(library);
      const bo = await phone(null);
      const hash = await pay(ada, Keypair.generate().publicKey);
      const got = await handOver(ada, bo, hash, () => trail);
      expect(got).toHaveLength(1);
      expect(bo.pocket.node.holds(hash)).toBe(true);
      expect(ada.pocket.node.holds(hash)).toBe(false);
      expect(bo.pocket.trailFor(hash)).toEqual([]);
    }
  });

  it("keeps the map setting and the routes across a restart", async () => {
    const store = memoryStore();
    const ada = await phone(library, store);
    const hash = await pay(ada, Keypair.generate().publicKey);
    const { pocket } = await Pocket.open(signer(ada.kp), store);
    expect(pocket.mapOn).toBe(true);
    expect(pocket.trailFor(hash)).toEqual(ada.pocket.trailFor(hash));
    await pocket.setMapOn(false);
    expect((await Pocket.open(signer(ada.kp), store)).pocket.mapOn).toBe(false);
  });
});

describe("the offer message", () => {
  const h = "ab".repeat(8);
  it("passes a trail through to be checked, and ignores one that is not a list", () => {
    expect(parseMessage({ kind: "offer", id: h, body: {}, trail: [{ seq: 0 }] })).toEqual({ kind: "offer", id: h, body: {}, trail: [{ seq: 0 }] });
    expect(parseMessage({ kind: "offer", id: h, body: {}, trail: "junk" })).toEqual({ kind: "offer", id: h, body: {} });
  });
});

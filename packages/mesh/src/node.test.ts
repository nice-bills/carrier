import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  MAX_CHAIN,
  MAX_NOTE_LIFETIME_SECONDS,
  hopSigningPayload,
  hashNote,
  type Hop,
  type Note,
} from "@carrier/protocol";
import { CarrierNode, contact, type NodeLimits } from "./node.js";
import { MeshError, type Signer } from "./types.js";

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

class TestSigner implements Signer {
  readonly keypair = Keypair.generate();
  get publicKey() {
    return this.keypair.publicKey;
  }
  sign(message: Uint8Array) {
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
}

const NOW = 1_800_000_000n;
const POUCH = new PublicKey("11111111111111111111111111111112");
const RECIPIENT = new PublicKey("11111111111111111111111111111113");

function note(overrides: Partial<Note> = {}): Note {
  return {
    pouch: POUCH,
    to: RECIPIENT,
    amount: 5_000_000n,
    slotIndex: 3,
    epoch: 0,
    expiry: NOW + 86_400n,
    relayFeeBps: 200,
    ...overrides,
  };
}

/**
 * Each test node's signer, so tests can forge signatures deliberately. Kept
 * beside the node rather than read out of its private field.
 */
const signers = new WeakMap<CarrierNode, TestSigner>();
const signerOf = (node: CarrierNode): TestSigner => signers.get(node)!;

function device(limits: Partial<NodeLimits> = {}) {
  const signer = new TestSigner();
  const node = new CarrierNode(signer, limits);
  signers.set(node, signer);
  return node;
}

describe("carrier node", () => {
  it("carries a payment between people who are not party to it", () => {
    const sender = device();
    const strangerA = device();
    const strangerB = device();

    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));

    // Two encounters, neither involving the recipient.
    contact(sender, strangerA, NOW);
    contact(strangerA, strangerB, NOW + 60n);

    expect(strangerB.holds(digest)).toBe(true);

    const carried = strangerB.bundle(digest)!;
    expect(carried.hops).toHaveLength(2);
    // Lineage reads sender → A → B, which is what settlement pays out against.
    expect(carried.hops[0]!.prev.equals(sender.publicKey)).toBe(true);
    expect(carried.hops[0]!.relayer.equals(strangerA.publicKey)).toBe(true);
    expect(carried.hops[1]!.prev.equals(strangerA.publicKey)).toBe(true);
    expect(carried.hops[1]!.relayer.equals(strangerB.publicKey)).toBe(true);

    // One note signature plus two co-signatures per hop.
    expect(carried.entries).toHaveLength(1 + 2 * 2);
  });

  it("spreads through a crowd that never meets the sender twice", () => {
    const sender = device();
    const crowd = Array.from({ length: 6 }, device);

    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));

    // The sender hands off once and goes home. Everything after is strangers
    // meeting strangers — the property that makes this a mesh and not a relay.
    contact(sender, crowd[0]!, NOW);
    for (let i = 0; i < crowd.length - 1; i += 1) {
      contact(crowd[i]!, crowd[i + 1]!, NOW + BigInt(i + 1));
    }

    // Six hops is past what one transaction can verify but well inside what the
    // draft can, so the chain keeps going. Before the accumulator existed this
    // was capped at two and the mesh was barely a mesh.
    expect(crowd.every((d) => d.holds(digest))).toBe(true);
    expect(crowd[5]!.bundle(digest)!.hops).toHaveLength(6);
  });

  it("refuses a hop chain the giver did not actually co-sign", () => {
    const sender = device();
    const forger = device();

    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));

    // The forger claims a handoff that never happened. The chain itself is
    // well-formed — `prev` names the real previous carrier — so the only thing
    // standing between the forger and a relay fee is the giver's signature.
    const hop = {
      noteHash: hashNote(bundle.note),
      relayer: forger.publicKey,
      prev: sender.publicKey,
      seq: 0,
      at: NOW,
    };
    // A real, valid ed25519 signature — just by the wrong key. This is the
    // attack: without the giver's own key the hop is unprovable, so a carrier
    // cannot invent a predecessor to inflate its share of the relay fee.
    const forged = {
      bundle,
      hop,
      giverSignature: signerOf(forger).sign(hopSigningPayload(hop)),
    };

    expect(() => forger.acceptHandoff(forged, NOW)).toThrow(
      /co-signature does not verify/,
    );
    expect(forger.carrying).toBe(0);
    expect(sender.holds(digest)).toBe(true);
  });

  it("refuses a hop that does not follow the carrier it names", () => {
    const sender = device();
    const outsider = device();
    const taker = device();

    const bundle = sender.originate(note());

    // `prev` names someone who never held this note. Caught before any
    // signature work, which keeps the cheap check on the hot path — a device in
    // a crowd evaluates every offer it hears.
    const hop = {
      noteHash: hashNote(bundle.note),
      relayer: taker.publicKey,
      prev: outsider.publicKey,
      seq: 0,
      at: NOW,
    };

    expect(() =>
      taker.acceptHandoff(
        { bundle, hop, giverSignature: signerOf(outsider).sign(hopSigningPayload(hop)) },
        NOW,
      ),
    ).toThrow(/chain is broken/);
    expect(taker.carrying).toBe(0);
  });

  it("will not extend a chain past what settlement can verify", () => {
    const sender = device();
    const chain = Array.from({ length: MAX_CHAIN + 2 }, device);

    sender.originate(note());
    contact(sender, chain[0]!, NOW);
    for (let i = 0; i < chain.length - 1; i += 1) {
      contact(chain[i]!, chain[i + 1]!, NOW + BigInt(i + 1));
    }

    // Everyone up to the limit is carrying it; nobody past the limit is, because
    // a longer chain would exceed what one settlement instruction can verify.
    const carriers = chain.filter((d) => d.carrying > 0);
    expect(carriers).toHaveLength(MAX_CHAIN);
  });

  it("does not take on a note that can no longer settle", () => {
    const sender = device();
    const stranger = device();

    sender.originate(note({ expiry: NOW - 1n }));
    contact(sender, stranger, NOW);

    expect(stranger.carrying).toBe(0);
  });

  it("drops expired notes rather than carrying dead weight", () => {
    const sender = device();
    sender.originate(note({ slotIndex: 1, expiry: NOW + 10n }));
    sender.originate(note({ slotIndex: 2, expiry: NOW + 10_000n }));

    expect(sender.prune(NOW + 100n)).toBe(1);
    expect(sender.carrying).toBe(1);
  });

  it("never takes the same note twice", () => {
    const sender = device();
    const stranger = device();
    sender.originate(note());

    expect(contact(sender, stranger, NOW)).toBe(1);
    // A second encounter with the same person moves nothing.
    expect(contact(sender, stranger, NOW + 5n)).toBe(0);
    expect(stranger.carrying).toBe(1);
  });
});

/** Build a handoff offer by hand, signed by whichever key the test chooses. */
function offerFrom(
  giver: CarrierNode,
  digest: string,
  relayer: PublicKey,
  overrides: Partial<Hop> = {},
) {
  const bundle = giver.bundle(digest)!;
  const hop: Hop = {
    noteHash: hashNote(bundle.note),
    relayer,
    prev: bundle.hops.length === 0 ? bundle.owner : bundle.hops[bundle.hops.length - 1]!.relayer,
    seq: bundle.hops.length,
    at: NOW,
    ...overrides,
  };
  return { bundle, hop, giverSignature: signerOf(giver).sign(hopSigningPayload(hop)) };
}

describe("verifying the whole chain on receipt", () => {
  it("refuses a bundle whose earlier hop was fabricated, and still takes the genuine one", () => {
    const sender = device();
    const a = device();
    const b = device();
    const victim = device();

    const digest = hex(hashNote(sender.originate(note()).note));
    contact(sender, a, NOW);
    contact(a, b, NOW + 1n);
    const genuine = b.bundle(digest)!;

    // Someone holding the genuine bundle swaps the first hop's relayer
    // co-signature for zeros, then offers it on as though it were the tip.
    const forgedEntries = genuine.entries.map((e, i) =>
      i === 1 ? { ...e, signature: new Uint8Array(64) } : e,
    );
    const forgedBundle = { ...genuine, entries: forgedEntries };
    const hop: Hop = {
      noteHash: hashNote(genuine.note),
      relayer: victim.publicKey,
      prev: b.publicKey,
      seq: 2,
      at: NOW + 2n,
    };
    const forged = {
      bundle: forgedBundle,
      hop,
      giverSignature: signerOf(b).sign(hopSigningPayload(hop)),
    };

    expect(() => victim.acceptHandoff(forged, NOW + 2n)).toThrow(
      /hop 0 relayer signature does not verify/,
    );
    expect(victim.holds(digest)).toBe(false);

    // The forged bundle did not occupy the slot: the real one still gets in.
    const carried = victim.acceptHandoff(b.prepareHandoff(digest, victim.publicKey, NOW + 2n), NOW + 2n);
    expect(carried.hops).toHaveLength(3);
  });

  it("refuses a bundle with an earlier hop whose links were rewritten", () => {
    const sender = device();
    const a = device();
    const b = device();
    const taker = device();

    const digest = hex(hashNote(sender.originate(note()).note));
    contact(sender, a, NOW);
    contact(a, b, NOW + 1n);
    const genuine = b.bundle(digest)!;

    const tampered = {
      ...genuine,
      hops: genuine.hops.map((h, i) => (i === 0 ? { ...h, seq: 5 } : h)),
    };
    const hop: Hop = {
      noteHash: hashNote(genuine.note),
      relayer: taker.publicKey,
      prev: b.publicKey,
      seq: 2,
      at: NOW,
    };
    expect(() =>
      taker.acceptHandoff(
        { bundle: tampered, hop, giverSignature: signerOf(b).sign(hopSigningPayload(hop)) },
        NOW,
      ),
    ).toThrow(/hop 0 has sequence 5/);
  });

  it("refuses a bundle with missing or extra signature entries", () => {
    const sender = device();
    const a = device();
    const taker = device();

    const digest = hex(hashNote(sender.originate(note()).note));
    contact(sender, a, NOW);
    const offer = a.prepareHandoff(digest, taker.publicKey, NOW);

    const short = { ...offer, bundle: { ...offer.bundle, entries: offer.bundle.entries.slice(0, 2) } };
    expect(() => taker.acceptHandoff(short, NOW)).toThrow(/signatures/);

    const padded = {
      ...offer,
      bundle: { ...offer.bundle, entries: [...offer.bundle.entries, offer.bundle.entries[0]!] },
    };
    expect(() => taker.acceptHandoff(padded, NOW)).toThrow(/signatures/);
    expect(taker.carrying).toBe(0);
  });

  it("turns junk offers into MeshError rather than crashing", () => {
    const taker = device();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "offer",
      {},
      { bundle: null },
      { bundle: { owner: "not a key", note: {}, hops: [], entries: [] } },
    ];
    for (const offer of junk) {
      expect(() => taker.acceptHandoff(offer as never, NOW)).toThrow(MeshError);
    }

    const sender = device();
    const digest = hex(hashNote(sender.originate(note()).note));
    const good = sender.prepareHandoff(digest, taker.publicKey, NOW);
    expect(() =>
      taker.acceptHandoff({ ...good, giverSignature: new Uint8Array(3) }, NOW),
    ).toThrow(MeshError);
    expect(() =>
      taker.acceptHandoff({ ...good, bundle: { ...good.bundle, hops: "x" as never } }, NOW),
    ).toThrow(MeshError);
    expect(taker.carrying).toBe(0);
  });
});

describe("range and lifetime checks", () => {
  it("refuses a note whose expiry was wrapped past 2^64", () => {
    const sender = device();
    const taker = device();
    const digest = hex(hashNote(sender.originate(note({ expiry: NOW - 10n })).note));
    const offer = sender.prepareHandoff(digest, taker.publicKey, NOW);

    // Same bytes mod 2^64, so without range checks the signature still verifies.
    const wrapped = {
      ...offer,
      bundle: {
        ...offer.bundle,
        note: { ...offer.bundle.note, expiry: offer.bundle.note.expiry + (1n << 64n) },
      },
    };
    expect(() => taker.acceptHandoff(wrapped, NOW)).toThrow(MeshError);
    expect(taker.carrying).toBe(0);
  });

  it("refuses a note that claims to live longer than any note can", () => {
    const sender = device();
    const taker = device();
    sender.originate(note({ expiry: NOW + MAX_NOTE_LIFETIME_SECONDS + 1n }));
    expect(contact(sender, taker, NOW)).toBe(0);

    sender.originate(note({ slotIndex: 9, expiry: NOW + MAX_NOTE_LIFETIME_SECONDS }));
    expect(contact(sender, taker, NOW)).toBe(1);
  });

  it("refuses a hop stamped far in the future or before any live note began", () => {
    const sender = device();
    const taker = device();
    const digest = hex(hashNote(sender.originate(note()).note));

    const future = offerFrom(sender, digest, taker.publicKey, { at: NOW + 2n * 86_400n });
    expect(() => taker.acceptHandoff(future, NOW)).toThrow(/implausible timestamp/);

    const ancient = offerFrom(sender, digest, taker.publicKey, {
      at: NOW - MAX_NOTE_LIFETIME_SECONDS - 1n,
    });
    expect(() => taker.acceptHandoff(ancient, NOW)).toThrow(/implausible timestamp/);

    // A few hours of skew is fine.
    const skewed = offerFrom(sender, digest, taker.publicKey, { at: NOW + 3_600n });
    expect(taker.acceptHandoff(skewed, NOW).hops).toHaveLength(1);
  });

  it("refuses a bundle already at the chain limit before doing signature work", () => {
    const sender = device();
    const taker = device();
    const digest = hex(hashNote(sender.originate(note()).note));
    const offer = sender.prepareHandoff(digest, taker.publicKey, NOW);
    const fakeHop = offer.hop;
    const full = {
      ...offer,
      bundle: { ...offer.bundle, hops: Array.from({ length: MAX_CHAIN }, () => fakeHop) },
      hop: { ...offer.hop, seq: MAX_CHAIN },
    };
    expect(() => taker.acceptHandoff(full, NOW)).toThrow(/chain is already at/);
  });
});

describe("holding caps", () => {
  it("evicts the soonest-expiring note when full, and refuses one that expires sooner still", () => {
    const taker = device({ maxHeld: 2, maxPerOwner: 10 });
    const senders = [device(), device(), device(), device()];
    const expiries = [NOW + 100n, NOW + 300n, NOW + 200n, NOW + 50n];
    const digests = senders.map((s, i) =>
      hex(hashNote(s.originate(note({ expiry: expiries[i]! })).note)),
    );

    contact(senders[0]!, taker, NOW);
    contact(senders[1]!, taker, NOW);
    expect(taker.carrying).toBe(2);

    // Full: a note expiring at +200 displaces the one expiring at +100.
    contact(senders[2]!, taker, NOW);
    expect(taker.carrying).toBe(2);
    expect(taker.holds(digests[0]!)).toBe(false);
    expect(taker.holds(digests[2]!)).toBe(true);

    // A note expiring sooner than everything held is the one refused.
    contact(senders[3]!, taker, NOW);
    expect(taker.holds(digests[3]!)).toBe(false);
    expect(taker.carrying).toBe(2);
  });

  it("never evicts the device's own notes", () => {
    const me = device({ maxHeld: 1 });
    const mine = hex(hashNote(me.originate(note({ slotIndex: 1, expiry: NOW + 10n })).note));
    const other = device();
    other.originate(note({ expiry: NOW + 1_000n }));
    contact(other, me, NOW);
    expect(me.holds(mine)).toBe(true);
    expect(me.carrying).toBe(2);
  });

  it("caps how many notes one sender can park on a device", () => {
    const taker = device({ maxPerOwner: 2 });
    const sender = device();
    for (let slot = 0; slot < 5; slot += 1) sender.originate(note({ slotIndex: slot }));
    contact(sender, taker, NOW);
    expect(taker.carrying).toBe(2);
  });
});

describe("the program's carrier rules", () => {
  it("will not name the sender as a carrier of their own note", () => {
    const sender = device();
    const a = device();
    const digest = hex(hashNote(sender.originate(note()).note));
    contact(sender, a, NOW);

    // Handing it back to the sender builds a hop the program refuses to pay.
    expect(() => a.prepareHandoff(digest, sender.publicKey, NOW)).toThrow(/sender/);
    sender.release(digest);
    expect(() =>
      sender.acceptHandoff(offerFrom(a, digest, sender.publicKey), NOW),
    ).toThrow(/sender cannot carry/);
  });

  it("will not let a device carry the same note twice", () => {
    const sender = device();
    const a = device();
    const b = device();
    const digest = hex(hashNote(sender.originate(note()).note));
    contact(sender, a, NOW);
    contact(a, b, NOW);
    a.release(digest);

    expect(() => b.prepareHandoff(digest, a.publicKey, NOW)).toThrow(/already carried/);
    expect(() => a.acceptHandoff(offerFrom(b, digest, a.publicKey), NOW)).toThrow(
      /already carried/,
    );
    expect(contact(a, b, NOW)).toBe(0);
  });

  it("delivers to the recipient without adding a hop, and the recipient does not pass it on", () => {
    const sender = device();
    const a = device();
    const recipient = device();
    const stranger = device();

    const digest = hex(
      hashNote(sender.originate(note({ to: recipient.publicKey })).note),
    );
    contact(sender, a, NOW);
    expect(contact(a, recipient, NOW + 1n)).toBe(1);

    expect(recipient.holds(digest)).toBe(true);
    expect(recipient.isForMe(digest)).toBe(true);
    expect(recipient.deliveries()).toEqual([digest]);
    // The chain is exactly what it was: a hop naming the recipient is unpayable.
    const kept = recipient.bundle(digest)!;
    expect(kept.hops).toHaveLength(1);
    expect(kept.entries).toHaveLength(3);

    // It is not offered on, and cannot be handed on.
    expect(recipient.digests()).not.toContain(digest);
    expect(contact(recipient, stranger, NOW + 2n)).toBe(0);
    expect(() => recipient.prepareHandoff(digest, stranger.publicKey, NOW)).toThrow(/settles/);
  });

  it("refuses a bundle with an earlier hop naming the recipient as carrier", () => {
    const sender = device();
    const recipient = device();
    const taker = device();

    const digest = hex(hashNote(sender.originate(note({ to: recipient.publicKey })).note));
    // Hand-build a hop that pays the recipient as a carrier, fully signed.
    const offer0 = offerFrom(sender, digest, recipient.publicKey);
    const hop0 = offer0.hop;
    const payload0 = hopSigningPayload(hop0);
    const bundle = {
      ...offer0.bundle,
      hops: [hop0],
      entries: [
        ...offer0.bundle.entries,
        { publicKey: recipient.publicKey, signature: signerOf(recipient).sign(payload0), message: payload0 },
        { publicKey: sender.publicKey, signature: offer0.giverSignature, message: payload0 },
      ],
    };
    const hop1: Hop = {
      noteHash: hashNote(bundle.note),
      relayer: taker.publicKey,
      prev: recipient.publicKey,
      seq: 1,
      at: NOW,
    };
    expect(() =>
      taker.acceptHandoff(
        { bundle, hop: hop1, giverSignature: signerOf(recipient).sign(hopSigningPayload(hop1)) },
        NOW,
      ),
    ).toThrow(/sender or recipient as a carrier/);
  });
});

describe("restoring after a restart", () => {
  it("takes back a carried bundle and refuses one this device never held", () => {
    const sender = device();
    const carrier = device();
    const bystander = device();
    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));
    contact(sender, carrier, NOW);
    const carried = carrier.bundle(digest)!;

    const restarted = new CarrierNode(signerOf(carrier));
    restarted.restore(carried, NOW + 10n);
    expect(restarted.holds(digest)).toBe(true);
    expect(restarted.digests()).toContain(digest);

    expect(() => new CarrierNode(signerOf(bystander)).restore(carried, NOW + 10n)).toThrow(MeshError);
  });

  it("re-verifies saved bundles rather than trusting storage", () => {
    const sender = device();
    const carrier = device();
    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));
    contact(sender, carrier, NOW);
    const carried = carrier.bundle(digest)!;
    const tampered = {
      ...carried,
      entries: carried.entries.map((e, i) =>
        i === 1 ? { ...e, signature: new Uint8Array(64) } : e,
      ),
    };
    expect(() => new CarrierNode(signerOf(carrier)).restore(tampered, NOW + 10n)).toThrow(MeshError);
  });
});

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { MAX_CHAIN, hopSigningPayload, hashNote, type Note } from "@carrier/protocol";
import { CarrierNode, contact } from "./node.js";
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

/** Returns the node and its signer, so tests can forge signatures deliberately. */
function device() {
  const signer = new TestSigner();
  const node = new CarrierNode(signer) as CarrierNode & { signer: TestSigner };
  Object.defineProperty(node, "signer", { value: signer, enumerable: false });
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
      giverSignature: forger.signer.sign(hopSigningPayload(hop)),
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
        { bundle, hop, giverSignature: outsider.signer.sign(hopSigningPayload(hop)) },
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

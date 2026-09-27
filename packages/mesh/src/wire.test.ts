import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { hashNote, type Note } from "@carrier/protocol";
import { CarrierNode } from "./node.js";
import { encodeOffer, decodeOffer, tryDecodeOffer } from "./wire.js";
import { MeshError } from "./types.js";
import type { Signer } from "./types.js";

/**
 * A handoff survives the wire unchanged.
 *
 * This is worth testing precisely because the failures are silent. `bigint`
 * throws on `JSON.stringify`, and `Uint8Array` does not — it becomes an object
 * of numeric keys that parses back into something shaped like an array and
 * verifies as nothing. A signature mangled that way produces
 * `SignatureNotVerified` at settlement, hours later, on someone else's phone.
 */

class TestSigner implements Signer {
  readonly keypair = Keypair.generate();
  get publicKey() {
    return this.keypair.publicKey;
  }
  sign(m: Uint8Array) {
    return nacl.sign.detached(m, this.keypair.secretKey);
  }
}

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const NOW = 1_800_000_000n;

function note(): Note {
  return {
    pouch: new PublicKey("11111111111111111111111111111112"),
    to: new PublicKey("11111111111111111111111111111113"),
    amount: 12_345_678_901n,
    slotIndex: 42,
    epoch: 7,
    expiry: NOW + 86_400n,
    relayFeeBps: 250,
  };
}

describe("wire format", () => {
  it("round-trips a handoff through JSON without losing anything", () => {
    const sender = new CarrierNode(new TestSigner());
    const taker = new TestSigner();

    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));
    const offer = sender.prepareHandoff(digest, taker.publicKey, NOW);

    // Actually through a string, not just the object — that is where bigint and
    // Uint8Array break.
    const revived = decodeOffer(JSON.parse(JSON.stringify(encodeOffer(offer))));

    expect(revived.bundle.owner.equals(offer.bundle.owner)).toBe(true);
    expect(revived.bundle.note.amount).toBe(offer.bundle.note.amount);
    expect(typeof revived.bundle.note.amount).toBe("bigint");
    expect(revived.bundle.note.expiry).toBe(offer.bundle.note.expiry);
    expect(revived.bundle.note.slotIndex).toBe(42);
    expect(revived.hop.at).toBe(offer.hop.at);
    expect(hex(revived.hop.noteHash)).toBe(hex(offer.hop.noteHash));
    expect(hex(revived.giverSignature)).toBe(hex(offer.giverSignature));
    expect(revived.giverSignature).toBeInstanceOf(Uint8Array);
    expect(revived.giverSignature).toHaveLength(64);
  });

  it("keeps signatures verifiable after the round trip", () => {
    const sender = new CarrierNode(new TestSigner());
    const taker = new CarrierNode(new TestSigner());

    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));
    const offer = sender.prepareHandoff(digest, taker.publicKey, NOW);

    const revived = decodeOffer(JSON.parse(JSON.stringify(encodeOffer(offer))));

    // The real proof: the receiving node accepts what came off the wire. If any
    // byte shifted, this throws.
    const carried = taker.acceptHandoff(revived, NOW);
    expect(carried.hops).toHaveLength(1);
    expect(taker.holds(digest)).toBe(true);
  });

  it("survives a chain that already has hops on it", () => {
    const sender = new CarrierNode(new TestSigner());
    const first = new CarrierNode(new TestSigner());
    const second = new CarrierNode(new TestSigner());

    const bundle = sender.originate(note());
    const digest = hex(hashNote(bundle.note));

    first.acceptHandoff(
      sender.prepareHandoff(digest, first.publicKey, NOW),
      NOW,
    );

    const onward = decodeOffer(
      JSON.parse(
        JSON.stringify(encodeOffer(first.prepareHandoff(digest, second.publicKey, NOW + 1n))),
      ),
    );

    const carried = second.acceptHandoff(onward, NOW + 1n);
    expect(carried.hops).toHaveLength(2);
    // Three signatures survived: the note, plus two per hop.
    expect(carried.entries).toHaveLength(1 + 2 * 2);
  });
});

describe("decoding untrusted offers", () => {
  function wire() {
    const sender = new CarrierNode(new TestSigner());
    const taker = new TestSigner();
    const bundle = sender.originate(note());
    return JSON.parse(
      JSON.stringify(encodeOffer(sender.prepareHandoff(hex(hashNote(bundle.note)), taker.publicKey, NOW))),
    );
  }

  it("rejects out-of-range numbers instead of wrapping them", () => {
    const cases: [string, (w: any) => void][] = [
      ["slot 256", (w) => (w.note.slotIndex = 256)],
      ["slot fractional", (w) => (w.note.slotIndex = 1.5)],
      ["slot as string", (w) => (w.note.slotIndex = "1")],
      ["negative epoch", (w) => (w.note.epoch = -1)],
      ["fee above u16", (w) => (w.note.relayFeeBps = 70_000)],
      ["amount above u64", (w) => (w.note.amount = (1n << 64n).toString())],
      ["negative amount", (w) => (w.note.amount = "-5")],
      ["amount not an integer", (w) => (w.note.amount = "1e9")],
      ["expiry wrapped", (w) => (w.note.expiry = (NOW + (1n << 64n)).toString())],
      ["hop seq NaN", (w) => (w.hop.seq = null)],
      ["hop at not a number", (w) => (w.hop.at = "soon")],
    ];
    for (const [name, mutate] of cases) {
      const w = wire();
      mutate(w);
      expect(() => decodeOffer(w), name).toThrow(MeshError);
      expect(tryDecodeOffer(w), name).toBeNull();
    }
  });

  it("rejects wrong-length bytes, bad keys and oversized arrays", () => {
    const cases: [string, (w: any) => void][] = [
      ["short signature", (w) => (w.giverSignature = btoa("abc"))],
      ["not base64", (w) => (w.giverSignature = "!!!")],
      ["bad owner key", (w) => (w.owner = "not-a-key")],
      ["huge owner string", (w) => (w.owner = "1".repeat(10_000))],
      ["hops not an array", (w) => (w.hops = {})],
      ["too many hops", (w) => (w.hops = Array.from({ length: 100 }, () => w.hop))],
      ["too many entries", (w) => (w.entries = Array.from({ length: 100 }, () => w.entries[0]))],
      ["entry message not a digest", (w) => (w.entries[0].message = btoa("x"))],
    ];
    for (const [name, mutate] of cases) {
      const w = wire();
      mutate(w);
      expect(() => decodeOffer(w), name).toThrow(MeshError);
    }
  });

  it("never throws anything but MeshError on junk", () => {
    for (const junk of [null, undefined, 0, "x", [], {}, { note: null }, { owner: 5, note: {} }]) {
      expect(() => decodeOffer(junk)).toThrow(MeshError);
      expect(tryDecodeOffer(junk)).toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

import { encodeHop, encodeNote, hashNote, type Hop, type Note } from "./codec.js";
import { createEd25519Instruction } from "./ed25519.js";

const POUCH = new PublicKey("11111111111111111111111111111112");
const TO = new PublicKey("11111111111111111111111111111113");

const NOTE: Note = {
  pouch: POUCH,
  to: TO,
  amount: 1_500_000n,
  slotIndex: 7,
  epoch: 3,
  expiry: 1_800_000_000n,
  relayFeeBps: 250,
};

describe("note encoding", () => {
  it("matches the byte layout the program expects", () => {
    const encoded = encodeNote(NOTE);

    // domain(15) + pouch(32) + to(32) + amount(8) + slot(1) + epoch(4)
    //   + expiry(8) + relayFeeBps(2)
    expect(encoded.length).toBe(102);

    expect(new TextDecoder().decode(encoded.slice(0, 15))).toBe("carrier:note:v1");
    expect(new PublicKey(encoded.slice(15, 47)).equals(POUCH)).toBe(true);
    expect(new PublicKey(encoded.slice(47, 79)).equals(TO)).toBe(true);

    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(view.getBigUint64(79, true)).toBe(1_500_000n);
    expect(encoded[87]).toBe(7);
    expect(view.getUint32(88, true)).toBe(3);
    expect(view.getBigInt64(92, true)).toBe(1_800_000_000n);
    expect(view.getUint16(100, true)).toBe(250);
  });

  it("hashes identically to the Rust program", () => {
    // Same fixture and same expected digest as the `note_encoding_matches_the_
    // typescript_client` test in programs/carrier/src/state.rs.
    //
    // This is the one assertion that catches wire drift between the phone that
    // signs a note offline and the program that verifies it. Without it a
    // mismatch only ever surfaces as an opaque SignatureNotVerified at
    // settlement, long after the handoff happened.
    const hex = Buffer.from(hashNote(NOTE)).toString("hex");
    expect(hex).toBe(
      "ddc5fb01f265fd171be3e351c2daf58b6b75b33da54ef944b3d9e009a1268017",
    );
  });

  it("changes the hash when any field changes", () => {
    const base = hashNote(NOTE);
    expect(base.length).toBe(32);
    expect(hashNote({ ...NOTE, slotIndex: 8 })).not.toEqual(base);
    expect(hashNote({ ...NOTE, amount: 1_500_001n })).not.toEqual(base);
  });

  it("is domain-separated from hops", () => {
    const hop: Hop = {
      noteHash: hashNote(NOTE),
      relayer: POUCH,
      prev: TO,
      seq: 0,
      at: 1_700_000_000n,
    };
    const encoded = encodeHop(hop);

    // domain(14) + noteHash(32) + relayer(32) + prev(32) + seq(1) + at(8)
    expect(encoded.length).toBe(119);
    expect(new TextDecoder().decode(encoded.slice(0, 14))).toBe("carrier:hop:v1");
    expect(encoded.slice(0, 14)).not.toEqual(encodeNote(NOTE).slice(0, 14));
  });

  it("rejects a malformed note hash", () => {
    expect(() =>
      encodeHop({
        noteHash: new Uint8Array(31),
        relayer: POUCH,
        prev: TO,
        seq: 0,
        at: 0n,
      }),
    ).toThrow(/32 bytes/);
  });
});

/**
 * Mirror of the parser in `programs/carrier/src/ed25519.rs`.
 *
 * The program's security rests on reading the precompile's data the same way
 * the client wrote it. Reimplementing the Rust parser here and asserting a
 * round-trip is what stops those two drifting apart silently — a mismatch
 * otherwise surfaces only as an opaque `SignatureNotVerified` on-chain.
 */
function parsePrecompile(data: Uint8Array) {
  const HEADER_LEN = 2;
  const OFFSETS_LEN = 14;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data[0];
  const out: { pubkey: PublicKey; message: Uint8Array }[] = [];

  for (let i = 0; i < count; i++) {
    let cursor = HEADER_LEN + i * OFFSETS_LEN;
    const next = () => {
      const value = view.getUint16(cursor, true);
      cursor += 2;
      return value;
    };

    next(); // signature_offset
    next(); // signature_instruction_index
    const pubkeyOffset = next();
    next(); // public_key_instruction_index
    const messageOffset = next();
    const messageSize = next();
    next(); // message_instruction_index

    out.push({
      pubkey: new PublicKey(data.slice(pubkeyOffset, pubkeyOffset + 32)),
      message: data.slice(messageOffset, messageOffset + messageSize),
    });
  }

  return out;
}

describe("ed25519 precompile instruction", () => {
  it("round-trips many signatures through one instruction", () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const messages = [
      encodeNote(NOTE),
      encodeHop({
        noteHash: hashNote(NOTE),
        relayer: signers[1].publicKey,
        prev: signers[0].publicKey,
        seq: 0,
        at: 1_700_000_000n,
      }),
      new TextEncoder().encode("short"),
    ];

    const entries = signers.map((signer, i) => ({
      publicKey: signer.publicKey,
      message: messages[i],
      signature: nacl.sign.detached(messages[i], signer.secretKey),
    }));

    const ix = createEd25519Instruction(entries);
    const parsed = parsePrecompile(new Uint8Array(ix.data));

    expect(parsed).toHaveLength(3);
    parsed.forEach((entry, i) => {
      expect(entry.pubkey.equals(signers[i].publicKey)).toBe(true);
      expect(entry.message).toEqual(messages[i]);
    });
  });

  it("verifies signatures that the precompile would accept", () => {
    const signer = Keypair.generate();
    const message = encodeNote(NOTE);
    const signature = nacl.sign.detached(message, signer.secretKey);

    expect(
      nacl.sign.detached.verify(message, signature, signer.publicKey.toBytes()),
    ).toBe(true);

    const ix = createEd25519Instruction([
      { publicKey: signer.publicKey, message, signature },
    ]);
    const [parsed] = parsePrecompile(new Uint8Array(ix.data));
    expect(parsed.message).toEqual(message);
  });

  it("rejects a signature of the wrong length", () => {
    expect(() =>
      createEd25519Instruction([
        {
          publicKey: Keypair.generate().publicKey,
          message: new Uint8Array(4),
          signature: new Uint8Array(10),
        },
      ]),
    ).toThrow(/64 bytes/);
  });
});

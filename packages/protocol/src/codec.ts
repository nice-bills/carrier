import { PublicKey } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";

/**
 * Wire encoding for Carrier notes and hops.
 *
 * These bytes are what people's phones sign while offline and what the program
 * verifies at settlement, so the layout here must match
 * `programs/carrier/src/state.rs` exactly — borsh field order, little-endian
 * integers, and the same domain prefixes. A mismatch shows up as an opaque
 * `SignatureNotVerified` at settlement, so the round-trip is covered by tests.
 */

export const NOTE_DOMAIN = new TextEncoder().encode("carrier:note:v1");
export const HOP_DOMAIN = new TextEncoder().encode("carrier:hop:v1");

/** Note slots available per pouch epoch. Mirrors SLOTS_PER_EPOCH in state.rs. */
export const SLOTS_PER_EPOCH = 256;
/**
 * Longest transmission chain settleable in one transaction. Mirrors MAX_HOPS in
 * state.rs, where the measurement behind the number is recorded. Raising it
 * without raising what settlement can verify makes the mesh build unredeemable
 * bundles.
 */
export const MAX_HOPS = 2;

/**
 * Longest chain settleable at all, by accumulating signature verification
 * across several transactions into a draft account. Mirrors MAX_CHAIN in
 * state.rs. This is what the mesh may build up to: chains beyond `MAX_HOPS`
 * simply settle by the slower path rather than being unredeemable.
 */
export const MAX_CHAIN = 16;

export interface Note {
  pouch: PublicKey;
  to: PublicKey;
  amount: bigint;
  slotIndex: number;
  epoch: number;
  expiry: bigint;
  relayFeeBps: number;
}

export interface Hop {
  noteHash: Uint8Array;
  relayer: PublicKey;
  prev: PublicKey;
  seq: number;
  at: bigint;
}

class Writer {
  private readonly parts: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    this.parts.push(value);
    return this;
  }

  pubkey(value: PublicKey): this {
    return this.bytes(value.toBytes());
  }

  u8(value: number): this {
    return this.bytes(Uint8Array.of(value & 0xff));
  }

  u16(value: number): this {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value, true);
    return this.bytes(buf);
  }

  u32(value: number): this {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value, true);
    return this.bytes(buf);
  }

  u64(value: bigint): this {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, value, true);
    return this.bytes(buf);
  }

  i64(value: bigint): this {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, value, true);
    return this.bytes(buf);
  }

  finish(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** Exact bytes the sender signs for a note. */
export function encodeNote(note: Note): Uint8Array {
  return new Writer()
    .bytes(NOTE_DOMAIN)
    .pubkey(note.pouch)
    .pubkey(note.to)
    .u64(note.amount)
    .u8(note.slotIndex)
    .u32(note.epoch)
    .i64(note.expiry)
    .u16(note.relayFeeBps)
    .finish();
}

export function hashNote(note: Note): Uint8Array {
  return sha256(encodeNote(note));
}

/**
 * What a device actually signs for a note.
 *
 * The hash, not the encoding. Solana caps a transaction at 1232 bytes and every
 * signature the precompile checks has to carry its message inline — a two-hop
 * settlement signing full encodings came to 1443 bytes and would not fit. The
 * encodings are domain-separated before hashing, so signing the digest keeps the
 * separation while costing 32 bytes instead of 102 or 119.
 */
export function noteSigningPayload(note: Note): Uint8Array {
  return hashNote(note);
}

/** Exact bytes both devices sign for a handoff. */
export function encodeHop(hop: Hop): Uint8Array {
  if (hop.noteHash.length !== 32) {
    throw new Error(`noteHash must be 32 bytes, got ${hop.noteHash.length}`);
  }
  return new Writer()
    .bytes(HOP_DOMAIN)
    .bytes(hop.noteHash)
    .pubkey(hop.relayer)
    .pubkey(hop.prev)
    .u8(hop.seq)
    .i64(hop.at)
    .finish();
}

export function hashHop(hop: Hop): Uint8Array {
  return sha256(encodeHop(hop));
}

/** What both devices sign for a handoff. See `noteSigningPayload`. */
export function hopSigningPayload(hop: Hop): Uint8Array {
  return hashHop(hop);
}

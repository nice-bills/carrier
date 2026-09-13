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
/** Longest transmission chain settleable in one instruction. Mirrors MAX_HOPS. */
export const MAX_HOPS = 8;

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

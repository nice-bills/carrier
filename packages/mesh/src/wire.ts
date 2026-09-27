import { PublicKey } from "@solana/web3.js";
import { MAX_CHAIN, type Hop } from "@carrier/protocol";
import { MeshError, type Bundle, type HandoffOffer } from "./types.js";

/**
 * JSON form of a handoff, for transports that move text.
 *
 * Lives here rather than in the app because it is protocol, not platform: any
 * transport — Nearby Connections, a Bitchat bridge, a QR code — needs the same
 * bytes to mean the same thing on both sides.
 *
 * Two things do not survive `JSON.stringify` and are the reason this exists at
 * all: `bigint` throws outright, and `Uint8Array` silently becomes an object of
 * numeric keys that parses back as garbage. Both are converted explicitly, and
 * the round trip is tested.
 */

const b64 = {
  encode: (bytes: Uint8Array): string =>
    globalThis.btoa(String.fromCharCode(...bytes)),
  decode: (text: string): Uint8Array =>
    Uint8Array.from(globalThis.atob(text), (c) => c.charCodeAt(0)),
};

export interface WireOffer {
  owner: string;
  note: {
    pouch: string;
    to: string;
    amount: string;
    slotIndex: number;
    epoch: number;
    expiry: string;
    relayFeeBps: number;
  };
  hops: WireHop[];
  entries: { publicKey: string; signature: string; message: string }[];
  hop: WireHop;
  giverSignature: string;
}

interface WireHop {
  noteHash: string;
  relayer: string;
  prev: string;
  seq: number;
  at: string;
}

const encodeHopWire = (h: Bundle["hops"][number]): WireHop => ({
  noteHash: b64.encode(h.noteHash),
  relayer: h.relayer.toBase58(),
  prev: h.prev.toBase58(),
  seq: h.seq,
  at: h.at.toString(),
});

export function encodeOffer(offer: HandoffOffer): WireOffer {
  return {
    owner: offer.bundle.owner.toBase58(),
    note: {
      pouch: offer.bundle.note.pouch.toBase58(),
      to: offer.bundle.note.to.toBase58(),
      amount: offer.bundle.note.amount.toString(),
      slotIndex: offer.bundle.note.slotIndex,
      epoch: offer.bundle.note.epoch,
      expiry: offer.bundle.note.expiry.toString(),
      relayFeeBps: offer.bundle.note.relayFeeBps,
    },
    hops: offer.bundle.hops.map(encodeHopWire),
    entries: offer.bundle.entries.map((e) => ({
      publicKey: e.publicKey.toBase58(),
      signature: b64.encode(e.signature),
      message: b64.encode(e.message),
    })),
    hop: encodeHopWire(offer.hop),
    giverSignature: b64.encode(offer.giverSignature),
  };
}

/**
 * Decoding is where bytes from a stranger become objects, so it validates
 * everything: types, lengths, integer ranges, and sizes. Anything wrong throws a
 * `MeshError` — never a TypeError or a silently wrapped number — and
 * `tryDecodeOffer` turns that into `null` for callers on a radio callback.
 */
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
/** Longest base58 or base64 string any field here can legitimately need. */
const MAX_FIELD_CHARS = 128;

const fail = (what: string): never => {
  throw new MeshError(`wire offer: ${what}`);
};

function obj(x: unknown, what: string): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) fail(`${what} is not an object`);
  return x as Record<string, unknown>;
}

function str(x: unknown, what: string): string {
  if (typeof x !== "string" || x.length === 0 || x.length > MAX_FIELD_CHARS) {
    fail(`${what} is not a short string`);
  }
  return x as string;
}

function key(x: unknown, what: string): PublicKey {
  const text = str(x, what);
  try {
    return new PublicKey(text);
  } catch {
    return fail(`${what} is not a public key`);
  }
}

function bytes(x: unknown, len: number, what: string): Uint8Array {
  const text = str(x, what);
  let out: Uint8Array;
  try {
    out = b64.decode(text);
  } catch {
    return fail(`${what} is not base64`);
  }
  if (out.length !== len) fail(`${what} must be ${len} bytes`);
  return out;
}

function int(x: unknown, max: number, what: string): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > max) {
    fail(`${what} is out of range`);
  }
  return x as number;
}

function big(x: unknown, min: bigint, max: bigint, what: string): bigint {
  if (typeof x !== "string" || !/^-?\d{1,20}$/.test(x)) fail(`${what} is not an integer`);
  const value = BigInt(x as string);
  if (value < min || value > max) fail(`${what} is out of range`);
  return value;
}

function decodeHopWire(raw: unknown, what: string): Hop {
  const h = obj(raw, what);
  return {
    noteHash: bytes(h.noteHash, 32, `${what}.noteHash`),
    relayer: key(h.relayer, `${what}.relayer`),
    prev: key(h.prev, `${what}.prev`),
    seq: int(h.seq, 0xff, `${what}.seq`),
    at: big(h.at, I64_MIN, I64_MAX, `${what}.at`),
  };
}

export function decodeOffer(input: unknown): HandoffOffer {
  const raw = obj(input, "offer");
  const n = obj(raw.note, "note");
  if (!Array.isArray(raw.hops) || raw.hops.length > MAX_CHAIN) fail("hops is not a short array");
  if (!Array.isArray(raw.entries) || raw.entries.length > 1 + 2 * MAX_CHAIN) {
    fail("entries is not a short array");
  }
  const hops = raw.hops as unknown[];
  const entries = raw.entries as unknown[];

  return {
    bundle: {
      owner: key(raw.owner, "owner"),
      note: {
        pouch: key(n.pouch, "note.pouch"),
        to: key(n.to, "note.to"),
        amount: big(n.amount, 0n, U64_MAX, "note.amount"),
        slotIndex: int(n.slotIndex, 0xff, "note.slotIndex"),
        epoch: int(n.epoch, 0xffff_ffff, "note.epoch"),
        expiry: big(n.expiry, I64_MIN, I64_MAX, "note.expiry"),
        relayFeeBps: int(n.relayFeeBps, 0xffff, "note.relayFeeBps"),
      },
      hops: hops.map((h, i) => decodeHopWire(h, `hops[${i}]`)),
      entries: entries.map((rawEntry, i) => {
        const e = obj(rawEntry, `entries[${i}]`);
        return {
          publicKey: key(e.publicKey, `entries[${i}].publicKey`),
          signature: bytes(e.signature, 64, `entries[${i}].signature`),
          // Every signed payload is a 32-byte digest (see noteSigningPayload).
          message: bytes(e.message, 32, `entries[${i}].message`),
        };
      }),
    },
    hop: decodeHopWire(raw.hop, "hop"),
    giverSignature: bytes(raw.giverSignature, 64, "giverSignature"),
  };
}

/** `decodeOffer` for untrusted input: `null` instead of throwing. */
export function tryDecodeOffer(input: unknown): HandoffOffer | null {
  try {
    return decodeOffer(input);
  } catch {
    return null;
  }
}

import { PublicKey } from "@solana/web3.js";
import type { Bundle, HandoffOffer } from "./types.js";

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

const decodeHopWire = (h: WireHop) => ({
  noteHash: b64.decode(h.noteHash),
  relayer: new PublicKey(h.relayer),
  prev: new PublicKey(h.prev),
  seq: h.seq,
  at: BigInt(h.at),
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

export function decodeOffer(raw: WireOffer): HandoffOffer {
  return {
    bundle: {
      owner: new PublicKey(raw.owner),
      note: {
        pouch: new PublicKey(raw.note.pouch),
        to: new PublicKey(raw.note.to),
        amount: BigInt(raw.note.amount),
        slotIndex: raw.note.slotIndex,
        epoch: raw.note.epoch,
        expiry: BigInt(raw.note.expiry),
        relayFeeBps: raw.note.relayFeeBps,
      },
      hops: raw.hops.map(decodeHopWire),
      entries: raw.entries.map((e) => ({
        publicKey: new PublicKey(e.publicKey),
        signature: b64.decode(e.signature),
        message: b64.decode(e.message),
      })),
    },
    hop: decodeHopWire(raw.hop),
    giverSignature: b64.decode(raw.giverSignature),
  };
}

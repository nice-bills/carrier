import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { Deflate, Inflate } from "pako";
import { encodeOffer } from "@carrier/mesh";
import { MeshError } from "@carrier/mesh";
import { hex, parseOffer } from "../chain";
import type { TrailedOffer } from "../map/trail";

/**
 * Handing a payment over by QR code, for any two phones: iPhone to Android
 * included, radios off. Three kinds of code, each starting with a tag:
 *
 *   CK1:<key>                        the receiver's key (shown first: a hop
 *                                    must name the next carrier, so the giver
 *                                    needs it before it can sign one)
 *   CS1/<id>/<i>/<n>/<chunk>         part i of n of a signed slip for that key
 *   CR1/<base45>                     the receiver's counter-signature, so the
 *                                    giver's phone can let the note go
 *
 * A slip is JSON `{ g: giver, o: wire offer, t?: trail }`, deflated and
 * written in base45 (RFC 9285), which QR codes store in their compact
 * alphanumeric mode. A two-hop slip is about 1 KB, two or three parts.
 * Nothing here is trusted: `pocket.accept` checks every signature, and the
 * giver's is over the hop naming this phone, so a slip is only good to it.
 */

const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const B45_INDEX = new Map([...B45].map((c, i) => [c, i]));

export function toBase45(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      let n = bytes[i]! * 256 + bytes[i + 1]!;
      const c = n % 45;
      n = (n - c) / 45;
      const d = n % 45;
      const e = (n - d) / 45;
      out += B45[c]! + B45[d]! + B45[e]!;
    } else {
      const n = bytes[i]!;
      out += B45[n % 45]! + B45[Math.floor(n / 45)]!;
    }
  }
  return out;
}

export function fromBase45(text: string): Uint8Array {
  if (text.length % 3 === 1) throw new QrError("not base45");
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 3) {
    const v = [...text.slice(i, i + 3)].map((ch) => {
      const x = B45_INDEX.get(ch);
      if (x === undefined) throw new QrError("not base45");
      return x;
    });
    if (v.length === 3) {
      const n = v[0]! + v[1]! * 45 + v[2]! * 2025;
      if (n > 0xffff) throw new QrError("not base45");
      out.push(n >> 8, n & 0xff);
    } else {
      const n = v[0]! + v[1]! * 45;
      if (n > 0xff) throw new QrError("not base45");
      out.push(n);
    }
  }
  return new Uint8Array(out);
}

export class QrError extends Error {}

/** Characters of base45 per slip part: a QR code a phone camera reads at arm's length. */
export const PART_CHARS = 600;
/** More parts than this is not a slip. */
export const MAX_PARTS = 16;
/** A slip never inflates to more than this. */
const MAX_SLIP_BYTES = 64 * 1024;

// --- keys ---------------------------------------------------------------------

const KEY_TAG = "CK1:";

export function keyCode(key: PublicKey): string {
  return KEY_TAG + key.toBase58();
}

/** The key in a key code, or null if this is not one. */
export function readKey(text: string): PublicKey | null {
  if (!text.startsWith(KEY_TAG)) return null;
  const body = text.slice(KEY_TAG.length);
  if (body.length < 32 || body.length > 44) return null;
  try {
    return new PublicKey(body);
  } catch {
    return null;
  }
}

// --- slips ----------------------------------------------------------------------

const SLIP_TAG = "CS1/";

/** A signed offer to one key, as the parts of an animated QR code. */
export function slipCodes(giver: PublicKey, offer: TrailedOffer, id = randomId()): string[] {
  const json = JSON.stringify({ g: giver.toBase58(), o: encodeOffer(offer), ...(Array.isArray(offer.trail) && offer.trail.length ? { t: offer.trail } : {}) });
  const d = new Deflate({ level: 9 });
  d.push(new TextEncoder().encode(json), true);
  if (d.err) throw new QrError("could not pack the slip");
  const body = toBase45(d.result as Uint8Array);
  // Parts break on a 3-character boundary so each decodes on its own terms.
  const size = PART_CHARS - (PART_CHARS % 3);
  const n = Math.max(1, Math.ceil(body.length / size));
  if (n > MAX_PARTS) throw new QrError("this payment is too long to show as a code");
  return Array.from({ length: n }, (_, i) => `${SLIP_TAG}${id}/${i + 1}/${n}/${body.slice(i * size, (i + 1) * size)}`);
}

export type SlipProgress =
  | { kind: "progress"; got: number; total: number }
  | { kind: "done"; giver: PublicKey; offer: TrailedOffer };

/**
 * Collects the parts of one slip in any order, repeats included. A part of a
 * different slip starts over. `add` returns null for codes that are not slip
 * parts, and throws `QrError` when a complete slip does not read.
 */
export class SlipReader {
  private id = "";
  private total = 0;
  private parts = new Map<number, string>();

  add(text: string): SlipProgress | null {
    if (!text.startsWith(SLIP_TAG)) return null;
    const m = /^CS1\/([0-9A-Z]{4})\/(\d{1,2})\/(\d{1,2})\/(.+)$/s.exec(text);
    if (!m) return null;
    const [, id, iText, nText, chunk] = m;
    const i = Number(iText);
    const n = Number(nText);
    if (n < 1 || n > MAX_PARTS || i < 1 || i > n || chunk!.length > PART_CHARS) return null;
    if (id !== this.id || n !== this.total) {
      this.id = id!;
      this.total = n;
      this.parts = new Map();
    }
    this.parts.set(i, chunk!);
    if (this.parts.size < n) return { kind: "progress", got: this.parts.size, total: n };
    const body = Array.from({ length: n }, (_, k) => this.parts.get(k + 1)!).join("");
    this.parts = new Map();
    this.id = "";
    return { kind: "done", ...readSlip(body) };
  }
}

function readSlip(body: string): { giver: PublicKey; offer: TrailedOffer } {
  const packed = fromBase45(body);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const inf = new Inflate();
  inf.onData = (c: Uint8Array) => {
    size += c.length;
    if (size > MAX_SLIP_BYTES) throw new QrError("that code is far too big to be a payment");
    chunks.push(c);
  };
  inf.push(packed, true);
  if (inf.err) throw new QrError("that code did not unpack");
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  let x: unknown;
  try {
    x = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new QrError("that code is not a payment");
  }
  if (typeof x !== "object" || x === null) throw new QrError("that code is not a payment");
  const { g, o, t } = x as { g?: unknown; o?: unknown; t?: unknown };
  if (typeof g !== "string" || g.length > 44) throw new QrError("that code names no giver");
  let giver: PublicKey;
  try {
    giver = new PublicKey(g);
  } catch {
    throw new QrError("that code names no giver");
  }
  try {
    const offer = parseOffer(o);
    return { giver, offer: Array.isArray(t) ? { ...offer, trail: t } : offer };
  } catch (e) {
    throw new QrError(e instanceof MeshError ? `the payment in it is malformed (${e.message})` : "the payment in it is malformed");
  }
}

// --- receipts -------------------------------------------------------------------

const RECEIPT_TAG = "CR1/";

export interface QrReceipt {
  noteHash: string;
  /** Who took it: the key the hop named. */
  peer: PublicKey;
  signature: Uint8Array;
}

export function receiptCode(noteHash: string, peer: PublicKey, signature: Uint8Array): string {
  const bytes = new Uint8Array(128);
  bytes.set(Buffer.from(noteHash, "hex"), 0);
  bytes.set(peer.toBytes(), 32);
  bytes.set(signature, 64);
  return RECEIPT_TAG + toBase45(bytes);
}

export function readReceipt(text: string): QrReceipt | null {
  if (!text.startsWith(RECEIPT_TAG)) return null;
  try {
    const bytes = fromBase45(text.slice(RECEIPT_TAG.length));
    if (bytes.length !== 128) return null;
    return { noteHash: hex(bytes.slice(0, 32)), peer: new PublicKey(bytes.slice(32, 64)), signature: bytes.slice(64) };
  } catch {
    return null;
  }
}

function randomId(): string {
  const a = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

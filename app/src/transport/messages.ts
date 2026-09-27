import { MTU } from "@carrier/mesh";

/**
 * Everything a peer can send, and the strict checks that run on it before any
 * of it is trusted. Anyone in radio range can connect, so every field here is
 * attacker-controlled until proven otherwise.
 */

/** Hard caps. A peer that goes over any of them is disconnected. */
export const LIMITS = {
  /** Frames per logical message: 64 × 480 bytes ≈ 30 KB, room for a full chain. */
  maxFrames: 64,
  /** Transfers a single peer may have half-delivered at once. */
  maxTransfersPerPeer: 8,
  /** Bytes buffered for one peer across all its half-delivered transfers. */
  maxInboxBytesPerPeer: 64 * 1024,
  /** A half-delivered transfer is dropped after this long. */
  transferTtlMs: 30_000,
  /** Characters in one radio payload. A frame is well under this. */
  maxTextLength: 1024,
  /** Note hashes one peer may advertise in one digest list. */
  maxDigests: 64,
  /** Frames per second a peer may sustain, and the burst it may spend at once. */
  framesPerSecond: 30,
  frameBurst: 120,
  /** Rejected frames or messages before the peer is dropped. */
  maxStrikes: 8,
  /** Notes named in one "hand" message. A person passes one slip at a time. */
  maxHanded: 8,
  /** Connected peers at once. More are refused at invitation. */
  maxPeers: 8,
  /** How long `request` and `digests` wait for an answer. */
  requestTimeoutMs: 10_000,
  /** Requests in flight across all peers. */
  maxPending: 32,
} as const;

/** One radio payload: a numbered slice of a logical message. */
export interface WireFrame {
  v: 1;
  /** Random transfer id: frames of different messages can never mix. */
  t: string;
  i: number;
  n: number;
  /** base64 of at most `MTU` bytes. */
  p: string;
}

export type Message =
  | { kind: "challenge"; nonce: string }
  | { kind: "prove"; key: string; sig: string }
  | { kind: "digests?"; id: string }
  | { kind: "digests"; id: string; digests: string[] }
  | { kind: "want"; id: string; digest: string }
  | { kind: "offer"; id: string; body: unknown }
  | { kind: "nope"; id: string }
  | { kind: "ack"; digest: string; sig: string }
  /**
   * "I am handing you these now." Sent by a giver after its person confirmed a
   * pass, so the receiver pulls exactly these notes rather than everything.
   * It moves nothing by itself: the receiver still asks with `want`, and the
   * giver still decides in `offerFor` whether to serve each one.
   */
  | { kind: "hand"; digests: string[] };

export const TRANSFER_ID = /^[0-9a-f]{16}$/;
export const REQUEST_ID = /^[0-9a-f]{16}$/;
export const NOTE_HASH = /^[0-9a-f]{64}$/;
/** Advertised name: a short random session id, never the wallet key. */
export const SESSION_ID = /^c1-[0-9a-f]{16}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isB64 = (x: unknown, maxLen: number): x is string =>
  typeof x === "string" && x.length <= maxLen && x.length % 4 === 0 && B64.test(x);

export function parseFrame(text: string): WireFrame | null {
  if (typeof text !== "string" || text.length > LIMITS.maxTextLength) return null;
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(x) || x.v !== 1) return null;
  const { t, i, n, p } = x;
  if (typeof t !== "string" || !TRANSFER_ID.test(t)) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > LIMITS.maxFrames) return null;
  if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= n) return null;
  if (!isB64(p, Math.ceil(MTU / 3) * 4)) return null;
  return { v: 1, t, i, n, p };
}

/** Validate a reassembled message. Unknown kinds and extra-large fields are refused. */
export function parseMessage(x: unknown): Message | null {
  if (!isObj(x) || typeof x.kind !== "string") return null;
  const id = (v: unknown): v is string => typeof v === "string" && REQUEST_ID.test(v);
  switch (x.kind) {
    case "challenge":
      return isB64(x.nonce, 44) ? { kind: "challenge", nonce: x.nonce } : null;
    case "prove":
      return typeof x.key === "string" && x.key.length <= 44 && isB64(x.sig, 88)
        ? { kind: "prove", key: x.key, sig: x.sig }
        : null;
    case "digests?":
      return id(x.id) ? { kind: "digests?", id: x.id } : null;
    case "digests": {
      if (!id(x.id) || !Array.isArray(x.digests) || x.digests.length > LIMITS.maxDigests) return null;
      const digests = x.digests.filter((d): d is string => typeof d === "string" && NOTE_HASH.test(d));
      if (digests.length !== x.digests.length) return null;
      return { kind: "digests", id: x.id, digests: [...new Set(digests)] };
    }
    case "want":
      return id(x.id) && typeof x.digest === "string" && NOTE_HASH.test(x.digest)
        ? { kind: "want", id: x.id, digest: x.digest }
        : null;
    case "offer":
      return id(x.id) && isObj(x.body) ? { kind: "offer", id: x.id, body: x.body } : null;
    case "nope":
      return id(x.id) ? { kind: "nope", id: x.id } : null;
    case "ack":
      return typeof x.digest === "string" && NOTE_HASH.test(x.digest) && isB64(x.sig, 88)
        ? { kind: "ack", digest: x.digest, sig: x.sig }
        : null;
    case "hand": {
      if (!Array.isArray(x.digests) || x.digests.length === 0 || x.digests.length > LIMITS.maxHanded) return null;
      const digests = x.digests.filter((d): d is string => typeof d === "string" && NOTE_HASH.test(d));
      if (digests.length !== x.digests.length) return null;
      return { kind: "hand", digests: [...new Set(digests)] };
    }
    default:
      return null;
  }
}

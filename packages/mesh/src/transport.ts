import type { PublicKey } from "@solana/web3.js";
import type { HandoffOffer } from "./types.js";

/**
 * What the radio layer has to provide.
 *
 * Deliberately tiny. A handoff is two messages — the giver offers, the receiver
 * counter-signs — so a transport only needs to find peers and move those two
 * payloads. Everything about what makes a handoff valid lives in `CarrierNode`,
 * which is why the mesh can be tested exhaustively with no hardware in the room.
 *
 * The BLE implementation lives in the app, not here: `react-native-ble-plx` drags
 * in React Native, and this package has to stay runnable under plain Node so the
 * simulation and the tests work on a laptop.
 */
export interface Transport {
  /** Announce this device so nearby peers can find it. */
  advertise(me: PublicKey): Promise<void>;

  /** Peers currently in range. Called repeatedly; cheap. */
  peers(): Promise<PublicKey[]>;

  /** Ask a peer what note hashes it is carrying. */
  digests(peer: PublicKey): Promise<string[]>;

  /** Ask a peer to hand over one note, naming ourselves as the next carrier. */
  request(peer: PublicKey, noteHash: string): Promise<HandoffOffer>;

  /** Tell a peer we accepted, so it can record the completed hop. */
  acknowledge(peer: PublicKey, noteHash: string, signature: Uint8Array): Promise<void>;

  stop(): Promise<void>;
}

/**
 * Bytes on the wire.
 *
 * BLE characteristics cap out around 512 bytes per write, and a bundle with a
 * full hop chain is larger than that, so any real transport has to chunk. Framing
 * is defined here rather than in the BLE layer so a future transport — Wi-Fi
 * Aware, LoRa, an audio modem — inherits it unchanged.
 */
export const MTU = 480;

/**
 * Most frames one transfer may span. A full MAX_CHAIN bundle is roughly 10 KB of
 * JSON, about two dozen frames, so 64 leaves headroom while capping what a
 * stranger's `total` can make a receiver allocate at 64 × MTU.
 */
export const MAX_FRAMES = 64;
/** Longest transfer digest accepted from a peer. */
export const MAX_DIGEST_CHARS = 128;

export interface Frame {
  /** Digest of the transfer this frame belongs to (note hash or message id), hex. */
  digest: string;
  index: number;
  total: number;
  payload: Uint8Array;
}

/**
 * Whether a value from the radio is a well-formed frame: integer `index` in
 * `[0, total)`, integer `total` in `[1, MAX_FRAMES]`, a short digest, and a
 * payload no larger than one MTU.
 */
export function isFrame(x: unknown): x is Frame {
  if (!x || typeof x !== "object") return false;
  const f = x as Partial<Frame>;
  return (
    typeof f.digest === "string" &&
    f.digest.length > 0 &&
    f.digest.length <= MAX_DIGEST_CHARS &&
    Number.isInteger(f.total) &&
    (f.total as number) >= 1 &&
    (f.total as number) <= MAX_FRAMES &&
    Number.isInteger(f.index) &&
    (f.index as number) >= 0 &&
    (f.index as number) < (f.total as number) &&
    f.payload instanceof Uint8Array &&
    f.payload.length <= MTU
  );
}

export function frame(digest: string, body: Uint8Array): Frame[] {
  const total = Math.max(1, Math.ceil(body.length / MTU));
  if (total > MAX_FRAMES) {
    throw new RangeError(`body of ${body.length} bytes needs more than ${MAX_FRAMES} frames`);
  }
  return Array.from({ length: total }, (_, index) => ({
    digest,
    index,
    total,
    payload: body.subarray(index * MTU, (index + 1) * MTU),
  }));
}

/**
 * Reassemble one transfer, tolerating duplicates and arrival out of order.
 *
 * Both happen constantly over BLE: a peer walks out of range mid-transfer and
 * back in, and the stack redelivers. Returns null until every frame is present.
 *
 * Frames come from strangers, so this never throws. Malformed frames are
 * ignored; frames for other transfers (a different `digest`) are ignored; and
 * frames of the chosen transfer that disagree about `total` make the whole
 * transfer unreadable (null). The transfer is `digest` if given, otherwise the
 * first well-formed frame's.
 */
export function reassemble(frames: readonly unknown[], digest?: string): Uint8Array | null {
  if (!Array.isArray(frames)) return null;
  const mine = frames.filter(isFrame);
  const target = digest ?? mine[0]?.digest;
  if (target === undefined) return null;
  const transfer = mine.filter((f) => f.digest === target);
  if (transfer.length === 0) return null;

  const total = transfer[0]!.total;
  // `.fill()` matters: a sparse array has holes, and `some`/`every` skip holes
  // rather than visiting them — so a missing frame would read as present.
  const slots = new Array<Uint8Array | undefined>(total).fill(undefined);
  for (const f of transfer) {
    if (f.total !== total) return null;
    slots[f.index] = f.payload;
  }
  if (slots.some((s) => s === undefined)) return null;

  const size = slots.reduce((n, s) => n + s!.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const s of slots) {
    out.set(s!, at);
    at += s!.length;
  }
  return out;
}

/**
 * Bounded reassembly buffer for one peer.
 *
 * Holds at most `maxTransfers` partial transfers, each at most `MAX_FRAMES`
 * frames, evicting the oldest when a new transfer arrives while full. `push`
 * never throws; it returns the completed body once a transfer is whole and
 * then forgets it.
 */
export class Reassembler {
  private readonly pending = new Map<string, { total: number; slots: (Uint8Array | undefined)[] }>();

  constructor(private readonly maxTransfers = 4) {}

  push(input: unknown): { digest: string; body: Uint8Array } | null {
    if (!isFrame(input)) return null;
    let transfer = this.pending.get(input.digest);
    if (transfer && transfer.total !== input.total) {
      // Two transfers claiming one digest: neither can be trusted.
      this.pending.delete(input.digest);
      return null;
    }
    if (!transfer) {
      while (this.pending.size >= this.maxTransfers) {
        const oldest = this.pending.keys().next().value as string;
        this.pending.delete(oldest);
      }
      transfer = { total: input.total, slots: new Array(input.total).fill(undefined) };
      this.pending.set(input.digest, transfer);
    }
    transfer.slots[input.index] = input.payload;
    if (transfer.slots.some((s) => s === undefined)) return null;

    this.pending.delete(input.digest);
    const body = reassemble(
      transfer.slots.map((payload, index) => ({ digest: input.digest, index, total: transfer!.total, payload })),
    );
    return body ? { digest: input.digest, body } : null;
  }

  /** Partial transfers currently buffered. */
  get size(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }
}

/**
 * `JSON.parse` for bytes or text from a stranger: `undefined` instead of a
 * throw, and a length cap applied before parsing. The result is still
 * `unknown` — validate its shape (e.g. with `decodeOffer`) before use.
 */
export function parse(input: string | Uint8Array, maxChars = MAX_FRAMES * MTU * 2): unknown {
  try {
    const text = typeof input === "string" ? input : new TextDecoder().decode(input);
    if (text.length > maxChars) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

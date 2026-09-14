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

export interface Frame {
  /** Note hash this frame belongs to, hex. */
  digest: string;
  index: number;
  total: number;
  payload: Uint8Array;
}

export function frame(digest: string, body: Uint8Array): Frame[] {
  const total = Math.max(1, Math.ceil(body.length / MTU));
  return Array.from({ length: total }, (_, index) => ({
    digest,
    index,
    total,
    payload: body.subarray(index * MTU, (index + 1) * MTU),
  }));
}

/**
 * Reassemble frames, tolerating duplicates and arrival out of order.
 *
 * Both happen constantly over BLE: a peer walks out of range mid-transfer and
 * back in, and the stack redelivers. Returns null until every frame is present.
 */
export function reassemble(frames: Frame[]): Uint8Array | null {
  if (frames.length === 0) return null;
  const total = frames[0]!.total;
  // `.fill()` matters: a sparse array from `new Array(total)` has holes, and
  // `some`/`every` skip holes rather than visiting them — so a missing frame
  // would read as present and we would reassemble a bundle full of gaps.
  const slots = new Array<Uint8Array | undefined>(total).fill(undefined);

  for (const f of frames) {
    if (f.total !== total) return null; // frames from two different transfers
    if (f.index >= total) return null;
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

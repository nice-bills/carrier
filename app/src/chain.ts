import { Buffer } from "buffer";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import {
  MAX_CHAIN,
  MAX_NOTE_LIFETIME_SECONDS,
  hashNote,
  hopSigningPayload,
  noteSigningPayload,
} from "@carrier/protocol";
import {
  MeshError,
  decodeOffer,
  encodeOffer,
  type Bundle,
  type HandoffOffer,
  type WireOffer,
} from "@carrier/mesh";

/**
 * Everything the app checks about a bundle before it will carry it, store it,
 * or restore it from disk. `CarrierNode.acceptHandoff` checks the new hop; this
 * re-verifies the whole chain as well, so a forged earlier hop is refused here
 * even if the node would let it through.
 */

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const noteKey = (b: Bundle) => hex(hashNote(b.note));

/**
 * How far two honest phones' clocks may disagree. A new hop must be stamped
 * within this of our own clock, and no hop may predate the one before it by
 * more than this. Hop times are still only attested by the two devices that
 * signed them; nothing on-chain checks them beyond a coarse bound.
 */
export const CLOCK_SKEW_SECONDS = 60n * 60n;

const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function verifyEntry(
  entry: Bundle["entries"][number] | undefined,
  by: PublicKey,
  message: Uint8Array,
  what: string,
) {
  if (!entry) throw new MeshError(`${what} is missing`);
  if (!entry.publicKey.equals(by)) throw new MeshError(`${what} is by the wrong key`);
  if (!eq(entry.message, message)) throw new MeshError(`${what} signs the wrong message`);
  if (entry.signature.length !== 64 || !nacl.sign.detached.verify(message, entry.signature, by.toBytes())) {
    throw new MeshError(`${what} does not verify`);
  }
}

/**
 * Verify a whole bundle: note signature, then every hop's sequence, note hash,
 * link to the previous carrier, both co-signatures and timestamp order. Also
 * refuses chains the program would refuse to pay (a repeated carrier, or the
 * sender or recipient as a carrier), so a device never carries a dead note.
 */
export function verifyBundle(b: Bundle, now: bigint): void {
  const { note, owner, hops, entries } = b;
  if (note.expiry <= now) throw new MeshError("note has expired");
  if (note.expiry > now + MAX_NOTE_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS) {
    throw new MeshError("note expiry is further out than any pouch allows");
  }
  if (hops.length > MAX_CHAIN) throw new MeshError("chain is longer than settlement allows");
  if (entries.length !== 1 + 2 * hops.length) {
    throw new MeshError("signature list does not match the hop count");
  }

  const noteHash = hashNote(note);
  verifyEntry(entries[0], owner, noteSigningPayload(note), "note signature");

  const seen = new Set<string>([owner.toBase58(), note.to.toBase58()]);
  let prev = owner;
  let lastAt: bigint | null = null;
  hops.forEach((hop, i) => {
    if (hop.seq !== i) throw new MeshError(`hop ${i} is out of sequence`);
    if (!eq(hop.noteHash, noteHash)) throw new MeshError(`hop ${i} names a different note`);
    if (!hop.prev.equals(prev)) throw new MeshError(`hop ${i} does not link to the previous carrier`);
    const relayer = hop.relayer.toBase58();
    if (seen.has(relayer)) {
      throw new MeshError(`hop ${i} repeats a key or pays the sender or recipient`);
    }
    seen.add(relayer);
    if (lastAt !== null && hop.at < lastAt - CLOCK_SKEW_SECONDS) {
      throw new MeshError(`hop ${i} is dated before hop ${i - 1}`);
    }
    if (hop.at > now + CLOCK_SKEW_SECONDS) throw new MeshError(`hop ${i} is dated in the future`);
    lastAt = hop.at;

    const message = hopSigningPayload(hop);
    verifyEntry(entries[1 + 2 * i], hop.relayer, message, `hop ${i} receiver signature`);
    verifyEntry(entries[2 + 2 * i], hop.prev, message, `hop ${i} giver signature`);
    prev = hop.relayer;
  });
}

/** The key that would sign the next hop as giver. */
export const lastCarrier = (b: Bundle): PublicKey =>
  b.hops.length === 0 ? b.owner : b.hops[b.hops.length - 1]!.relayer;

/**
 * Checks on an inbound offer beyond what `acceptHandoff` does: the giver is the
 * peer we authenticated, the whole existing chain verifies, the new hop's time
 * is plausible, and we are allowed to be the next carrier at all.
 */
export function verifyOffer(offer: HandoffOffer, giver: PublicKey, me: PublicKey, now: bigint): void {
  const { bundle, hop } = offer;
  verifyBundle(bundle, now);
  if (!hop.prev.equals(giver)) throw new MeshError("offer is not from the peer who sent it");
  if (!lastCarrier(bundle).equals(giver)) throw new MeshError("sender is not the note's current carrier");
  if (!hop.relayer.equals(me)) throw new MeshError("offer names a different carrier");
  // Delivery to the recipient is allowed (the node keeps it without adding a
  // hop); carrying one's own note, or carrying twice, is not.
  const delivering = bundle.note.to.equals(me);
  if (!delivering) {
    if (bundle.owner.equals(me)) throw new MeshError("the sender cannot carry their own note");
    if (bundle.hops.some((h) => h.relayer.equals(me))) throw new MeshError("already in this chain");
  }
  const lastAt = bundle.hops.length ? bundle.hops[bundle.hops.length - 1]!.at : null;
  if (lastAt !== null && hop.at < lastAt - CLOCK_SKEW_SECONDS) {
    throw new MeshError("new hop is dated before the last one");
  }
  if (hop.at > now + CLOCK_SKEW_SECONDS || hop.at < now - CLOCK_SKEW_SECONDS) {
    throw new MeshError("new hop's time is too far from ours");
  }
}

// --- wire shape -----------------------------------------------------------

const MAX_STR = 128;
const isStr = (x: unknown, max = MAX_STR): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
const isInt = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
const isIntString = (x: unknown): x is string => typeof x === "string" && /^-?\d{1,20}$/.test(x);
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isKey = (x: unknown) => {
  if (!isStr(x, 44)) return false;
  try {
    new PublicKey(x as string);
    return true;
  } catch {
    return false;
  }
};

function isWireHop(h: unknown): boolean {
  return (
    isObj(h) &&
    isStr(h.noteHash, 64) &&
    isKey(h.relayer) &&
    isKey(h.prev) &&
    isInt(h.seq, 0, MAX_CHAIN) &&
    isIntString(h.at)
  );
}

/** Strict structural check of untrusted JSON before `decodeOffer` sees it. */
export function isWireOffer(x: unknown): x is WireOffer {
  if (!isObj(x) || !isObj(x.note)) return false;
  const n = x.note;
  return (
    isKey(x.owner) &&
    isKey(n.pouch) &&
    isKey(n.to) &&
    isIntString(n.amount) &&
    isInt(n.slotIndex, 0, 255) &&
    isInt(n.epoch, 0, 0xffff_ffff) &&
    isIntString(n.expiry) &&
    isInt(n.relayFeeBps, 0, 10_000) &&
    Array.isArray(x.hops) &&
    x.hops.length <= MAX_CHAIN &&
    x.hops.every(isWireHop) &&
    Array.isArray(x.entries) &&
    x.entries.length === 1 + 2 * x.hops.length &&
    x.entries.every(
      (e) => isObj(e) && isKey(e.publicKey) && isStr(e.signature, 128) && isStr(e.message, 64),
    ) &&
    isWireHop(x.hop) &&
    isStr(x.giverSignature, 128)
  );
}

/** Decode untrusted JSON into an offer, or throw. Never returns a half-checked value. */
export function parseOffer(x: unknown): HandoffOffer {
  if (!isWireOffer(x)) throw new MeshError("offer is malformed");
  const offer = decodeOffer(x);
  if (offer.giverSignature.length !== 64) throw new MeshError("giver signature is malformed");
  if (offer.hop.noteHash.length !== 32) throw new MeshError("hop note hash is malformed");
  return offer;
}

// --- storage form -----------------------------------------------------------

/** A bundle at rest: the wire offer's shape without the pending hop. */
export type StoredBundle = Omit<WireOffer, "hop" | "giverSignature">;

const ZERO_SIG = new Uint8Array(64);

export function encodeBundle(b: Bundle): StoredBundle {
  // Reuse the mesh's wire encoder so storage and radio share one format. The
  // hop slot is filled with a placeholder and dropped.
  const placeholder = { noteHash: hashNote(b.note), relayer: b.owner, prev: b.owner, seq: 0, at: 0n };
  const { hop: _hop, giverSignature: _sig, ...stored } = encodeOffer({
    bundle: b,
    hop: placeholder,
    giverSignature: ZERO_SIG,
  });
  return stored;
}

export function decodeBundle(x: unknown): Bundle {
  if (!isObj(x)) throw new MeshError("stored bundle is malformed");
  const hops = Array.isArray(x.hops) ? x.hops : [];
  const placeholder = {
    noteHash: Buffer.from(new Uint8Array(32)).toString("base64"),
    relayer: x.owner,
    prev: x.owner,
    seq: hops.length,
    at: "0",
  };
  return parseOffer({ ...x, hop: placeholder, giverSignature: Buffer.from(ZERO_SIG).toString("base64") }).bundle;
}

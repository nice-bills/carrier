import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import {
  MAX_CHAIN,
  MAX_NOTE_LIFETIME_SECONDS,
  hopSigningPayload,
  noteSigningPayload,
  hashNote,
  type Hop,
  type Note,
  type SignatureEntry,
} from "@carrier/protocol";
import { MeshError, type Bundle, type HandoffOffer, type Signer } from "./types.js";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Most notes one device will hold for others before it starts evicting. */
export const MAX_HELD_NOTES = 256;
/** Most notes from any one claimed owner a device will hold for others. */
export const MAX_HELD_PER_OWNER = 16;
/**
 * How far ahead of the receiver's clock a hop's `at` may sit. Phones disagree
 * about the time; a day of skew is tolerated, a timestamp from next month is not.
 */
export const MAX_HOP_CLOCK_SKEW_SECONDS = 86_400n;
/** A relay fee above 100% can never settle, so a bundle claiming one is junk. */
const MAX_RELAY_FEE_BPS = 10_000;

export interface NodeLimits {
  /** Notes held for others before the soonest-expiring is evicted. */
  readonly maxHeld: number;
  /** Notes held for any one claimed owner. */
  readonly maxPerOwner: number;
}

export const DEFAULT_NODE_LIMITS: NodeLimits = {
  maxHeld: MAX_HELD_NOTES,
  maxPerOwner: MAX_HELD_PER_OWNER,
};

/**
 * One device in the mesh.
 *
 * A node holds notes that are not its own. That is the whole point: a payment
 * between two strangers survives because uninvolved people carried it, and they
 * carried it because settlement pays them for having done so.
 *
 * Nothing here touches the network. A node is a pure state machine over bundles
 * so the mesh can be tested without radios — the BLE layer only moves bytes
 * between `prepareHandoff` and `acceptHandoff`.
 *
 * Everything an offer claims is re-verified on receipt — every earlier hop and
 * every signature, not just the newest link — because a node only ever starts
 * holding a note after the whole bundle checks out. A forged bundle therefore
 * cannot occupy the slot that the genuine one for the same note would need.
 */
export class CarrierNode {
  private readonly held = new Map<string, Bundle>();
  /** Notes this device signed itself. Never evicted by the cap. */
  private readonly own = new Set<string>();
  /** Notes addressed to this device. Kept, never passed on, never evicted. */
  private readonly delivered = new Set<string>();
  private readonly limits: NodeLimits;

  constructor(
    private readonly signer: Signer,
    limits: Partial<NodeLimits> = {},
  ) {
    this.limits = { ...DEFAULT_NODE_LIMITS, ...limits };
  }

  get publicKey() {
    return this.signer.publicKey;
  }

  /**
   * Note hashes this device will offer on contact.
   *
   * Notes addressed to this device are left out: the recipient settles them
   * rather than handing them on, because a hop naming the recipient as carrier
   * is one the program refuses to pay.
   */
  digests(): string[] {
    return [...this.held.keys()].filter((k) => !this.delivered.has(k));
  }

  holds(noteHash: string): boolean {
    return this.held.has(noteHash);
  }

  /** Whether a held note is a payment to this device. */
  isForMe(noteHash: string): boolean {
    return this.delivered.has(noteHash);
  }

  /** Hashes of held notes that pay this device, for it to settle. */
  deliveries(): string[] {
    return [...this.delivered];
  }

  bundle(noteHash: string): Bundle | undefined {
    return this.held.get(noteHash);
  }

  get carrying(): number {
    return this.held.size;
  }

  /** Sign a payment against one pouch slot. The sender's device does this offline. */
  originate(note: Note): Bundle {
    const payload = noteSigningPayload(note);
    const signature = this.signer.sign(payload);
    const bundle: Bundle = {
      owner: this.signer.publicKey,
      note,
      hops: [],
      entries: [{ publicKey: this.signer.publicKey, signature, message: payload }],
    };
    const key = hex(hashNote(note));
    this.held.set(key, bundle);
    this.own.add(key);
    return bundle;
  }

  /**
   * Giver's half of a handoff: propose a hop naming the receiver, and sign it.
   *
   * The giver constructs the hop because only it knows the current chain length.
   * `at` is the giver's clock, and the receiver co-signs it, so it is a time both
   * devices agreed to — not proof of when they met. Nothing on-chain checks it
   * beyond a coarse bound, so lineage times are attested, not verified.
   */
  prepareHandoff(noteHash: string, receiver: Signer["publicKey"], at: bigint): HandoffOffer {
    const bundle = this.held.get(noteHash);
    if (!bundle) throw new MeshError(`not carrying ${noteHash.slice(0, 8)}`);
    if (this.delivered.has(noteHash)) {
      throw new MeshError("this note pays this device; it settles it rather than passing it on");
    }

    const delivering = receiver.equals(bundle.note.to);
    if (!delivering) {
      // A delivery to the recipient adds no hop, so only an extension is capped.
      if (bundle.hops.length >= MAX_CHAIN) {
        throw new MeshError(
          `chain is full at ${MAX_CHAIN} hops — settlement could not verify a longer one`,
        );
      }
      checkCarrierEligible(receiver, bundle);
    }

    const hop: Hop = {
      noteHash: hashNote(bundle.note),
      relayer: receiver,
      prev: this.lastCarrier(bundle),
      seq: bundle.hops.length,
      at,
    };

    return { bundle, hop, giverSignature: this.signer.sign(hopSigningPayload(hop)) };
  }

  /**
   * Receiver's half: verify everything, counter-sign, and start carrying it.
   *
   * A device that accepts an unverifiable bundle wastes its own battery carrying
   * something that can never settle, so the checks here are the carrier's own
   * interest rather than a courtesy to the sender.
   *
   * If this device is the note's recipient, the bundle is kept as it arrived —
   * no hop is appended, because the program will not pay the recipient as a
   * carrier — and it is not offered onward.
   *
   * Throws `MeshError` for anything it refuses, including malformed input.
   */
  acceptHandoff(offer: HandoffOffer, now: bigint): Bundle {
    try {
      return this.acceptUnchecked(offer, now);
    } catch (err) {
      if (err instanceof MeshError) throw err;
      throw new MeshError(`malformed offer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private acceptUnchecked(offer: HandoffOffer, now: bigint): Bundle {
    assertOfferShape(offer);
    if (typeof now !== "bigint") throw new MeshError("now must be a bigint");
    const { bundle, hop, giverSignature } = offer;
    const me = this.signer.publicKey;

    // Cheap checks first: a device in a crowd evaluates every offer it hears.
    // hashNote also range-checks every field, so a wrapped value cannot hash
    // like the original.
    const noteHash = hashNote(bundle.note);
    const key = hex(noteHash);

    if (this.held.has(key)) throw new MeshError("already carrying this note");
    if (bundle.note.expiry <= now) throw new MeshError("note has expired");
    if (bundle.note.expiry > now + MAX_NOTE_LIFETIME_SECONDS) {
      throw new MeshError("note claims to stay valid longer than any note can");
    }
    if (bundle.note.relayFeeBps > MAX_RELAY_FEE_BPS) {
      throw new MeshError("relay fee exceeds the note amount");
    }
    if (bundle.hops.length >= MAX_CHAIN && !me.equals(bundle.note.to)) {
      throw new MeshError(`chain is already at ${MAX_CHAIN} hops`);
    }
    if (hop.seq !== bundle.hops.length) throw new MeshError("hop sequence is out of order");
    if (!hop.relayer.equals(me)) throw new MeshError("hop names a different relayer");
    if (!bytesEqual(hop.noteHash, noteHash)) {
      throw new MeshError("hop references a different note");
    }
    if (!hop.prev.equals(this.lastCarrier(bundle))) {
      throw new MeshError("hop chain is broken");
    }
    this.checkHopTime(hop, now);

    const delivering = me.equals(bundle.note.to);
    if (!delivering) checkCarrierEligible(me, bundle);

    // The whole chain, not just the tip: every earlier hop's links and both of
    // its co-signatures, and the note signature against the claimed owner —
    // exactly what the program will check against the real pouch later.
    this.verifyChain(bundle, noteHash, now);

    // And the giver really is who it says it is, standing right here.
    const hopMessage = hopSigningPayload(hop);
    if (!nacl.sign.detached.verify(hopMessage, giverSignature, hop.prev.toBytes())) {
      throw new MeshError("giver's co-signature does not verify");
    }

    const ownerKey = bundle.owner.toBase58();
    if (!delivering) this.makeRoom(ownerKey, bundle.note.expiry);

    const stored: Bundle = delivering
      ? {
          owner: bundle.owner,
          note: bundle.note,
          hops: [...bundle.hops],
          entries: [...bundle.entries],
        }
      : {
          owner: bundle.owner,
          note: bundle.note,
          hops: [...bundle.hops, hop],
          entries: [
            ...bundle.entries,
            { publicKey: hop.relayer, signature: this.signer.sign(hopMessage), message: hopMessage },
            { publicKey: hop.prev, signature: giverSignature, message: hopMessage },
          ],
        };

    this.held.set(key, stored);
    if (delivering) this.delivered.add(key);
    return stored;
  }

  /**
   * Put back a bundle this device held before a restart.
   *
   * Saved storage is not trusted any more than the radio is: the whole chain is
   * re-verified, and the bundle must be one this device could have ended up
   * holding — its own unsent note, a payment to it, or one it carried last.
   */
  restore(bundle: Bundle, now: bigint): void {
    if (typeof now !== "bigint") throw new MeshError("now must be a bigint");
    const me = this.signer.publicKey;
    const noteHash = hashNote(bundle.note);
    const key = hex(noteHash);

    if (this.held.has(key)) return;
    if (bundle.note.expiry <= now) throw new MeshError("note has expired");

    const own = bundle.hops.length === 0 && bundle.owner.equals(me);
    const delivered = me.equals(bundle.note.to);
    if (!own && !delivered && !this.lastCarrier(bundle).equals(me)) {
      throw new MeshError("saved bundle was not held by this device");
    }
    this.verifyChain(bundle, noteHash, now);

    if (!own && !delivered) this.makeRoom(bundle.owner.toBase58(), bundle.note.expiry);
    this.held.set(key, bundle);
    if (own) this.own.add(key);
    if (delivered) this.delivered.add(key);
  }

  /** Drop notes that can no longer settle, so a device stops carrying dead weight. */
  prune(now: bigint): number {
    let dropped = 0;
    for (const [key, bundle] of this.held) {
      if (bundle.note.expiry <= now) {
        this.forget(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Forget a note once it is known to have settled. */
  release(noteHash: string): void {
    this.forget(noteHash);
  }

  private forget(key: string): void {
    this.held.delete(key);
    this.own.delete(key);
    this.delivered.delete(key);
  }

  private lastCarrier(bundle: Bundle) {
    return bundle.hops.length === 0
      ? bundle.owner
      : bundle.hops[bundle.hops.length - 1]!.relayer;
  }

  private checkHopTime(hop: Hop, now: bigint): void {
    // A hop older than any note can live, or from well into the future, is not
    // a timestamp two honest clocks produced.
    if (hop.at < now - MAX_NOTE_LIFETIME_SECONDS || hop.at > now + MAX_HOP_CLOCK_SKEW_SECONDS) {
      throw new MeshError(`hop ${hop.seq} has an implausible timestamp`);
    }
  }

  /**
   * Re-verify a received bundle end to end: `entries` is exactly the note
   * signature followed by (relayer, giver) co-signatures per hop, in hop order,
   * and every one of them verifies over the payload its position implies.
   */
  private verifyChain(bundle: Bundle, noteHash: Uint8Array, now: bigint): void {
    const { hops, entries, owner, note } = bundle;
    if (entries.length !== 1 + 2 * hops.length) {
      throw new MeshError(
        `bundle has ${entries.length} signatures; ${hops.length} hops need ${1 + 2 * hops.length}`,
      );
    }

    verifyEntry(entries[0]!, owner, noteSigningPayload(note), "note signature");

    const relayers: PublicKey[] = [];
    let prev = owner;
    hops.forEach((h, i) => {
      if (h.seq !== i) throw new MeshError(`hop ${i} has sequence ${h.seq}`);
      if (!bytesEqual(h.noteHash, noteHash)) {
        throw new MeshError(`hop ${i} references a different note`);
      }
      if (!h.prev.equals(prev)) throw new MeshError(`hop ${i} does not follow the chain`);
      if (relayers.some((r) => r.equals(h.relayer))) {
        throw new MeshError(`hop ${i} repeats a carrier`);
      }
      if (h.relayer.equals(owner) || h.relayer.equals(note.to)) {
        throw new MeshError(`hop ${i} names the sender or recipient as a carrier`);
      }
      this.checkHopTime(h, now);

      const payload = hopSigningPayload(h);
      verifyEntry(entries[1 + 2 * i]!, h.relayer, payload, `hop ${i} relayer signature`);
      verifyEntry(entries[2 + 2 * i]!, h.prev, payload, `hop ${i} giver signature`);

      relayers.push(h.relayer);
      prev = h.relayer;
    });
  }

  /**
   * Enforce the holding caps before a note held for someone else is stored.
   *
   * Notes this device signed or is owed are never evicted and do not count: the
   * caps exist so strangers cannot fill the device, not to limit its own money.
   */
  private makeRoom(ownerKey: string, expiry: bigint): void {
    const foreign = [...this.held].filter(
      ([k]) => !this.own.has(k) && !this.delivered.has(k),
    );

    const fromOwner = foreign.filter(([, b]) => b.owner.toBase58() === ownerKey).length;
    if (fromOwner >= this.limits.maxPerOwner) {
      throw new MeshError("already carrying as many notes from this sender as allowed");
    }

    if (foreign.length < this.limits.maxHeld) return;

    let soonest: [string, Bundle] | undefined;
    for (const entry of foreign) {
      if (!soonest || entry[1].note.expiry < soonest[1].note.expiry) soonest = entry;
    }
    // Evict only for a note that will be useful for longer; otherwise the newcomer
    // is the one that goes.
    if (!soonest || soonest[1].note.expiry >= expiry) {
      throw new MeshError("carrying as many notes as this device will hold");
    }
    this.forget(soonest[0]);
  }
}

/** The program's carrier rules, applied before a hop is built or signed. */
function checkCarrierEligible(carrier: PublicKey, bundle: Bundle): void {
  if (carrier.equals(bundle.owner)) {
    throw new MeshError("the sender cannot carry their own note");
  }
  if (carrier.equals(bundle.note.to)) {
    throw new MeshError("the recipient cannot be paid as a carrier");
  }
  if (bundle.hops.some((h) => h.relayer.equals(carrier))) {
    throw new MeshError("this device has already carried this note");
  }
}

function verifyEntry(
  entry: SignatureEntry,
  by: PublicKey,
  message: Uint8Array,
  what: string,
): void {
  if (!entry.publicKey.equals(by) || !bytesEqual(entry.message, message)) {
    throw new MeshError(`${what} is missing or out of place`);
  }
  if (!nacl.sign.detached.verify(message, entry.signature, by.toBytes())) {
    throw new MeshError(`${what} does not verify`);
  }
}

const isBytes = (x: unknown, len?: number): x is Uint8Array =>
  x instanceof Uint8Array && (len === undefined || x.length === len);
const isKey = (x: unknown): x is PublicKey => x instanceof PublicKey;

function assertHopShape(h: unknown, what: string): asserts h is Hop {
  const hop = h as Partial<Hop> | null;
  if (
    !hop ||
    typeof hop !== "object" ||
    !isBytes(hop.noteHash, 32) ||
    !isKey(hop.relayer) ||
    !isKey(hop.prev) ||
    typeof hop.seq !== "number" ||
    typeof hop.at !== "bigint"
  ) {
    throw new MeshError(`${what} is malformed`);
  }
}

/** Structural check, so junk fails with a MeshError rather than a TypeError. */
function assertOfferShape(offer: unknown): asserts offer is HandoffOffer {
  const o = offer as Partial<HandoffOffer> | null;
  if (!o || typeof o !== "object") throw new MeshError("offer is malformed");
  const b = o.bundle as Partial<Bundle> | undefined;
  if (!b || typeof b !== "object" || !isKey(b.owner)) throw new MeshError("bundle is malformed");
  const n = b.note as Partial<Note> | undefined;
  if (
    !n ||
    typeof n !== "object" ||
    !isKey(n.pouch) ||
    !isKey(n.to) ||
    typeof n.amount !== "bigint" ||
    typeof n.expiry !== "bigint" ||
    typeof n.slotIndex !== "number" ||
    typeof n.epoch !== "number" ||
    typeof n.relayFeeBps !== "number"
  ) {
    throw new MeshError("note is malformed");
  }
  if (!Array.isArray(b.hops) || b.hops.length > MAX_CHAIN) {
    throw new MeshError("bundle hops are malformed");
  }
  b.hops.forEach((h, i) => assertHopShape(h, `hop ${i}`));
  if (!Array.isArray(b.entries) || b.entries.length > 1 + 2 * MAX_CHAIN) {
    throw new MeshError("bundle signatures are malformed");
  }
  for (const e of b.entries) {
    if (!e || typeof e !== "object" || !isKey(e.publicKey) || !isBytes(e.signature, 64) || !isBytes(e.message)) {
      throw new MeshError("bundle signature entry is malformed");
    }
  }
  assertHopShape(o.hop, "offered hop");
  if (!isBytes(o.giverSignature, 64)) throw new MeshError("giver signature is malformed");
}

/**
 * Run one contact between two devices: exchange digests, hand over what the
 * other is missing. This is what a BLE encounter reduces to once bytes are moving.
 */
export function contact(a: CarrierNode, b: CarrierNode, at: bigint): number {
  let moved = 0;
  for (const [giver, taker] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const digest of giver.digests()) {
      if (taker.holds(digest)) continue;
      try {
        taker.acceptHandoff(giver.prepareHandoff(digest, taker.publicKey, at), at);
        moved += 1;
      } catch {
        // A bundle that will not transfer — full chain, expired, unverifiable,
        // an ineligible carrier — is skipped rather than aborting the encounter.
        // Contacts are brief and one bad note should not cost the others their ride.
      }
    }
  }
  return moved;
}

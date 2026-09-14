import nacl from "tweetnacl";
import {
  MAX_CHAIN,
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
 */
export class CarrierNode {
  private readonly held = new Map<string, Bundle>();

  constructor(private readonly signer: Signer) {}

  get publicKey() {
    return this.signer.publicKey;
  }

  /** Note hashes this device is carrying, for digest exchange on contact. */
  digests(): string[] {
    return [...this.held.keys()];
  }

  holds(noteHash: string): boolean {
    return this.held.has(noteHash);
  }

  bundle(noteHash: string): Bundle | undefined {
    return this.held.get(noteHash);
  }

  get carrying(): number {
    return this.held.size;
  }

  /** Sign a payment against one pouch slot. The sender's device does this offline. */
  originate(note: Note): Bundle {
    const signature = this.signer.sign(noteSigningPayload(note));
    const bundle: Bundle = {
      owner: this.signer.publicKey,
      note,
      hops: [],
      entries: [
        { publicKey: this.signer.publicKey, signature, message: noteSigningPayload(note) },
      ],
    };
    this.held.set(hex(hashNote(note)), bundle);
    return bundle;
  }

  /**
   * Giver's half of a handoff: propose a hop naming the receiver, and sign it.
   *
   * The giver constructs the hop because only it knows the current chain length,
   * and `at` is stamped here so a receiver cannot backdate a handoff it was late to.
   */
  prepareHandoff(noteHash: string, receiver: Signer["publicKey"], at: bigint): HandoffOffer {
    const bundle = this.held.get(noteHash);
    if (!bundle) throw new MeshError(`not carrying ${noteHash.slice(0, 8)}`);
    if (bundle.hops.length >= MAX_CHAIN) {
      throw new MeshError(
        `chain is full at ${MAX_CHAIN} hops — settlement could not verify a longer one`,
      );
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
   */
  acceptHandoff(offer: HandoffOffer, now: bigint): Bundle {
    const { bundle, hop, giverSignature } = offer;
    const noteHash = hashNote(bundle.note);
    const key = hex(noteHash);

    if (this.held.has(key)) throw new MeshError("already carrying this note");
    if (bundle.note.expiry <= now) throw new MeshError("note has expired");
    if (hop.seq !== bundle.hops.length) throw new MeshError("hop sequence is out of order");
    if (!hop.relayer.equals(this.signer.publicKey)) {
      throw new MeshError("hop names a different relayer");
    }
    if (hex(hop.noteHash) !== key) throw new MeshError("hop references a different note");
    if (!hop.prev.equals(this.lastCarrier(bundle))) {
      throw new MeshError("hop chain is broken");
    }

    // The sender really authorised this note. Checked against the claimed owner,
    // which is exactly what the program will do against the real pouch later.
    this.verify(noteSigningPayload(bundle.note), bundle.entries, bundle.owner, "note signature");

    // And the giver really is who it says it is, standing right here.
    const hopMessage = hopSigningPayload(hop);
    if (!nacl.sign.detached.verify(hopMessage, giverSignature, hop.prev.toBytes())) {
      throw new MeshError("giver's co-signature does not verify");
    }

    const mine = this.signer.sign(hopMessage);
    const carried: Bundle = {
      ...bundle,
      hops: [...bundle.hops, hop],
      entries: [
        ...bundle.entries,
        { publicKey: hop.relayer, signature: mine, message: hopMessage },
        { publicKey: hop.prev, signature: giverSignature, message: hopMessage },
      ],
    };

    this.held.set(key, carried);
    return carried;
  }

  /** Drop notes that can no longer settle, so a device stops carrying dead weight. */
  prune(now: bigint): number {
    let dropped = 0;
    for (const [key, bundle] of this.held) {
      if (bundle.note.expiry <= now) {
        this.held.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Forget a note once it is known to have settled. */
  release(noteHash: string): void {
    this.held.delete(noteHash);
  }

  private lastCarrier(bundle: Bundle) {
    return bundle.hops.length === 0
      ? bundle.owner
      : bundle.hops[bundle.hops.length - 1]!.relayer;
  }

  private verify(
    message: Uint8Array,
    entries: SignatureEntry[],
    by: Signer["publicKey"],
    what: string,
  ): void {
    const entry = entries.find(
      (e) => e.publicKey.equals(by) && hex(e.message) === hex(message),
    );
    if (!entry) throw new MeshError(`${what} is missing`);
    if (!nacl.sign.detached.verify(message, entry.signature, by.toBytes())) {
      throw new MeshError(`${what} does not verify`);
    }
  }
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
        // A bundle that will not transfer — full chain, expired, unverifiable —
        // is skipped rather than aborting the encounter. Contacts are brief and
        // one bad note should not cost the others their ride.
      }
    }
  }
  return moved;
}

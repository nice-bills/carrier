import type { PublicKey } from "@solana/web3.js";
import type { Hop, Note, SignatureEntry } from "@carrier/protocol";

/**
 * A note plus everything needed to settle it, as it exists in someone's pocket.
 *
 * `owner` is carried alongside rather than inside the note because the program
 * reads the pouch owner from the pouch account at settlement — it is not part of
 * the signed message. A carrier with no connectivity cannot fetch that account,
 * so the bundle states who the sender claims to be and every carrier verifies
 * the note signature against that claim locally. Lying about it is pointless:
 * the signature simply fails to verify, first at the next handoff and again at
 * settlement.
 */
export interface Bundle {
  owner: PublicKey;
  note: Note;
  hops: Hop[];
  /** Note signature, then two co-signatures per hop, in hop order. */
  entries: SignatureEntry[];
}

/** A key that can sign bytes. On a phone this is backed by the secure element. */
export interface Signer {
  readonly publicKey: PublicKey;
  sign(message: Uint8Array): Uint8Array;
}

/**
 * The giver's half of a handoff.
 *
 * A handoff is two messages over BLE, not one: the giver proposes a hop naming
 * the receiver and signs it, the receiver checks the chain and counter-signs.
 * Both signatures over the same bytes is what makes the hop evidence that two
 * devices were actually in the same place.
 */
export interface HandoffOffer {
  bundle: Bundle;
  hop: Hop;
  giverSignature: Uint8Array;
}

export class MeshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshError";
  }
}

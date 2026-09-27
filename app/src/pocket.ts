import * as FileSystem from "expo-file-system";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { hopSigningPayload, type Hop } from "@carrier/protocol";
import { CarrierNode, MAX_HELD_NOTES, MeshError, type Bundle, type HandoffOffer, type Signer, type Transport } from "@carrier/mesh";
import {
  decodeBundle,
  encodeBundle,
  noteKey,
  verifyBundle,
  verifyOffer,
  type StoredBundle,
} from "./chain";
import type { HandoffServer } from "./transport/nearby";

/**
 * The phone's pocket: the mesh node, what it holds on disk, and the contact
 * flow that moves notes between two authenticated phones.
 *
 * Contact, from the receiver's side (both phones run it, so notes flow both
 * ways):
 *
 *   1. ask the peer for its digests            transport.digests(peer)
 *   2. for each note we do not hold, ask       transport.request(peer, hash)
 *      the peer serves it with                 node.prepareHandoff(hash, us, now)
 *   3. verify the whole chain and accept       node.acceptHandoff(offer, now)
 *   4. send our counter-signature back         transport.acknowledge(...)
 *
 * Held bundles are written to the app's private document directory after
 * every change and reloaded (and re-verified) on launch, so a restart does not
 * drop payments people handed us. Settlement from the phone is out of scope:
 * a bundle stays in the pocket until it expires.
 */

const DIR = `${FileSystem.documentDirectory ?? ""}carrier/`;
const FILE = `${DIR}pocket.json`;
const TMP = `${DIR}pocket.json.tmp`;

/** Notes reloaded from disk at most (the node's own cap applies after that). */
export const MAX_RESTORED = MAX_HELD_NOTES;
/** Notes pulled from one peer in one contact. The rest wait for the next. */
export const MAX_PULL_PER_CONTACT = 16;
/** How long an offer we made stays open for its acknowledgement. */
const OFFER_TTL_MS = 60_000;

interface PocketFile {
  v: 1;
  bundles: StoredBundle[];
  /** Keys this phone has completed a handoff with, for rank. */
  met: string[];
}

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

export interface RestoreReport {
  restored: number;
  /** Stored bundles that no longer verify or have expired, and were dropped. */
  dropped: number;
}

export class Pocket implements HandoffServer {
  private readonly met = new Set<string>();
  /** Hops we offered, awaiting the peer's counter-signature. */
  private readonly offered = new Map<string, { hop: Hop; at: number }>();
  private writing: Promise<void> = Promise.resolve();
  private onChange: () => void = () => {};

  private constructor(
    readonly node: CarrierNode,
    private readonly signer: Signer,
  ) {}

  /** Load the pocket from disk. A missing file is an empty pocket; a corrupt one throws. */
  static async open(signer: Signer): Promise<{ pocket: Pocket; report: RestoreReport }> {
    const pocket = new Pocket(new CarrierNode(signer), signer);
    const report = await pocket.restore();
    return { pocket, report };
  }

  subscribe(fn: () => void) {
    this.onChange = fn;
  }

  /** Bundles held: notes carried for others, then payments to this phone. */
  list(): Bundle[] {
    return [...this.node.digests(), ...this.node.deliveries()]
      .map((d) => this.node.bundle(d))
      .filter((b): b is Bundle => b !== undefined);
  }

  get peopleMet(): number {
    return this.met.size;
  }

  // --- serving a peer (HandoffServer) ---------------------------------------

  digestsFor(_peer: PublicKey): string[] {
    return this.node.digests();
  }

  offerFor(noteHash: string, peer: PublicKey): HandoffOffer {
    // The node refuses to build a hop the program would not pay (a repeated
    // carrier, or the sender as carrier) and hands a note to its recipient
    // without adding a hop.
    const offer = this.node.prepareHandoff(noteHash, peer, nowSeconds());
    this.sweepOffers();
    this.offered.set(`${peer.toBase58()}:${noteHash}`, { hop: offer.hop, at: Date.now() });
    return offer;
  }

  acknowledged(peer: PublicKey, noteHash: string, signature: Uint8Array): void {
    const k = `${peer.toBase58()}:${noteHash}`;
    const open = this.offered.get(k);
    if (!open) return;
    this.offered.delete(k);
    // Only a real counter-signature over the hop we offered counts as a
    // handoff for rank; a bare "ack" from anyone does not.
    if (
      signature.length === 64 &&
      nacl.sign.detached.verify(hopSigningPayload(open.hop), signature, peer.toBytes())
    ) {
      this.meet(peer);
    }
  }

  // --- pulling from a peer ------------------------------------------------

  /** Run one contact with an authenticated peer. Returns how many notes we took. */
  async exchange(transport: Transport, peer: PublicKey): Promise<number> {
    const theirs = await transport.digests(peer);
    const wanted = theirs.filter((d) => !this.node.holds(d)).slice(0, MAX_PULL_PER_CONTACT);
    let taken = 0;
    for (const digest of wanted) {
      try {
        const offer = await transport.request(peer, digest);
        this.accept(offer, peer);
        // Our counter-signature over the hop. ed25519 is deterministic, so for
        // a carried note this is exactly the entry the node just stored; for a
        // delivery (no hop stored) it is a receipt the giver can check.
        const receipt = this.signer.sign(hopSigningPayload(offer.hop));
        await transport.acknowledge(peer, digest, receipt);
        taken += 1;
      } catch {
        // One bad or declined note must not cost the others their ride.
      }
    }
    if (taken) await this.persist();
    return taken;
  }

  /** Verify an offer from `giver` end to end, then take custody of it. */
  accept(offer: HandoffOffer, giver: PublicKey): Bundle {
    const now = nowSeconds();
    verifyOffer(offer, giver, this.signer.publicKey, now);
    const carried = this.node.acceptHandoff(offer, now);
    this.meet(giver);
    this.onChange();
    return carried;
  }

  /** Drop expired notes and save if anything changed. */
  async prune(): Promise<number> {
    const dropped = this.node.prune(nowSeconds());
    if (dropped) {
      this.onChange();
      await this.persist();
    }
    return dropped;
  }

  // --- disk -----------------------------------------------------------------

  /** Write the pocket atomically (temp file, then move). Writes are serialised. */
  persist(): Promise<void> {
    const snapshot: PocketFile = {
      v: 1,
      bundles: this.list().map(encodeBundle),
      met: [...this.met],
    };
    const run = async () => {
      await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
      await FileSystem.writeAsStringAsync(TMP, JSON.stringify(snapshot));
      await FileSystem.moveAsync({ from: TMP, to: FILE });
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  private async restore(): Promise<RestoreReport> {
    if (!FileSystem.documentDirectory) throw new Error("no document directory to keep notes in");
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return { restored: 0, dropped: 0 };

    let parsed: unknown;
    try {
      parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE));
    } catch (e) {
      throw new Error(`the saved pocket is unreadable: ${(e as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as PocketFile).v !== 1) {
      throw new Error("the saved pocket has an unknown format");
    }
    const file = parsed as PocketFile;

    for (const k of Array.isArray(file.met) ? file.met : []) {
      try {
        this.met.add(new PublicKey(k).toBase58());
      } catch {
        // skip a bad entry
      }
    }

    const now = nowSeconds();
    let restored = 0;
    let dropped = 0;
    for (const stored of Array.isArray(file.bundles) ? file.bundles.slice(0, MAX_RESTORED) : []) {
      let bundle: Bundle;
      try {
        bundle = decodeBundle(stored);
        // Re-verify from scratch: the file is ours, but a bundle is only worth
        // carrying if every signature in it still checks out.
        verifyBundle(bundle, now);
        const me = this.signer.publicKey;
        const last = bundle.hops.length ? bundle.hops[bundle.hops.length - 1]!.relayer : bundle.owner;
        if (!last.equals(me) && !bundle.note.to.equals(me)) throw new MeshError("not ours to carry");
        this.node.restore(bundle, now);
      } catch {
        dropped += 1;
        continue;
      }
      restored += 1;
    }
    if (dropped) await this.persist();
    return { restored, dropped };
  }

  private meet(peer: PublicKey) {
    const k = peer.toBase58();
    if (this.met.has(k)) return;
    this.met.add(k);
    this.persist().catch(() => {});
  }

  private sweepOffers() {
    const now = Date.now();
    for (const [k, v] of this.offered) if (now - v.at > OFFER_TTL_MS) this.offered.delete(k);
  }
}

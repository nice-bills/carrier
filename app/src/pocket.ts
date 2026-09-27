import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { MAX_CHAIN, SLOTS_PER_EPOCH, hashNote, hopSigningPayload, type Hop, type Note } from "@carrier/protocol";
import { CarrierNode, MAX_HELD_NOTES, MeshError, type Bundle, type HandoffOffer, type Signer, type Transport } from "@carrier/mesh";
import {
  decodeBundle,
  encodeBundle,
  hex,
  noteKey,
  verifyBundle,
  verifyOffer,
  type StoredBundle,
} from "./chain";
import { formatAmount } from "./amounts";
import { shorten } from "./format";
import {
  noteExpiry,
  parseCached,
  parseSigned,
  spendable,
  splitPayout,
  type CachedPouch,
  type SignedNote,
} from "./ledger";
import type { HandoffServer } from "./transport/nearby";

/**
 * The phone's pocket: the mesh node, what it holds on disk, the phone's own
 * books (pouch, signed slots, unsettled payments), and the contact flow that
 * moves notes between two authenticated phones.
 *
 * Who decides a note moves:
 *
 *   - A note this phone signed goes only to the person it was handed to
 *     (`handTo`), after the confirm sheet. Nobody can pull it otherwise.
 *   - A note this phone carries for someone else can be handed on (`handTo`)
 *     or taken by a nearby person who asks (`pull` on their side). Either way
 *     both phones sign the hop, and once the receiver's counter-signature
 *     arrives the note leaves this pocket.
 *   - A note paid to this phone is never offered. It waits to be settled.
 *
 * Contact, from the receiver's side:
 *
 *   1. ask the peer for its digests            transport.digests(peer)
 *      (or take the ones it just handed us)
 *   2. for each note we do not hold, ask       transport.request(peer, hash)
 *      the peer serves it with                 node.prepareHandoff(hash, us, now)
 *   3. verify the whole chain and accept       node.acceptHandoff(offer, now)
 *   4. send our counter-signature back         transport.acknowledge(...)
 *
 * Everything is written to the pocket's store after every change and re-verified on launch. A pouch slot is written down as used
 * *before* the note is signed, so a crash between the two can waste a slot
 * but never reuse one.
 */

/**
 * Where the pocket is kept. On the phone this is a file in the app's private
 * document directory (`src/store.ts`); tests and the browser demo pass an
 * in-memory one. `write` must be atomic: all of the new text or none of it.
 */
export interface PocketStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/** A store that lives in memory only. For tests and the demo. */
export function memoryStore(initial: string | null = null): PocketStore & { text: string | null } {
  const s = {
    text: initial,
    async read() {
      return s.text;
    },
    async write(text: string) {
      s.text = text;
    },
  };
  return s;
}

/** Notes reloaded from disk at most (the node's own cap applies after that). */
export const MAX_RESTORED = MAX_HELD_NOTES;
/** Notes pulled from one peer in one contact. The rest wait for the next. */
export const MAX_PULL_PER_CONTACT = 16;
/** How long an offer we made stays open for its acknowledgement. */
const OFFER_TTL_MS = 60_000;
/** How long a "hand this to X" stays good if X never asks for it. */
export const HAND_TTL_MS = 60_000;
const MAX_FEED = 80;
const MAX_PASSED = 64;
const MAX_SIGNED = SLOTS_PER_EPOCH * 2;

export type FeedKind =
  | "took" // we took a note someone was carrying
  | "received" // someone handed us a note (to carry)
  | "paid-to-you" // a note addressed to us arrived
  | "handed" // we handed a note on
  | "delivered" // we handed a note to its recipient
  | "signed" // we signed a new payment
  | "settled" // a note we settled landed
  | "settled-elsewhere" // a note we carried or signed settled, by someone else
  | "met" // first completed handoff with someone
  | "nearby"; // someone came into or left range

export interface FeedEvent {
  id: string;
  at: number;
  kind: FeedKind;
  /** Plain sentence, ready for screen and screen reader. */
  text: string;
  /** Short key of the other person, for the avatar. */
  who?: string;
  mine: boolean;
}

/** A note that left this pocket, kept to notice when it settles. */
export interface PassedNote {
  hash: string;
  pouch: string;
  owner: string;
  to: string;
  amount: string;
  epoch: number;
  slot: number;
  expiry: string;
  relayFeeBps: number;
  /** Who took it from us. */
  peer: string;
  at: number;
  /** Our position in the chain: -1 when we signed it, else our hop index. */
  hop: number;
  settled?: boolean;
}

/** Who was paid when a settlement landed, for the receipt. */
export interface SettlementReceipt {
  hash: string;
  amount: string;
  to: string;
  toRecipient: bigint;
  carriers: { key: string; amount: bigint; you: boolean }[];
  kept: bigint;
  signatures: string[];
  bundle: Bundle;
}

interface PocketFile {
  v: 2;
  bundles: StoredBundle[];
  /** Keys this phone has completed a handoff with, for rank. */
  met: string[];
  onboarded: boolean;
  /** The person dismissed the Carry tips. */
  tipsOff?: boolean;
  pouch: CachedPouch | null;
  /** Slots signed on this phone, per `${pouch}:${epoch}`. Never reused. */
  slots: Record<string, number[]>;
  signed: SignedNote[];
  passed: PassedNote[];
  feed: FeedEvent[];
  handedOn: number;
}

export const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

export interface RestoreReport {
  restored: number;
  /** Stored bundles that no longer verify or have expired, and were dropped. */
  dropped: number;
}

export interface PayRequest {
  to: PublicKey;
  amount: bigint;
  relayFeeBps: number;
  /**
   * Picks a free slot given the ones this phone already signed. The app passes
   * `@carrier/client`'s `nextFreeSlot` over the cached pouch.
   */
  pickSlot: (pouch: CachedPouch, used: ReadonlySet<number>) => number | null;
}

export class PayError extends Error {
  constructor(
    readonly code: "no-pouch" | "self" | "too-much" | "epoch-closed" | "no-slot" | "fee" | "disk",
    message: string,
  ) {
    super(message);
    this.name = "PayError";
  }
}

const slotKey = (pouch: string, epoch: number) => `${pouch}:${epoch}`;
const lastCarrierOf = (b: Bundle) => (b.hops.length ? b.hops[b.hops.length - 1]!.relayer : b.owner);

export class Pocket implements HandoffServer {
  private readonly met = new Set<string>();
  /** Hops we offered, awaiting the peer's counter-signature. */
  private readonly offered = new Map<string, { hop: Hop; at: number }>();
  /** Notes the person chose to hand to someone: note hash -> peer. */
  private readonly handing = new Map<string, { peer: string; at: number }>();
  private writing: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: FeedEvent) => void>();
  private feedLog: FeedEvent[] = [];
  private passedLog: PassedNote[] = [];
  private signedLog: SignedNote[] = [];
  private slots: Record<string, number[]> = {};
  private pouchCache: CachedPouch | null = null;
  private handedOnCount = 0;
  private seq = 0;
  onboarded = false;
  tipsOff = false;

  private constructor(
    readonly node: CarrierNode,
    private readonly signer: Signer,
    private readonly store: PocketStore,
  ) {}

  /** Load the pocket from its store. Nothing saved is an empty pocket; a corrupt save throws. */
  static async open(signer: Signer, store: PocketStore): Promise<{ pocket: Pocket; report: RestoreReport }> {
    const pocket = new Pocket(new CarrierNode(signer), signer, store);
    const report = await pocket.restore();
    return { pocket, report };
  }

  get me(): PublicKey {
    return this.signer.publicKey;
  }

  /** Called after any change to what the pocket holds or knows. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called for each new feed event, so the app can announce arrivals and settlements. */
  onEvent(fn: (e: FeedEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  /** Bundles held: notes carried or signed, then payments to this phone. */
  list(): Bundle[] {
    return [...this.node.digests(), ...this.node.deliveries()]
      .map((d) => this.node.bundle(d))
      .filter((b): b is Bundle => b !== undefined);
  }

  get peopleMet(): number {
    return this.met.size;
  }

  hasMet(key: PublicKey | string): boolean {
    return this.met.has(typeof key === "string" ? key : key.toBase58());
  }

  get feed(): readonly FeedEvent[] {
    return this.feedLog;
  }

  get passed(): readonly PassedNote[] {
    return this.passedLog;
  }

  get signed(): readonly SignedNote[] {
    return this.signedLog;
  }

  get pouch(): CachedPouch | null {
    return this.pouchCache;
  }

  get handedOn(): number {
    return this.handedOnCount;
  }

  /** Whether a held note is one this phone signed itself and has not handed over. */
  isOwn(b: Bundle): boolean {
    return b.hops.length === 0 && b.owner.equals(this.me);
  }

  /**
   * Whether a note someone nearby holds is one this phone could take: not one
   * it holds, signed, or already carried. The program refuses a chain that
   * names the same carrier twice, so offering those back only fails.
   */
  couldTake(noteHash: string): boolean {
    return (
      !this.node.holds(noteHash) &&
      !this.passedLog.some((p) => p.hash === noteHash) &&
      !this.signedLog.some((s) => s.hash === noteHash)
    );
  }

  isForMe(b: Bundle): boolean {
    return b.note.to.equals(this.me);
  }

  /** What this phone may still sign for, by its own books. */
  spendable(now = nowSeconds()): bigint {
    return spendable(this.pouchCache, this.signedLog, now);
  }

  /** Slots signed on this phone for the cached pouch's current epoch. */
  usedSlots(): Set<number> {
    const c = this.pouchCache;
    return new Set(c ? this.slots[slotKey(c.address, c.epoch)] ?? [] : []);
  }

  /** Who a note is being handed to right now, if anyone. */
  handingTo(noteHash: string): string | null {
    this.sweepHanding();
    return this.handing.get(noteHash)?.peer ?? null;
  }

  async finishOnboarding(): Promise<void> {
    this.onboarded = true;
    this.changed();
    await this.persist();
  }

  /** Hide the Carry tips for good. */
  async stopTips(): Promise<void> {
    this.tipsOff = true;
    this.changed();
    await this.persist();
  }

  // --- serving a peer (HandoffServer) ---------------------------------------

  /**
   * May `peer` have this note from us? Notes we carry for others, yes.
   * Notes we signed, only if our person handed it to them. Notes paid to us,
   * never (the node already leaves those out).
   */
  private mayServe(noteHash: string, peer: PublicKey): boolean {
    const b = this.node.bundle(noteHash);
    if (!b || this.node.isForMe(noteHash)) return false;
    if (b.owner.equals(this.me) && b.hops.length === 0) {
      this.sweepHanding();
      return this.handing.get(noteHash)?.peer === peer.toBase58();
    }
    return lastCarrierOf(b).equals(this.me);
  }

  digestsFor(peer: PublicKey): string[] {
    return this.node.digests().filter((d) => this.mayServe(d, peer));
  }

  offerFor(noteHash: string, peer: PublicKey): HandoffOffer {
    if (!this.mayServe(noteHash, peer)) throw new MeshError("not offered to this peer");
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
    // Only a real counter-signature over the hop we offered counts: it is the
    // receiver's proof it took the note. A bare "ack" from anyone does not.
    if (
      signature.length !== 64 ||
      !nacl.sign.detached.verify(hopSigningPayload(open.hop), signature, peer.toBytes())
    ) {
      return;
    }
    this.offered.delete(k);
    const bundle = this.node.bundle(noteHash);
    this.meet(peer);
    if (!bundle) return;

    // It is theirs to carry now. Forget it here, but remember enough to notice
    // when it settles and to show what happened.
    const delivered = bundle.note.to.equals(peer);
    const mine = bundle.owner.equals(this.me) && bundle.hops.length === 0;
    this.node.release(noteHash);
    this.handing.delete(noteHash);
    this.handedOnCount += 1;
    this.remember({
      hash: noteHash,
      pouch: bundle.note.pouch.toBase58(),
      owner: bundle.owner.toBase58(),
      to: bundle.note.to.toBase58(),
      amount: bundle.note.amount.toString(),
      epoch: bundle.note.epoch,
      slot: bundle.note.slotIndex,
      expiry: bundle.note.expiry.toString(),
      relayFeeBps: bundle.note.relayFeeBps,
      peer: peer.toBase58(),
      at: Date.now(),
      hop: mine ? -1 : bundle.hops.length - 1,
    });
    const amount = formatAmount(bundle).text;
    this.log(
      delivered ? "delivered" : "handed",
      delivered
        ? `You delivered ${amount} to ${shorten(peer)}. It settles when either phone finds signal.`
        : `You handed ${amount} to ${shorten(peer)}, on its way to ${shorten(bundle.note.to)}.`,
      shorten(peer),
    );
    this.changed();
    this.persist().catch(() => {});
  }

  // --- handing and taking -----------------------------------------------------

  /**
   * Our person confirmed handing this note to `peer`. Records the intent, so
   * `offerFor` will serve it to them; the caller then tells their phone.
   */
  handTo(noteHash: string, peer: PublicKey): void {
    const b = this.node.bundle(noteHash);
    if (!b) throw new MeshError("that payment is no longer in your pocket");
    if (this.node.isForMe(noteHash)) throw new MeshError("this payment is yours; settle it instead of passing it on");
    if (b.owner.equals(peer) && !b.note.to.equals(peer)) throw new MeshError("that is the person who signed it");
    if (!b.note.to.equals(peer) && b.hops.some((h) => h.relayer.equals(peer))) {
      throw new MeshError("they have already carried this one");
    }
    if (!b.note.to.equals(peer) && b.hops.length >= MAX_CHAIN) throw new MeshError("this payment has as many stamps as it can take");
    this.sweepHanding();
    this.handing.set(noteHash, { peer: peer.toBase58(), at: Date.now() });
  }

  /** Drop a pending hand-over, e.g. after the other phone never asked. */
  cancelHand(noteHash: string): void {
    this.handing.delete(noteHash);
  }

  /**
   * Run one contact with an authenticated peer: take the notes it offers, or
   * just `only` these (the ones it said it is handing us). Returns what we took.
   */
  async pull(transport: Transport, peer: PublicKey, only?: string[]): Promise<Bundle[]> {
    const offered = only ?? (await transport.digests(peer));
    const wanted = [...new Set(offered)].filter((d) => this.couldTake(d)).slice(0, MAX_PULL_PER_CONTACT);
    const taken: Bundle[] = [];
    for (const digest of wanted) {
      try {
        const offer = await transport.request(peer, digest);
        const kept = this.accept(offer, peer, only ? "handed" : "took");
        // Our counter-signature over the hop. ed25519 is deterministic, so for
        // a carried note this is exactly the entry the node just stored; for a
        // delivery (no hop stored) it is a receipt the giver can check.
        const receipt = this.signer.sign(hopSigningPayload(offer.hop));
        await transport.acknowledge(peer, digest, receipt);
        taken.push(kept);
      } catch {
        // One bad or declined note must not cost the others their ride.
      }
    }
    if (taken.length) await this.persist().catch(() => {});
    return taken;
  }

  /** @deprecated kept for callers of the old name: takes everything offered. */
  async exchange(transport: Transport, peer: PublicKey): Promise<number> {
    return (await this.pull(transport, peer)).length;
  }

  /** Verify an offer from `giver` end to end, then take custody of it. */
  accept(offer: HandoffOffer, giver: PublicKey, how: "handed" | "took" = "took"): Bundle {
    const now = nowSeconds();
    verifyOffer(offer, giver, this.me, now);
    const carried = this.node.acceptHandoff(offer, now);
    this.meet(giver);
    const amount = formatAmount(carried).text;
    if (carried.note.to.equals(this.me)) {
      this.log("paid-to-you", `${shorten(giver)} handed you ${amount}. It is paid to you; settle it when you have signal.`, shorten(giver));
    } else if (how === "handed") {
      this.log("received", `${shorten(giver)} handed you ${amount} to carry to ${shorten(carried.note.to)}.`, shorten(giver));
    } else {
      this.log("took", `You took ${amount} from ${shorten(giver)}, to carry to ${shorten(carried.note.to)}.`, shorten(giver));
    }
    this.changed();
    return carried;
  }

  // --- paying -------------------------------------------------------------------

  /**
   * Sign a new payment against the cached pouch.
   *
   * Order matters: the slot and the note are written to disk as signed
   * *before* the signature exists. If that write fails nothing is signed. If
   * the app dies after it, the slot is burnt, which costs nothing.
   */
  async pay(req: PayRequest, now = nowSeconds()): Promise<Bundle> {
    const cache = this.pouchCache;
    if (!cache) throw new PayError("no-pouch", "Set up your pouch first. That needs signal once.");
    if (req.to.equals(this.me)) throw new PayError("self", "That is this phone's own key.");
    if (!Number.isInteger(req.relayFeeBps) || req.relayFeeBps < 0 || req.relayFeeBps > 10_000) {
      throw new PayError("fee", "The carriers' share must be between 0% and 100%.");
    }
    if (req.amount <= 0n) throw new PayError("too-much", "Enter an amount above zero.");
    const left = this.spendable(now);
    if (req.amount > left) {
      throw new PayError("too-much", "That is more than your pouch can cover until your other payments settle.");
    }
    const expiry = noteExpiry(now, BigInt(cache.epochStartedAt));
    if (expiry === null) {
      throw new PayError("epoch-closed", "Your pouch's current period has ended. Refresh it when you have signal.");
    }
    const k = slotKey(cache.address, cache.epoch);
    const used = new Set(this.slots[k] ?? []);
    const slot = req.pickSlot(cache, used);
    if (slot === null || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS_PER_EPOCH || used.has(slot)) {
      throw new PayError("no-slot", "Every payment slot in this period is used. Refresh your pouch when you have signal.");
    }

    const note: Note = {
      pouch: new PublicKey(cache.address),
      to: req.to,
      amount: req.amount,
      slotIndex: slot,
      epoch: cache.epoch,
      expiry,
      relayFeeBps: req.relayFeeBps,
    };
    const hash = hex(hashNote(note));

    // 1. Write it down as signed.
    this.slots[k] = [...used, slot];
    const record: SignedNote = {
      hash,
      pouch: cache.address,
      to: req.to.toBase58(),
      epoch: cache.epoch,
      slot,
      amount: req.amount.toString(),
      relayFeeBps: req.relayFeeBps,
      expiry: expiry.toString(),
      at: Date.now(),
    };
    this.signedLog = [...this.signedLog, record].slice(-MAX_SIGNED);
    try {
      await this.persist();
    } catch (e) {
      // Nothing was signed, so the slot can go back.
      this.slots[k] = [...used];
      this.signedLog = this.signedLog.filter((s) => s.hash !== hash);
      throw new PayError("disk", `The phone would not save the payment, so it was not signed: ${(e as Error).message}`);
    }

    // 2. Sign it. The node keeps it as our own until it is handed over.
    const bundle = this.node.originate(note);
    this.log("signed", `You signed ${formatAmount(bundle).text} for ${shorten(req.to)}.`, shorten(req.to));
    this.changed();
    await this.persist().catch(() => {});
    return bundle;
  }

  // --- what the chain says ------------------------------------------------------

  /**
   * A fresh look at this phone's pouch. Marks our signed notes whose slot it
   * shows spent, forgets slot records from epochs it has left behind, and
   * returns the notes newly seen settled.
   */
  observePouch(freshIn: CachedPouch): SignedNote[] {
    const prev = this.pouchCache;
    // Fingerprints are only needed for the moment of checking; not kept on disk.
    const { fingerprints: _fp, ...fresh } = freshIn;
    this.pouchCache = fresh;
    const spent = (i: number) => {
      const w = BigInt(fresh.spent[Math.floor(i / 64)] ?? "0");
      return ((w >> BigInt(i % 64)) & 1n) === 1n;
    };
    const landed: SignedNote[] = [];
    this.signedLog = this.signedLog.map((s) => {
      if (!s.settled && s.pouch === fresh.address && s.epoch === fresh.epoch && spent(s.slot)) {
        landed.push(s);
        return { ...s, settled: true };
      }
      return s;
    });
    // Old epochs cannot settle any more, so their slot lists are dead weight.
    for (const k of Object.keys(this.slots)) {
      const [pouch, epoch] = k.split(":");
      if (pouch === fresh.address && Number(epoch) < fresh.epoch) delete this.slots[k];
    }
    const now = nowSeconds();
    this.signedLog = this.signedLog.filter(
      (s) => !(s.pouch === fresh.address && s.epoch < fresh.epoch) && BigInt(s.expiry) + 86_400n > now,
    );
    for (const s of landed) {
      // If we still hold it (never handed over), it settled some other way: drop it.
      if (this.node.holds(s.hash)) this.node.release(s.hash);
      const passed = this.passedLog.find((p) => p.hash === s.hash);
      if (passed) passed.settled = true;
      this.log("settled-elsewhere", `Your payment to ${shorten(s.to)} settled.`, shorten(s.to));
    }
    if (landed.length || !prev || prev.fetchedAt !== fresh.fetchedAt) {
      this.changed();
      this.persist().catch(() => {});
    }
    return landed;
  }

  /** Pouches whose state would tell us about notes we hold or passed on, for a settlement check. */
  watchedPouches(): string[] {
    const set = new Set<string>();
    for (const b of this.list()) set.add(b.note.pouch.toBase58());
    for (const p of this.passedLog) if (!p.settled) set.add(p.pouch);
    return [...set];
  }

  /**
   * Given another pouch's current state, retire every note we hold or handed
   * on from it whose slot has settled. `verdict` says whether the slot is still
   * open, settled by that very note, or taken by a different note (the sender
   * signed it twice). Returns how many changed.
   */
  observeOther(
    pouch: string,
    epoch: number,
    verdict: (slot: number, noteHash: string) => "open" | "ours" | "other",
  ): number {
    let n = 0;
    for (const b of this.list()) {
      if (b.note.pouch.toBase58() !== pouch || b.note.epoch !== epoch) continue;
      const key = noteKey(b);
      const v = verdict(b.note.slotIndex, key);
      if (v === "open") continue;
      this.node.release(key);
      n += 1;
      if (v === "other") {
        this.log(
          "settled-elsewhere",
          `${formatAmount(b).text} for ${shorten(b.note.to)} can no longer settle: the sender signed its slot twice and another payment took it. The sender's bond pays for that; this phone cannot claim it yet.`,
          shorten(b.owner),
        );
        continue;
      }
      this.log(
        "settled-elsewhere",
        this.isForMe(b)
          ? `${formatAmount(b).text} paid to you has settled.`
          : `${formatAmount(b).text} you were carrying reached ${shorten(b.note.to)}. Someone else settled it.`,
        shorten(b.note.to),
      );
    }
    for (const p of this.passedLog) {
      if (p.settled || p.pouch !== pouch || p.epoch !== epoch || verdict(p.slot, p.hash) !== "ours") continue;
      p.settled = true;
      n += 1;
      const amount = formatAmount({ owner: new PublicKey(p.owner), note: { pouch: new PublicKey(p.pouch), amount: BigInt(p.amount) } } as Bundle).text;
      this.log(
        "settled-elsewhere",
        p.hop >= 0
          ? `${amount} you carried reached ${shorten(p.to)}. Your share was paid to this phone's account.`
          : `${amount} you paid ${shorten(p.to)} has settled.`,
        shorten(p.to),
      );
    }
    if (n) {
      this.changed();
      this.persist().catch(() => {});
    }
    return n;
  }

  /** This phone settled `bundle`. Forget it and log who was paid. */
  settledHere(bundle: Bundle, signatures: string[]): SettlementReceipt {
    const key = noteKey(bundle);
    const split = splitPayout(bundle.note.amount, bundle.note.relayFeeBps, bundle.hops.length);
    this.node.release(key);
    this.signedLog = this.signedLog.map((s) => (s.hash === key ? { ...s, settled: true } : s));
    const receipt: SettlementReceipt = {
      hash: key,
      amount: formatAmount(bundle).text,
      to: bundle.note.to.toBase58(),
      toRecipient: split.toRecipient,
      carriers: bundle.hops.map((h) => ({
        key: h.relayer.toBase58(),
        amount: split.perRelayer,
        you: h.relayer.equals(this.me),
      })),
      kept: split.kept,
      signatures,
      bundle,
    };
    const hands = bundle.hops.length;
    this.log(
      "settled",
      `${receipt.amount} settled: ${this.isForMe(bundle) ? "paid to you" : `paid to ${shorten(bundle.note.to)}`}` +
        (hands ? `, and ${hands} ${hands === 1 ? "carrier" : "carriers"} paid.` : "."),
      shorten(bundle.note.to),
    );
    this.changed();
    this.persist().catch(() => {});
    return receipt;
  }

  /** Someone came into or left range. Logged for the Around feed, not announced. */
  noteNearby(peer: PublicKey, arrived: boolean) {
    this.log("nearby", `${shorten(peer)} ${arrived ? "came into range" : "left range"}.`, shorten(peer), false, true);
  }

  /** Drop expired notes and save if anything changed. */
  async prune(): Promise<number> {
    const dropped = this.node.prune(nowSeconds());
    if (dropped) {
      this.changed();
      await this.persist();
    }
    return dropped;
  }

  // --- disk -----------------------------------------------------------------

  /** Write the pocket atomically (temp file, then move). Writes are serialised. */
  persist(): Promise<void> {
    const snapshot: PocketFile = {
      v: 2,
      bundles: this.list().map(encodeBundle),
      met: [...this.met],
      onboarded: this.onboarded,
      tipsOff: this.tipsOff,
      pouch: this.pouchCache,
      slots: this.slots,
      signed: this.signedLog,
      passed: this.passedLog,
      feed: this.feedLog,
      handedOn: this.handedOnCount,
    };
    const text = JSON.stringify(snapshot);
    const run = () => this.store.write(text);
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  private async restore(): Promise<RestoreReport> {
    const saved = await this.store.read();
    if (saved === null) return { restored: 0, dropped: 0 };

    let parsed: unknown;
    try {
      parsed = JSON.parse(saved);
    } catch (e) {
      throw new Error(`the saved pocket is unreadable: ${(e as Error).message}`);
    }
    const v = typeof parsed === "object" && parsed !== null ? (parsed as { v?: unknown }).v : undefined;
    if (v !== 1 && v !== 2) throw new Error("the saved pocket has an unknown format");
    // v1 had bundles and met only; every other field defaults.
    const file = parsed as Partial<PocketFile> & { v: 1 | 2 };

    for (const k of Array.isArray(file.met) ? file.met : []) {
      try {
        this.met.add(new PublicKey(k).toBase58());
      } catch {
        // skip a bad entry
      }
    }
    // A v1 pocket belongs to someone who already used the app.
    this.onboarded = v === 1 ? true : file.onboarded === true;
    this.tipsOff = file.tipsOff === true;
    this.pouchCache = parseCached(file.pouch);
    this.slots = {};
    if (file.slots && typeof file.slots === "object") {
      for (const [k, list] of Object.entries(file.slots)) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}:\d{1,10}$/.test(k) || !Array.isArray(list)) continue;
        this.slots[k] = list.filter((i) => Number.isInteger(i) && i >= 0 && i < SLOTS_PER_EPOCH);
      }
    }
    this.signedLog = (Array.isArray(file.signed) ? file.signed : [])
      .map(parseSigned)
      .filter((s): s is SignedNote => s !== null)
      .slice(-MAX_SIGNED);
    // Belt and braces: every signed note's slot counts as used, even if the
    // slot list were somehow missing it.
    for (const s of this.signedLog) {
      const k = slotKey(s.pouch, s.epoch);
      const list = this.slots[k] ?? [];
      if (!list.includes(s.slot)) this.slots[k] = [...list, s.slot];
    }
    this.passedLog = (Array.isArray(file.passed) ? file.passed : [])
      .filter((p): p is PassedNote => typeof p === "object" && p !== null && typeof (p as PassedNote).hash === "string")
      .slice(-MAX_PASSED);
    this.feedLog = (Array.isArray(file.feed) ? file.feed : [])
      .filter((e): e is FeedEvent => typeof e === "object" && e !== null && typeof (e as FeedEvent).text === "string")
      .slice(0, MAX_FEED);
    this.handedOnCount = typeof file.handedOn === "number" && file.handedOn >= 0 ? Math.floor(file.handedOn) : 0;

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
        const me = this.me;
        if (!lastCarrierOf(bundle).equals(me) && !bundle.note.to.equals(me)) throw new MeshError("not ours to carry");
        this.node.restore(bundle, now);
      } catch {
        dropped += 1;
        continue;
      }
      restored += 1;
    }
    if (dropped || v === 1) await this.persist();
    return { restored, dropped };
  }

  private log(kind: FeedKind, text: string, who?: string, mine = true, quiet = false) {
    this.seq += 1;
    const e: FeedEvent = { id: `${Date.now()}-${this.seq}`, at: Date.now(), kind, text, who, mine };
    this.feedLog = [e, ...this.feedLog].slice(0, MAX_FEED);
    if (quiet) return;
    for (const fn of this.eventListeners) {
      try {
        fn(e);
      } catch {
        // ignore
      }
    }
  }

  private remember(p: PassedNote) {
    this.passedLog = [...this.passedLog.filter((x) => x.hash !== p.hash), p].slice(-MAX_PASSED);
  }

  private meet(peer: PublicKey) {
    const k = peer.toBase58();
    if (this.met.has(k)) return;
    this.met.add(k);
    this.log("met", `You met ${shorten(peer)}. They count toward your rank.`, shorten(peer));
    this.persist().catch(() => {});
  }

  private sweepOffers() {
    const now = Date.now();
    for (const [k, v] of this.offered) if (now - v.at > OFFER_TTL_MS) this.offered.delete(k);
  }

  private sweepHanding() {
    const now = Date.now();
    for (const [k, v] of this.handing) if (now - v.at > HAND_TTL_MS) this.handing.delete(k);
  }
}

import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { getRandomValues } from "expo-crypto";
import {
  Strategy,
  acceptConnection,
  disconnect,
  onConnected,
  onDisconnected,
  onInvitationReceived,
  onPeerFound,
  onPeerLost,
  onTextReceived,
  rejectConnection,
  requestConnection,
  sendText,
  startAdvertise,
  startDiscovery,
  stopAdvertise,
  stopDiscovery,
  type Unsubscribe,
} from "expo-nearby-connections";
import {
  MTU,
  MeshError,
  encodeOffer,
  frame,
  reassemble,
  type Frame,
  type HandoffOffer,
  type Signer,
  type Transport,
} from "@carrier/mesh";
import { hashNote } from "@carrier/protocol";
import { hex, parseOffer } from "../chain";
import { NONCE_BYTES, authMessage, verifyProof } from "./auth";
import {
  LIMITS,
  NOTE_HASH,
  SESSION_ID,
  parseFrame,
  parseMessage,
  type Message,
} from "./messages";

/**
 * Carrier's radio layer, over Google Nearby Connections
 * (expo-nearby-connections 1.x, a Nitro module).
 *
 * Not BLE directly, and that is deliberate. `react-native-ble-plx` is
 * central-only: it can scan and connect but cannot advertise, so two phones
 * running it never see each other. Nearby Connections does both roles, and
 * its P2P_CLUSTER strategy is many-to-many, which is the shape of a mesh. None
 * of it needs internet: discovery and transfer are local radio.
 *
 * What the library gives us, and what this file adds on top:
 *
 * - Discovery and connection by endpoint id. Every phone both advertises and
 *   discovers; the one with the lower session id requests, the other accepts
 *   the invitation. The service id is the app's package name (the library
 *   sets it; it is not configurable).
 * - UTF-8 text payloads only (`sendText` / `onTextReceived`). Messages are
 *   JSON, split into numbered frames of at most `MTU` bytes (base64 inside the
 *   frame), each under a random transfer id, so interleaved messages cannot mix
 *   and one lost frame costs one message, not the connection.
 * - Authentication. The advertised name is a random session id, not the wallet
 *   key. After connecting, each side challenges the other to sign a fresh nonce
 *   bound to both session ids (see `auth.ts`). Nothing else is accepted from,
 *   or sent to, a peer until its proof verifies.
 * - Limits. Every inbound payload is shape-checked; frame counts, inbox size,
 *   digest lists and frame rate are capped per peer, and a peer that keeps
 *   breaking the rules is disconnected. Every native callback runs inside a
 *   try/catch, because a throw there is fatal in a release build.
 *
 * Android only. iOS Multipeer is a different stack and cannot talk to it.
 */

const STRATEGY = Strategy.P2P_CLUSTER;
/** If the lower-id side has not connected to us by then, we request ourselves. */
const TIE_BREAK_FALLBACK_MS = 4_000;
/** A connected peer that has not proven its key by then is dropped. */
const AUTH_TIMEOUT_MS = 10_000;

/** What the transport asks of the app when a peer wants something from us. */
export interface HandoffServer {
  /** Note hashes to advertise to this (authenticated) peer. */
  digestsFor(peer: PublicKey): string[];
  /** Giver's half of a handoff to this peer. Throw to decline. */
  offerFor(noteHash: string, peer: PublicKey): HandoffOffer;
  /** The peer counter-signed a hop we offered. */
  acknowledged(peer: PublicKey, noteHash: string, signature: Uint8Array): void;
}

export interface TransportEvents {
  /** A peer proved its key. Safe to run an exchange with it now. */
  peerReady?(peer: PublicKey): void;
  peerGone?(peer: PublicKey): void;
  /** An authenticated peer says it is handing us these notes now. */
  handed?(peer: PublicKey, digests: string[]): void;
  /** Something failed inside a radio callback. Already contained; for logging. */
  error?(where: string, e: unknown): void;
}

interface Transfer {
  total: number;
  frames: Frame[];
  bytes: number;
  startedAt: number;
}

interface PeerState {
  endpointId: string;
  session: string;
  /** Nonce we challenged them with, until their proof arrives. */
  nonce: Uint8Array | null;
  /** Their proven key. Null until the proof verifies. */
  key: PublicKey | null;
  /** Whether we already answered their challenge. We answer once. */
  answered: boolean;
  inbox: Map<string, Transfer>;
  inboxBytes: number;
  tokens: number;
  refilledAt: number;
  strikes: number;
}

interface Pending {
  endpointId: string;
  expect: "digests" | "offer";
  digest?: string;
  resolve: (value: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const randomHex = (bytes: number) => hex(getRandomValues(new Uint8Array(bytes)));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export class NearbyTransport implements Transport {
  private subscriptions: Unsubscribe[] = [];
  private session = "";
  private running = false;
  /** Endpoints we discovered, by id, with their advertised session. */
  private readonly discovered = new Map<string, string>();
  /** Connected endpoints. */
  private readonly peersById = new Map<string, PeerState>();
  /** Proven key -> endpoint. Only ever written after a proof verifies. */
  private readonly keyToEndpoint = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly signer: Signer,
    private readonly server: HandoffServer,
    private readonly events: TransportEvents = {},
  ) {}

  /**
   * Start advertising and discovering under a fresh random session id. The
   * `me` argument of the `Transport` interface is ignored: the key is never
   * advertised, only proven to connected peers.
   */
  async advertise(_me?: PublicKey): Promise<void> {
    if (this.running) return;
    this.session = `c1-${randomHex(8)}`;
    this.subscribe();
    this.running = true;
    try {
      await startAdvertise(this.session, STRATEGY);
      await startDiscovery(this.session, STRATEGY);
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  /** Authenticated peers in range. Never throws. */
  async peers(): Promise<PublicKey[]> {
    const out: PublicKey[] = [];
    for (const p of this.peersById.values()) {
      try {
        if (p.key) out.push(p.key);
      } catch {
        // One bad entry must not hide the others.
      }
    }
    return out;
  }

  /** Ask an authenticated peer which notes it carries. */
  async digests(peer: PublicKey): Promise<string[]> {
    const endpointId = this.endpointOf(peer);
    const id = randomHex(8);
    const answer = this.expect(id, endpointId, "digests");
    this.send(endpointId, { kind: "digests?", id });
    return (await answer) as string[];
  }

  /** Ask an authenticated peer to hand over one note, naming us as the next carrier. */
  async request(peer: PublicKey, noteHash: string): Promise<HandoffOffer> {
    if (!NOTE_HASH.test(noteHash)) throw new MeshError("not a note hash");
    const endpointId = this.endpointOf(peer);
    const id = randomHex(8);
    const answer = this.expect(id, endpointId, "offer", noteHash);
    this.send(endpointId, { kind: "want", id, digest: noteHash });
    return (await answer) as HandoffOffer;
  }

  async acknowledge(peer: PublicKey, noteHash: string, signature: Uint8Array): Promise<void> {
    const endpointId = this.keyToEndpoint.get(peer.toBase58());
    if (!endpointId) return;
    this.send(endpointId, { kind: "ack", digest: noteHash, sig: b64(signature) });
  }

  /**
   * Tell an authenticated peer we are handing it these notes, so it asks for
   * them now. Throws if the peer has walked out of range.
   */
  async hand(peer: PublicKey, noteHashes: string[]): Promise<void> {
    const digests = [...new Set(noteHashes)];
    if (digests.length === 0 || digests.length > LIMITS.maxHanded || !digests.every((d) => NOTE_HASH.test(d))) {
      throw new MeshError("nothing valid to hand over");
    }
    this.send(this.endpointOf(peer), { kind: "hand", digests });
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const off of this.subscriptions.splice(0)) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new MeshError("radio stopped"));
      this.pending.delete(id);
    }
    await Promise.allSettled([stopAdvertise(), stopDiscovery(), disconnect()]);
    this.discovered.clear();
    this.peersById.clear();
    this.keyToEndpoint.clear();
  }

  // --- native events --------------------------------------------------------

  private subscribe() {
    if (this.subscriptions.length) return;
    this.subscriptions.push(
      onPeerFound(this.guard("peerFound", ({ peerId, name }) => this.found(peerId, name))),
      onPeerLost(this.guard("peerLost", ({ peerId }) => this.discovered.delete(peerId))),
      onInvitationReceived(
        this.guard("invitation", ({ peerId, name }) => this.invited(peerId, name)),
      ),
      onConnected(this.guard("connected", ({ peerId, name }) => this.connected(peerId, name))),
      onDisconnected(this.guard("disconnected", ({ peerId }) => this.dropped(peerId))),
      onTextReceived(this.guard("text", ({ peerId, text }) => this.receive(peerId, text))),
    );
  }

  /** Every native callback goes through this: a throw there kills a release build. */
  private guard<T>(where: string, fn: (data: T) => void): (data: T) => void {
    return (data: T) => {
      try {
        fn(data);
      } catch (e) {
        try {
          this.events.error?.(where, e);
        } catch {
          // A broken logger must not take the radio down either.
        }
      }
    };
  }

  private found(peerId: string, name: string) {
    if (!this.running || typeof peerId !== "string" || !SESSION_ID.test(name)) return;
    if (name === this.session) return;
    this.discovered.set(peerId, name);
    if (this.peersById.has(peerId)) return;
    // Both phones discover each other; only one should ask, or Nearby may
    // end up with two half-open connections. The lower session id asks, and
    // the other side asks too if nothing has happened after a few seconds.
    if (this.session < name) {
      this.connect(peerId);
    } else {
      this.later(TIE_BREAK_FALLBACK_MS, () => {
        if (this.running && this.discovered.has(peerId) && !this.peersById.has(peerId)) {
          this.connect(peerId);
        }
      });
    }
  }

  private connect(peerId: string) {
    if (this.peersById.size >= LIMITS.maxPeers) return;
    requestConnection(peerId).catch((e) => this.events.error?.("requestConnection", e));
  }

  private invited(peerId: string, name: string) {
    const ok = this.running && SESSION_ID.test(name) && name !== this.session && this.peersById.size < LIMITS.maxPeers;
    // Accepting only opens a pipe: nothing is trusted or sent until the peer
    // proves its key. Refusing malformed names and a full house is cheap.
    (ok ? acceptConnection(peerId) : rejectConnection(peerId)).catch((e) =>
      this.events.error?.("invitation", e),
    );
  }

  private connected(peerId: string, name: string) {
    const session = SESSION_ID.test(name) ? name : this.discovered.get(peerId);
    if (!this.running || !session || session === this.session || this.peersById.size >= LIMITS.maxPeers) {
      disconnect(peerId).catch(() => {});
      return;
    }
    const nonce = getRandomValues(new Uint8Array(NONCE_BYTES));
    this.peersById.set(peerId, {
      endpointId: peerId,
      session,
      nonce,
      key: null,
      answered: false,
      inbox: new Map(),
      inboxBytes: 0,
      tokens: LIMITS.frameBurst,
      refilledAt: Date.now(),
      strikes: 0,
    });
    this.send(peerId, { kind: "challenge", nonce: b64(nonce) });
    // A peer that never proves its key would hold a connection slot forever.
    this.later(AUTH_TIMEOUT_MS, () => {
      const p = this.peersById.get(peerId);
      if (p && !p.key) this.kick(p, "did not authenticate in time");
    });
  }

  private dropped(peerId: string) {
    const peer = this.peersById.get(peerId);
    this.peersById.delete(peerId);
    for (const [id, p] of this.pending) {
      if (p.endpointId === peerId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new MeshError("peer walked out of range"));
      }
    }
    if (peer?.key) {
      const k = peer.key.toBase58();
      if (this.keyToEndpoint.get(k) === peerId) this.keyToEndpoint.delete(k);
      this.events.peerGone?.(peer.key);
    }
  }

  // --- receive path -------------------------------------------------------

  private receive(peerId: string, text: string) {
    const peer = this.peersById.get(peerId);
    if (!peer) return;
    if (!this.spend(peer)) {
      this.kick(peer, "rate limit");
      return;
    }

    const f = parseFrame(text);
    if (!f) return this.strike(peer, "malformed frame");

    const now = Date.now();
    for (const [t, tr] of peer.inbox) {
      if (now - tr.startedAt > LIMITS.transferTtlMs) this.forget(peer, t);
    }

    let transfer = peer.inbox.get(f.t);
    if (!transfer) {
      if (peer.inbox.size >= LIMITS.maxTransfersPerPeer) {
        return this.strike(peer, "too many transfers in flight");
      }
      transfer = { total: f.n, frames: [], bytes: 0, startedAt: now };
      peer.inbox.set(f.t, transfer);
    }
    if (transfer.total !== f.n) {
      this.forget(peer, f.t);
      return this.strike(peer, "frame count changed mid-transfer");
    }
    if (transfer.frames.some((x) => x.index === f.i)) return; // duplicate: harmless

    const payload = unb64(f.p);
    if (payload.length === 0 || payload.length > MTU) return this.strike(peer, "frame size");
    if (peer.inboxBytes + payload.length > LIMITS.maxInboxBytesPerPeer) {
      this.forget(peer, f.t);
      return this.strike(peer, "inbox full");
    }
    transfer.frames.push({ digest: f.t, index: f.i, total: f.n, payload });
    transfer.bytes += payload.length;
    peer.inboxBytes += payload.length;

    if (transfer.frames.length < transfer.total) return;
    const body = reassemble(transfer.frames);
    this.forget(peer, f.t);
    if (!body) return this.strike(peer, "reassembly failed");

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return this.strike(peer, "message is not JSON");
    }
    const message = parseMessage(json);
    if (!message) return this.strike(peer, "unknown or malformed message");
    this.handle(peer, message);
  }

  private handle(peer: PeerState, m: Message) {
    // Before the peer has proven its key, only the handshake is allowed.
    if (m.kind === "challenge") return this.answerChallenge(peer, m.nonce);
    if (m.kind === "prove") return this.checkProof(peer, m.key, m.sig);
    const key = peer.key;
    if (!key) return this.strike(peer, `${m.kind} before authenticating`);

    switch (m.kind) {
      case "digests?": {
        let digests: string[] = [];
        try {
          digests = this.server.digestsFor(key).slice(0, LIMITS.maxDigests);
        } catch (e) {
          this.events.error?.("digestsFor", e);
        }
        this.send(peer.endpointId, { kind: "digests", id: m.id, digests });
        return;
      }
      case "want": {
        let offer: HandoffOffer;
        try {
          offer = this.server.offerFor(m.digest, key);
        } catch {
          // Chain full, expired, not carrying it, or they may not carry it.
          this.send(peer.endpointId, { kind: "nope", id: m.id });
          return;
        }
        this.send(peer.endpointId, { kind: "offer", id: m.id, body: encodeOffer(offer) });
        return;
      }
      case "digests":
      case "offer":
      case "nope":
        return this.settle(peer, m);
      case "hand": {
        try {
          this.events.handed?.(key, m.digests);
        } catch (e) {
          this.events.error?.("handed", e);
        }
        return;
      }
      case "ack": {
        try {
          this.server.acknowledged(key, m.digest, unb64(m.sig));
        } catch (e) {
          this.events.error?.("acknowledged", e);
        }
        return;
      }
    }
  }

  private answerChallenge(peer: PeerState, nonceB64: string) {
    if (peer.answered) return this.strike(peer, "second challenge");
    const nonce = unb64(nonceB64);
    if (nonce.length !== NONCE_BYTES) return this.strike(peer, "bad nonce");
    peer.answered = true;
    const me = this.signer.publicKey;
    const sig = this.signer.sign(authMessage(nonce, this.session, peer.session, me));
    this.send(peer.endpointId, { kind: "prove", key: me.toBase58(), sig: b64(sig) });
  }

  private checkProof(peer: PeerState, keyText: string, sigB64: string) {
    const nonce = peer.nonce;
    if (!nonce || peer.key) return this.strike(peer, "unexpected proof");
    peer.nonce = null; // one attempt per connection
    let key: PublicKey;
    try {
      key = new PublicKey(keyText);
    } catch {
      return this.kick(peer, "proof names an invalid key");
    }
    if (key.equals(this.signer.publicKey)) return this.kick(peer, "peer claims our own key");
    const message = authMessage(nonce, peer.session, this.session, key);
    if (!verifyProof(message, unb64(sigB64), key)) return this.kick(peer, "proof does not verify");

    peer.key = key;
    const k = key.toBase58();
    const previous = this.keyToEndpoint.get(k);
    if (previous && previous !== peer.endpointId) {
      // Same key on a new connection (walked out and back in): the old
      // endpoint is stale.
      const stale = this.peersById.get(previous);
      if (stale) stale.key = null;
      disconnect(previous).catch(() => {});
    }
    this.keyToEndpoint.set(k, peer.endpointId);
    this.events.peerReady?.(key);
  }

  /** Resolve the request a reply answers. Keyed by request id, not by peer. */
  private settle(peer: PeerState, m: Extract<Message, { kind: "digests" | "offer" | "nope" }>) {
    const p = this.pending.get(m.id);
    if (!p || p.endpointId !== peer.endpointId) return this.strike(peer, "unsolicited reply");
    this.pending.delete(m.id);
    clearTimeout(p.timer);

    if (m.kind === "nope") return p.reject(new MeshError("peer declined"));
    if (m.kind === "digests") {
      return p.expect === "digests" ? p.resolve(m.digests) : p.reject(new MeshError("wrong reply"));
    }
    if (p.expect !== "offer") return p.reject(new MeshError("wrong reply"));
    try {
      const offer = parseOffer(m.body);
      if (hex(hashNote(offer.bundle.note)) !== p.digest) {
        throw new MeshError("offer is for a different note");
      }
      p.resolve(offer);
    } catch (e) {
      this.strike(peer, "bad offer");
      p.reject(e instanceof Error ? e : new MeshError("bad offer"));
    }
  }

  // --- send path ------------------------------------------------------------

  private send(endpointId: string, message: Message) {
    let frames: Frame[];
    try {
      frames = frame(randomHex(8), new TextEncoder().encode(JSON.stringify(message)));
    } catch (e) {
      this.events.error?.("send", e); // too large for MAX_FRAMES: never sent
      return;
    }
    if (frames.length > LIMITS.maxFrames) {
      this.events.error?.("send", new MeshError(`message too large (${frames.length} frames)`));
      return;
    }
    for (const f of frames) {
      const text = JSON.stringify({ v: 1, t: f.digest, i: f.index, n: f.total, p: b64(f.payload) });
      sendText(endpointId, text).catch((e) => this.events.error?.("sendText", e));
    }
  }

  // --- bookkeeping ----------------------------------------------------------

  private endpointOf(peer: PublicKey): string {
    const endpointId = this.keyToEndpoint.get(peer.toBase58());
    if (!endpointId) throw new MeshError("peer is out of range");
    return endpointId;
  }

  private expect(id: string, endpointId: string, expect: Pending["expect"], digest?: string) {
    if (this.pending.size >= LIMITS.maxPending) {
      return Promise.reject(new MeshError("too many requests in flight"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new MeshError("peer did not answer in time"));
      }, LIMITS.requestTimeoutMs);
      this.pending.set(id, { endpointId, expect, digest, resolve, reject, timer });
    });
  }

  private spend(peer: PeerState): boolean {
    const now = Date.now();
    const refill = ((now - peer.refilledAt) / 1000) * LIMITS.framesPerSecond;
    peer.tokens = Math.min(LIMITS.frameBurst, peer.tokens + refill);
    peer.refilledAt = now;
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }

  private forget(peer: PeerState, transferId: string) {
    const t = peer.inbox.get(transferId);
    if (!t) return;
    peer.inboxBytes -= t.bytes;
    peer.inbox.delete(transferId);
  }

  private strike(peer: PeerState, why: string) {
    peer.strikes += 1;
    if (peer.strikes >= LIMITS.maxStrikes) this.kick(peer, `too many bad messages (last: ${why})`);
  }

  private kick(peer: PeerState, why: string) {
    this.events.error?.("kick", new MeshError(why));
    disconnect(peer.endpointId).catch(() => {});
    this.dropped(peer.endpointId);
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        fn();
      } catch (e) {
        this.events.error?.("timer", e);
      }
    }, ms);
    this.timers.add(t);
  }
}

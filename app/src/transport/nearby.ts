import type { PublicKey } from "@solana/web3.js";
import {
  startAdvertise,
  startDiscovery,
  stopAdvertise,
  stopDiscovery,
  requestConnection,
  acceptConnection,
  sendPayload,
  onEndpointFound,
  onEndpointLost,
  onConnectionInitiated,
  onConnected,
  onDisconnected,
  onPayloadReceived,
} from "expo-nearby-connections";
import {
  frame,
  reassemble,
  encodeOffer,
  decodeOffer,
  type Frame,
  type HandoffOffer,
  type Transport,
} from "@carrier/mesh";

/**
 * Carrier's radio layer, over Google Nearby Connections.
 *
 * Not BLE directly, and that is deliberate. `react-native-ble-plx` — the obvious
 * choice — is central-only: it can scan and connect to peripherals but cannot
 * advertise, so two phones running it can never see each other. That has been
 * open since 2018 and is not a configuration mistake, it is the library's scope.
 *
 * Nearby Connections does both roles, and its P2P_CLUSTER strategy is
 * many-to-many by design — which is the shape of a mesh. It also negotiates
 * Bluetooth and Wi-Fi Direct underneath, so throughput and range are better than
 * raw BLE would give us. None of this requires internet: discovery and transfer
 * are entirely local radio.
 *
 * Android only. iOS Nearby is restricted enough that supporting it would cost a
 * day and return nothing for a demo.
 */

const SERVICE_ID = "xyz.carrier.mesh.v1";

type Unsubscribe = () => void;

/** What one peer sends another. Kept small; large bodies are framed. */
type Wire =
  | { kind: "digests"; digests: string[] }
  | { kind: "want"; digest: string }
  | { kind: "offer"; digest: string; body: string }
  | { kind: "ack"; digest: string; signature: string };

const encode = (m: Wire) => new TextEncoder().encode(JSON.stringify(m));
const decode = (b: Uint8Array): Wire => JSON.parse(new TextDecoder().decode(b));

export class NearbyTransport implements Transport {
  private readonly subscriptions: Unsubscribe[] = [];
  /** endpointId -> that peer's Carrier public key, once it introduces itself. */
  private readonly peerKeys = new Map<string, string>();
  private readonly keyToEndpoint = new Map<string, string>();
  /** Partial transfers, keyed by endpoint + digest. */
  private readonly inbox = new Map<string, Frame[]>();
  /** Resolvers for requests still in flight. */
  private readonly pending = new Map<string, (value: never) => void>();

  private digestsOf: () => string[] = () => [];
  private offerFor: ((digest: string, peer: string) => HandoffOffer) | null = null;

  constructor(private readonly me: PublicKey) {}

  /**
   * Wire the node in. The transport does not own mesh state — it asks for
   * digests when a peer wants them and hands back whatever the node produces,
   * so all the rules about what is a valid handoff stay in `CarrierNode`.
   */
  bind(
    digests: () => string[],
    offerFor: (digest: string, peer: string) => HandoffOffer,
  ) {
    this.digestsOf = digests;
    this.offerFor = offerFor;
  }

  async advertise(): Promise<void> {
    // The advertised name is our public key: peers need it to build a hop
    // naming us, and there is nothing private about a public key.
    await startAdvertise(this.me.toBase58(), SERVICE_ID);
    await startDiscovery(this.me.toBase58(), SERVICE_ID);

    this.subscriptions.push(
      onEndpointFound(({ endpointId, endpointName }) => {
        this.peerKeys.set(endpointId, endpointName);
        this.keyToEndpoint.set(endpointName, endpointId);
        // Both sides request; Nearby resolves the duplicate itself.
        requestConnection(this.me.toBase58(), endpointId).catch(() => {});
      }),

      onEndpointLost(({ endpointId }) => {
        const key = this.peerKeys.get(endpointId);
        if (key) this.keyToEndpoint.delete(key);
        this.peerKeys.delete(endpointId);
      }),

      // Accepted unconditionally: there is nothing to authenticate at this
      // layer. A handoff is only worth anything once its signatures check out,
      // and that happens in the node, not here.
      onConnectionInitiated(({ endpointId }) => {
        acceptConnection(endpointId).catch(() => {});
      }),

      onConnected(({ endpointId }) => {
        this.send(endpointId, { kind: "digests", digests: this.digestsOf() });
      }),

      onDisconnected(({ endpointId }) => {
        for (const key of [...this.inbox.keys()]) {
          if (key.startsWith(`${endpointId}:`)) this.inbox.delete(key);
        }
      }),

      onPayloadReceived(({ endpointId, payload }) => {
        this.receive(endpointId, payload as unknown as Uint8Array);
      }),
    );
  }

  async peers(): Promise<PublicKey[]> {
    const { PublicKey: PK } = await import("@solana/web3.js");
    return [...this.peerKeys.values()].map((k) => new PK(k));
  }

  async digests(peer: PublicKey): Promise<string[]> {
    const endpoint = this.keyToEndpoint.get(peer.toBase58());
    if (!endpoint) throw new Error("peer is out of range");
    this.send(endpoint, { kind: "digests", digests: this.digestsOf() });
    return [];
  }

  async request(peer: PublicKey, noteHash: string): Promise<HandoffOffer> {
    const endpoint = this.keyToEndpoint.get(peer.toBase58());
    if (!endpoint) throw new Error("peer is out of range");
    this.send(endpoint, { kind: "want", digest: noteHash });
    // The offer arrives asynchronously; `onOffer` resolves it.
    return new Promise((resolve) => {
      this.pending.set(`${endpoint}:${noteHash}`, resolve as never);
    });
  }

  async acknowledge(
    peer: PublicKey,
    noteHash: string,
    signature: Uint8Array,
  ): Promise<void> {
    const endpoint = this.keyToEndpoint.get(peer.toBase58());
    if (!endpoint) return;
    this.send(endpoint, {
      kind: "ack",
      digest: noteHash,
      signature: Buffer.from(signature).toString("base64"),
    });
  }

  async stop(): Promise<void> {
    for (const off of this.subscriptions.splice(0)) off();
    await Promise.allSettled([stopAdvertise(), stopDiscovery()]);
    this.peerKeys.clear();
    this.keyToEndpoint.clear();
    this.inbox.clear();
  }

  // --- internals ---------------------------------------------------------

  private send(endpointId: string, message: Wire) {
    const body = encode(message);
    // Nearby will happily take a large payload, but chunking keeps a transfer
    // interruptible: people walk out of range mid-handoff constantly.
    for (const f of frame(messageDigest(message), body)) {
      sendPayload(endpointId, JSON.stringify({
        d: f.digest,
        i: f.index,
        n: f.total,
        p: Buffer.from(f.payload).toString("base64"),
      })).catch(() => {});
    }
  }

  private receive(endpointId: string, raw: Uint8Array) {
    let parsed: { d: string; i: number; n: number; p: string };
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return; // not ours, or truncated beyond use
    }

    const key = `${endpointId}:${parsed.d}`;
    const frames = this.inbox.get(key) ?? [];
    frames.push({
      digest: parsed.d,
      index: parsed.i,
      total: parsed.n,
      payload: Uint8Array.from(Buffer.from(parsed.p, "base64")),
    });
    this.inbox.set(key, frames);

    const body = reassemble(frames);
    if (!body) return; // still waiting on frames
    this.inbox.delete(key);

    this.handle(endpointId, decode(body));
  }

  private handle(endpointId: string, message: Wire) {
    const peerKey = this.peerKeys.get(endpointId);
    if (!peerKey) return;

    switch (message.kind) {
      case "digests": {
        // Ask for anything we are not already carrying. The node decides what
        // it wants; the transport only moves bytes.
        const mine = new Set(this.digestsOf());
        for (const digest of message.digests) {
          if (!mine.has(digest)) {
            this.send(endpointId, { kind: "want", digest });
          }
        }
        break;
      }

      case "want": {
        if (!this.offerFor) return;
        try {
          const offer = this.offerFor(message.digest, peerKey);
          this.send(endpointId, {
            kind: "offer",
            digest: message.digest,
            body: JSON.stringify(encodeOffer(offer)),
          });
        } catch {
          // Chain full, note expired, not carrying it — nothing to send, and
          // no reason to tell the peer why.
        }
        break;
      }

      case "offer": {
        const resolve = this.pending.get(`${endpointId}:${message.digest}`);
        if (!resolve) return;
        this.pending.delete(`${endpointId}:${message.digest}`);
        resolve(decodeOffer(JSON.parse(message.body)) as never);
        break;
      }

      case "ack":
        // The receiver took it. Nothing to do: our own copy is unchanged and
        // the hop they built is theirs to carry.
        break;
    }
  }
}

/** Frames are keyed by content so two concurrent transfers cannot interleave. */
function messageDigest(m: Wire): string {
  return m.kind === "digests" ? `dig-${Date.now()}` : `${m.kind}-${m.digest}`;
}

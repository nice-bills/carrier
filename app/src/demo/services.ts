import { Keypair, PublicKey, VersionedTransaction, type Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { hashNote, type Note } from "@carrier/protocol";
import { CarrierNode, type Bundle, type HandoffOffer, type Transport } from "@carrier/mesh";
import { PROGRAM_ID } from "../amounts";
import { hex } from "../chain";
import { MINT, MINT_DECIMALS } from "../config";
import { firstFreeSlot, type CachedPouch } from "../ledger";
import { Pocket, memoryStore, nowSeconds } from "../pocket";
import type { AppWallet, ChainService, Radio, RadioEvents, Services } from "../services/types";

/**
 * In-memory stand-ins for the device, so the whole app runs in a browser (or
 * Node) with sample data. Nothing here touches a keystore, a file, a radio or
 * the network, and nothing is faked about the payments themselves: every slip
 * is a real signed bundle, every handoff is really co-signed, and the "other
 * phones" are real `Pocket`s running the same code, joined by a function call
 * instead of radio.
 */

export interface DemoOptions {
  /** Start with no key on the phone (onboarding from the start). */
  noKey?: boolean;
  /** Key exists but first run is not finished. */
  notOnboarded?: boolean;
  /** No pouch set up yet. */
  noPouch?: boolean;
  /** Pretend there is no signal. */
  offline?: boolean;
  /** Nobody in range. */
  alone?: boolean;
}

const seeded = (n: number) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n * 31 + 11) & 255));

class DemoWallet implements AppWallet {
  constructor(private readonly kp: Keypair) {}
  get publicKey() {
    return this.kp.publicKey;
  }
  get label() {
    const s = this.kp.publicKey.toBase58();
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
  }
  sign(message: Uint8Array) {
    return nacl.sign.detached(message, this.kp.secretKey);
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    return tx;
  }
}

export const pouchOf = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode("pouch"), owner.toBytes(), MINT.toBytes()], PROGRAM_ID)[0];

const units = (whole: number) => BigInt(Math.round(whole * 10 ** MINT_DECIMALS));

/** The cast. Keys are fixed so screenshots are stable. */
export const cast = {
  me: seeded(1),
  ama: seeded(2),
  chidi: seeded(3),
  mei: seeded(4),
  zanele: seeded(5),
  kofi: seeded(6),
  tunde: seeded(7),
};

function note(owner: Keypair, to: PublicKey, amount: number, slot: number, feeBps = 200): Note {
  const now = nowSeconds();
  return {
    pouch: pouchOf(owner.publicKey),
    to,
    amount: units(amount),
    slotIndex: slot,
    epoch: 1,
    expiry: now + 6n * 86_400n,
    relayFeeBps: feeBps,
  };
}

/** Walk a note through a chain of phones, returning the last one's node and the hash. */
function carry(owner: Keypair, n: Note, via: Keypair[], minutesAgo: number[]): { node: CarrierNode; hash: string; holder: Keypair } {
  const now = nowSeconds();
  let node = new CarrierNode(new DemoWallet(owner));
  node.originate(n);
  const hash = hex(hashNote(n));
  let holder = owner;
  via.forEach((k, i) => {
    const next = new CarrierNode(new DemoWallet(k));
    const at = now - BigInt((minutesAgo[i] ?? 5) * 60);
    next.acceptHandoff(node.prepareHandoff(hash, k.publicKey, at), now);
    node = next;
    holder = k;
  });
  return { node, hash, holder };
}

function myPouch(): CachedPouch {
  const spent = 0b1011n; // slots 0, 1 and 3 settled earlier this epoch
  return {
    address: pouchOf(cast.me.publicKey).toBase58(),
    owner: cast.me.publicKey.toBase58(),
    mint: MINT.toBase58(),
    committed: units(25).toString(),
    settled: units(3).toString(),
    bond: units(5).toString(),
    epoch: 1,
    epochStartedAt: (nowSeconds() - 3n * 86_400n).toString(),
    spent: [spent.toString(), "0", "0", "0"],
    available: units(22).toString(),
    fetchedAt: Date.now() - 4 * 60_000,
  };
}

/** A remote phone: its pocket, and a transport that reaches our pocket by function call. */
interface Remote {
  key: Keypair;
  pocket: Pocket;
}

function linkTo(server: Pocket, client: PublicKey): Transport {
  return {
    advertise: async () => {},
    peers: async () => [],
    digests: async () => server.digestsFor(client),
    request: async (_peer, hash) => server.offerFor(hash, client),
    acknowledge: async (_peer, hash, sig) => server.acknowledged(client, hash, sig),
    stop: async () => {},
  };
}

class DemoRadio implements Radio {
  private on = false;
  constructor(
    private readonly me: PublicKey,
    private readonly mine: Pocket,
    private readonly remotes: Remote[],
    private readonly events: RadioEvents,
  ) {}
  private remote(peer: PublicKey): Remote {
    const r = this.remotes.find((x) => x.key.publicKey.equals(peer));
    if (!r || !this.on) throw new Error("peer is out of range");
    return r;
  }
  async advertise() {
    this.on = true;
    // People arrive one at a time, as they would.
    this.remotes.forEach((r, i) => setTimeout(() => this.on && this.events.peerReady?.(r.key.publicKey), 150 + i * 250));
  }
  async peers() {
    return this.on ? this.remotes.map((r) => r.key.publicKey) : [];
  }
  async digests(peer: PublicKey) {
    return this.remote(peer).pocket.digestsFor(this.me);
  }
  async request(peer: PublicKey, hash: string): Promise<HandoffOffer> {
    return this.remote(peer).pocket.offerFor(hash, this.me);
  }
  async acknowledge(peer: PublicKey, hash: string, sig: Uint8Array) {
    this.remote(peer).pocket.acknowledged(this.me, hash, sig);
  }
  async hand(peer: PublicKey, hashes: string[]) {
    const r = this.remote(peer);
    // Their phone asks for exactly these, over the "radio".
    setTimeout(() => {
      r.pocket.pull(linkTo(this.mine, r.key.publicKey), this.me, hashes).catch(() => {});
    }, 600);
  }
  async stop() {
    this.on = false;
  }
}

function demoChain(opts: DemoOptions, state: { pouch: CachedPouch | null }): ChainService {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    cluster: "devnet",
    probe: async () => !opts.offline,
    pouchAddress: (owner) => pouchOf(owner),
    async fetchPouch(address) {
      if (opts.offline) throw new Error("no signal");
      return state.pouch && state.pouch.address === address.toBase58() ? { ...state.pouch, fetchedAt: Date.now() } : null;
    },
    nextFreeSlot: (p, used) => firstFreeSlot(p.spent, used),
    balances: async () => ({ sol: 1_200_000_000n, token: units(40) }),
    async settle(_wallet, bundle: Bundle) {
      await wait(900);
      if (state.pouch && bundle.owner.equals(cast.me.publicKey)) {
        const w = BigInt(state.pouch.spent[0]!) | (1n << BigInt(bundle.note.slotIndex));
        state.pouch = { ...state.pouch, spent: [w.toString(), "0", "0", "0"] };
      }
      return { signatures: ["5DemoSettLeMentSigNatureXyZ1111111111111111111111111111111111111"] };
    },
    async openPouch(wallet, amount, bond) {
      await wait(1200);
      state.pouch = { ...myPouch(), owner: wallet.publicKey.toBase58(), committed: amount.toString(), available: amount.toString(), settled: "0", bond: bond.toString(), spent: ["0", "0", "0", "0"], epochStartedAt: nowSeconds().toString() };
      return "5DemoOpenPouch";
    },
    airdrop: async () => {
      await wait(600);
    },
    explain: (e) => (e instanceof Error ? e.message : String(e)),
  };
}

/**
 * Build the demo device. The phone holds two slips (one it carries, one paid
 * to it); three people are in range: Chidi (met before), Mei (holding a
 * payment you could take) and Zanele (who the carried slip is for).
 */
export function demoServices(opts: DemoOptions = {}): Services {
  const state = { pouch: opts.noPouch ? null : myPouch() };
  let keyMade = !opts.noKey;
  const wallet = new DemoWallet(cast.me);
  let remotes: Remote[] | null = null;

  const setUpRemotes = async (mine: Pocket) => {
    if (remotes) return remotes;
    const made: Remote[] = [];
    for (const key of opts.alone ? [] : [cast.chidi, cast.mei, cast.zanele]) {
      made.push({ key, pocket: (await Pocket.open(new DemoWallet(key), memoryStore())).pocket });
    }
    // Mei is carrying a payment from Tunde to Kofi, and would hand it to you.
    const mei = made.find((r) => r.key === cast.mei);
    if (mei) {
      const { node, hash } = carry(cast.tunde, note(cast.tunde, cast.kofi.publicKey, 7.5, 12), [cast.ama], [70]);
      mei.pocket.accept(node.prepareHandoff(hash, cast.mei.publicKey, nowSeconds()), cast.ama.publicKey);
    }
    remotes = made;
    void mine;
    return made;
  };

  const seedPocket = async (p: Pocket) => {
    if (state.pouch) p.observePouch({ ...state.pouch });
    if (p.list().length) return;
    // Carried: Ama -> Chidi -> you, for Zanele.
    const a = carry(cast.ama, note(cast.ama, cast.zanele.publicKey, 12, 4), [cast.chidi], [34]);
    p.accept(a.node.prepareHandoff(a.hash, cast.me.publicKey, nowSeconds()), cast.chidi.publicKey, "handed");
    // Paid to you: Kofi -> Mei -> you.
    const b = carry(cast.kofi, note(cast.kofi, cast.me.publicKey, 4.2, 9, 100), [cast.mei], [18]);
    p.accept(b.node.prepareHandoff(b.hash, cast.me.publicKey, nowSeconds()), cast.mei.publicKey, "handed");
  };

  return {
    async existingWallet() {
      return keyMade ? wallet : null;
    },
    async createWallet() {
      keyMade = true;
      return wallet;
    },
    async openPocket(w) {
      const { pocket, report } = await Pocket.open(w, memoryStore());
      if (!opts.notOnboarded && !opts.noKey) {
        await seedPocket(pocket);
        await pocket.finishOnboarding();
      } else if (state.pouch) {
        pocket.observePouch({ ...state.pouch });
      }
      await setUpRemotes(pocket);
      return { pocket, report };
    },
    requestRadioPermissions: async () => ({ granted: true, blocked: false }),
    radioUnavailable: async () => null,
    createRadio(w, pocket, events) {
      return new DemoRadio(w.publicKey, pocket, remotes ?? [], events);
    },
    chain: demoChain(opts, state),
    openSettings: () => {},
    openUrl: () => {},
    share: async () => {},
  };
}

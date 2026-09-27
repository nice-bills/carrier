/**
 * Test helpers: real mesh bundles and an in-memory connection. Not exported
 * from the package entry point.
 */
import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";
import { hashNote, SLOTS_PER_EPOCH, type Note } from "@carrier/protocol";
import { CarrierNode, type Bundle, type Signer } from "@carrier/mesh";
import { ACCOUNT_DISCRIMINATORS, POUCH_ACCOUNT_SIZE } from "./accounts.js";
import { PROGRAM_ID } from "./pda.js";

export function device(seed?: number): Signer & { keypair: Keypair } {
  const keypair = seed === undefined ? Keypair.generate() : Keypair.fromSeed(new Uint8Array(32).fill(seed));
  return {
    keypair,
    publicKey: keypair.publicKey,
    sign: (m: Uint8Array) => nacl.sign.detached(m, keypair.secretKey),
  };
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Originate `note` on the owner's node and hand it down `chain`, as phones would. */
export function carry(owner: Signer, note: Note, chain: Signer[], at: bigint): Bundle {
  const origin = new CarrierNode(owner);
  let bundle = origin.originate(note);
  let giver = origin;
  const key = hex(hashNote(note));
  for (const d of chain) {
    const taker = new CarrierNode(d);
    bundle = taker.acceptHandoff(giver.prepareHandoff(key, d.publicKey, at), at);
    giver = taker;
  }
  return bundle;
}

export interface PouchFields {
  owner: PublicKey;
  mint: PublicKey;
  committed: bigint;
  settled: bigint;
  bond: bigint;
  epoch: number;
  epochStartedAt: bigint;
  spent: bigint[];
  settledFingerprints?: bigint[];
  bump: number;
  vaultBump: number;
}

/** Serialize a pouch exactly as Anchor stores it. */
export function encodePouch(p: PouchFields): Buffer {
  const buf = Buffer.alloc(POUCH_ACCOUNT_SIZE);
  let o = 0;
  buf.set(ACCOUNT_DISCRIMINATORS.Pouch, o);
  o += 8;
  buf.set(p.owner.toBytes(), o);
  o += 32;
  buf.set(p.mint.toBytes(), o);
  o += 32;
  for (const v of [p.committed, p.settled, p.bond]) {
    buf.writeBigUInt64LE(v, o);
    o += 8;
  }
  buf.writeUInt32LE(p.epoch, o);
  o += 4;
  buf.writeBigInt64LE(p.epochStartedAt, o);
  o += 8;
  for (const w of p.spent) {
    buf.writeBigUInt64LE(w, o);
    o += 8;
  }
  const fps = p.settledFingerprints ?? new Array<bigint>(SLOTS_PER_EPOCH).fill(0n);
  for (const f of fps) {
    buf.writeBigUInt64LE(f, o);
    o += 8;
  }
  buf.writeUInt8(p.bump, o++);
  buf.writeUInt8(p.vaultBump, o++);
  if (o !== POUCH_ACCOUNT_SIZE) throw new Error(`encoded ${o} bytes`);
  return buf;
}

/** A 165-byte SPL token account with `amount`. */
export function tokenAccount(mint: PublicKey, owner: PublicKey, amount = 0n): Buffer {
  const b = Buffer.alloc(165);
  b.set(mint.toBytes(), 0);
  b.set(owner.toBytes(), 32);
  b.writeBigUInt64LE(amount, 64);
  b[108] = 1; // initialized
  return b;
}

export function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: 1_000_000, executable: false, rentEpoch: 0 };
}

/** In-memory stand-in for the handful of Connection methods the client reads. */
export class FakeConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly blockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();

  set(key: PublicKey, info: AccountInfo<Buffer>): this {
    this.accounts.set(key.toBase58(), info);
    return this;
  }

  async getAccountInfo(key: PublicKey) {
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }

  async getLatestBlockhash() {
    return { blockhash: this.blockhash, lastValidBlockHeight: 1_000 };
  }

  async getSlot() {
    return 1234;
  }
}

/** A world with one open pouch, a mint and a recipient, ready to settle against. */
export function world(opts: { atas?: boolean } = {}) {
  const owner = device(1);
  const recipient = device(2);
  const settler = device(3);
  const mint = new PublicKey(new Uint8Array(32).fill(9));
  const epoch = 1_790_000_000;
  const conn = new FakeConnection();
  conn.set(mint, account(TOKEN_PROGRAM_ID, Buffer.alloc(82)));
  return {
    owner,
    recipient,
    settler,
    mint,
    epoch,
    conn,
    openPouch(pouch: PublicKey, spent: bigint[] = [0n, 0n, 0n, 0n]) {
      conn.set(
        pouch,
        account(
          PROGRAM_ID,
          encodePouch({
            owner: owner.publicKey,
            mint,
            committed: 100_000_000n,
            settled: 0n,
            bond: 50_000_000n,
            epoch,
            epochStartedAt: BigInt(epoch),
            spent,
            bump: 255,
            vaultBump: 254,
          }),
        ),
      );
    },
    ata(who: PublicKey) {
      const a = getAssociatedTokenAddressSync(mint, who, true);
      if (opts.atas !== false) conn.set(a, account(TOKEN_PROGRAM_ID, tokenAccount(mint, who)));
      return a;
    },
  };
}

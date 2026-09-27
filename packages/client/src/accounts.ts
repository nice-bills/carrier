import { PublicKey, type AccountInfo, type Commitment } from "@solana/web3.js";
import { SLOTS_PER_EPOCH, type Note } from "@carrier/protocol";
import { PROGRAM_ID } from "./pda.js";

/** Anchor account discriminators (`sha256("account:<Name>")[..8]`). Checked against the IDL in tests. */
export const ACCOUNT_DISCRIMINATORS = {
  Pouch: [1, 68, 34, 227, 194, 225, 66, 255],
  SettlementDraft: [244, 34, 80, 57, 95, 251, 30, 93],
  DoubleSpendClaim: [89, 50, 251, 108, 150, 143, 178, 135],
} as const;

/** Mirrors MAX_NOTE_LIFETIME_SECONDS and SLASH_GRACE_SECONDS in state.rs. */
export const MAX_NOTE_LIFETIME_SECONDS = 30n * 24n * 60n * 60n;
export const SLASH_GRACE_SECONDS = 7n * 24n * 60n * 60n;

/**
 * Size of a pouch account: 8 discriminator + owner 32 + mint 32 + committed 8
 * + settled 8 + bond 8 + epoch 4 + epoch_started_at 8 + spent 32 +
 * settled_fp 2048 + bump 1 + vault_bump 1.
 */
export const POUCH_ACCOUNT_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 4 + 8 + 32 + 8 * SLOTS_PER_EPOCH + 1 + 1;

export interface PouchState {
  address: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  /** Total moved in across all epochs. */
  committed: bigint;
  /** Total paid out. */
  settled: bigint;
  /** Slashable stake. Not spendable. */
  bond: bigint;
  epoch: number;
  epochStartedAt: bigint;
  /** 256-bit settled-slot map, four little-endian u64 words. */
  spent: bigint[];
  /** Per slot, the first 8 bytes (LE) of the hash of the note that settled it. 0 if none. */
  settledFingerprints: bigint[];
  bump: number;
  vaultBump: number;
  /** `committed - settled`, floored at 0. What notes can still draw on. */
  available: bigint;
  /** After this unix time no note from the current epoch can settle. */
  epochClosesAt: bigint;
  /** When the owner may close the pouch or advance the epoch. */
  slashingEndsAt: bigint;
  isSlotSpent(i: number): boolean;
}

function checkDiscriminator(data: Uint8Array, expected: readonly number[], what: string): void {
  if (data.length < 8 || expected.some((b, i) => data[i] !== b)) {
    throw new Error(`account is not a Carrier ${what}`);
  }
}

class Reader {
  private o = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private need(n: number) {
    if (this.o + n > this.data.length) throw new Error("account data is too short");
  }
  skip(n: number) {
    this.need(n);
    this.o += n;
  }
  pubkey(): PublicKey {
    this.need(32);
    const k = new PublicKey(this.data.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const b = new Uint8Array(this.data.subarray(this.o, this.o + n));
    this.o += n;
    return b;
  }
  u8(): number {
    this.need(1);
    return this.data[this.o++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.o, true);
    this.o += 8;
    return v;
  }
  note(): Note {
    return {
      pouch: this.pubkey(),
      to: this.pubkey(),
      amount: this.u64(),
      slotIndex: this.u8(),
      epoch: this.u32(),
      expiry: this.i64(),
      relayFeeBps: this.u16(),
    };
  }
}

function slotSpent(spent: readonly bigint[], i: number): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= SLOTS_PER_EPOCH) {
    throw new RangeError(`slot index out of range: ${i}`);
  }
  return ((spent[i >> 6]! >> BigInt(i & 63)) & 1n) === 1n;
}

/** Decode raw pouch account data (including the 8-byte discriminator). */
export function decodePouch(address: PublicKey, data: Uint8Array): PouchState {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.Pouch, "pouch");
  const r = new Reader(data);
  r.skip(8);
  const owner = r.pubkey();
  const mint = r.pubkey();
  const committed = r.u64();
  const settled = r.u64();
  const bond = r.u64();
  const epoch = r.u32();
  const epochStartedAt = r.i64();
  const spent = [r.u64(), r.u64(), r.u64(), r.u64()];
  const settledFingerprints: bigint[] = [];
  for (let i = 0; i < SLOTS_PER_EPOCH; i += 1) settledFingerprints.push(r.u64());
  const bump = r.u8();
  const vaultBump = r.u8();
  const epochClosesAt = epochStartedAt + MAX_NOTE_LIFETIME_SECONDS;

  return {
    address,
    owner,
    mint,
    committed,
    settled,
    bond,
    epoch,
    epochStartedAt,
    spent,
    settledFingerprints,
    bump,
    vaultBump,
    available: committed > settled ? committed - settled : 0n,
    epochClosesAt,
    slashingEndsAt: epochClosesAt + SLASH_GRACE_SECONDS,
    isSlotSpent: (i: number) => slotSpent(spent, i),
  };
}

/**
 * Read a pouch. `null` if the account does not exist. Throws if the account
 * exists but is not a Carrier pouch.
 */
export async function fetchPouch(
  connection: { getAccountInfo(address: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null> },
  address: PublicKey,
  commitment: Commitment = "confirmed",
  programId = PROGRAM_ID,
): Promise<PouchState | null> {
  const info = await connection.getAccountInfo(address, commitment);
  if (!info) return null;
  if (!info.owner.equals(programId)) throw new Error("account is not owned by the Carrier program");
  return decodePouch(address, info.data);
}

/**
 * Lowest slot that is free both onchain and on this device, or `null` when
 * the epoch has none left.
 *
 * `locallyUsed` must hold every slot this device has signed a note for in the
 * pouch's current epoch, settled or not. Signing two notes for one slot is a
 * double spend and the bond pays for it, so a slot that is only spoken for
 * locally is never offered again.
 */
export function nextFreeSlot(
  pouch: Pick<PouchState, "isSlotSpent">,
  locallyUsed: ReadonlySet<number>,
): number | null {
  for (let i = 0; i < SLOTS_PER_EPOCH; i += 1) {
    if (!locallyUsed.has(i) && !pouch.isSlotSpent(i)) return i;
  }
  return null;
}

export interface SettlementDraftState {
  address: PublicKey;
  note: Note;
  noteHash: Uint8Array;
  pouch: PublicKey;
  owner: PublicKey;
  settler: PublicKey;
  epochStartedAt: bigint;
  /** How many hops are already verified; the next hop to extend with. */
  nextSeq: number;
  lastCarrier: PublicKey;
  lineage: PublicKey[];
  bump: number;
}

export function decodeSettlementDraft(address: PublicKey, data: Uint8Array): SettlementDraftState {
  checkDiscriminator(data, ACCOUNT_DISCRIMINATORS.SettlementDraft, "settlement draft");
  const r = new Reader(data);
  r.skip(8);
  const note = r.note();
  const noteHash = r.bytes(32);
  const pouch = r.pubkey();
  const owner = r.pubkey();
  const settler = r.pubkey();
  const epochStartedAt = r.i64();
  const nextSeq = r.u8();
  const lastCarrier = r.pubkey();
  const n = r.u32();
  if (n > 64) throw new Error("settlement draft lineage is implausibly long");
  const lineage: PublicKey[] = [];
  for (let i = 0; i < n; i += 1) lineage.push(r.pubkey());
  const bump = r.u8();
  return { address, note, noteHash, pouch, owner, settler, epochStartedAt, nextSeq, lastCarrier, lineage, bump };
}

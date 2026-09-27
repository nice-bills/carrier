import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import type { Note } from "@carrier/protocol";
import { PROGRAM_ID } from "./pda.js";

/**
 * Hand-written instruction encoders for the Carrier program.
 *
 * Anchor's client would pull @coral-xyz/anchor (and its IDL coder) into the
 * phone bundle for twelve fixed layouts. Instead each instruction is its
 * 8-byte discriminator (`sha256("global:<name>")[..8]`) followed by the Borsh
 * encoding of its arguments. `idl.test.ts` checks every discriminator, account
 * list and argument layout here against the IDL the program was built with.
 */

export const DISCRIMINATORS = {
  open_pouch: [53, 161, 172, 193, 66, 142, 157, 252],
  refill_pouch: [21, 90, 41, 223, 50, 32, 176, 240],
  add_bond: [67, 104, 1, 227, 44, 237, 39, 95],
  advance_epoch: [93, 138, 234, 218, 241, 230, 132, 38],
  settle_note: [21, 43, 198, 188, 252, 22, 228, 86],
  begin_settlement: [124, 223, 80, 249, 19, 59, 26, 92],
  extend_settlement: [37, 213, 212, 44, 107, 158, 247, 111],
  finalize_settlement: [220, 72, 152, 119, 178, 196, 25, 170],
  abandon_settlement: [33, 234, 164, 189, 211, 182, 49, 113],
  close_expired_draft: [24, 224, 230, 185, 158, 197, 29, 120],
  close_pouch: [245, 201, 5, 235, 249, 159, 41, 196],
  prove_double_spend: [213, 100, 176, 236, 193, 173, 212, 56],
} as const satisfies Record<string, readonly number[]>;

export type InstructionName = keyof typeof DISCRIMINATORS;

/** A hop as the program takes it: only what cannot be derived from the chain. */
export interface HopClaim {
  relayer: PublicKey;
  at: bigint;
}

// ---------------------------------------------------------------------------
// Borsh
// ---------------------------------------------------------------------------

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Minimal Borsh writer. Refuses out-of-range values instead of wrapping. */
export class BorshWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  bytes(b: Uint8Array | readonly number[]): this {
    const u = b instanceof Uint8Array ? b : Uint8Array.from(b);
    this.parts.push(u);
    this.length += u.length;
    return this;
  }

  private int(value: number, bytes: 1 | 2 | 4, field: string): this {
    const max = 2 ** (8 * bytes) - 1;
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new RangeError(`${field} out of range: ${String(value)}`);
    }
    const buf = new Uint8Array(bytes);
    const view = new DataView(buf.buffer);
    if (bytes === 1) view.setUint8(0, value);
    else if (bytes === 2) view.setUint16(0, value, true);
    else view.setUint32(0, value, true);
    return this.bytes(buf);
  }

  u8(v: number, field = "u8"): this {
    return this.int(v, 1, field);
  }
  u16(v: number, field = "u16"): this {
    return this.int(v, 2, field);
  }
  u32(v: number, field = "u32"): this {
    return this.int(v, 4, field);
  }

  u64(v: bigint, field = "u64"): this {
    if (typeof v !== "bigint" || v < 0n || v > U64_MAX) {
      throw new RangeError(`${field} out of range: ${String(v)}`);
    }
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, v, true);
    return this.bytes(buf);
  }

  i64(v: bigint, field = "i64"): this {
    if (typeof v !== "bigint" || v < I64_MIN || v > I64_MAX) {
      throw new RangeError(`${field} out of range: ${String(v)}`);
    }
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, v, true);
    return this.bytes(buf);
  }

  pubkey(k: PublicKey): this {
    return this.bytes(k.toBytes());
  }

  note(n: Note): this {
    return this.pubkey(n.pouch)
      .pubkey(n.to)
      .u64(n.amount, "note.amount")
      .u8(n.slotIndex, "note.slotIndex")
      .u32(n.epoch, "note.epoch")
      .i64(n.expiry, "note.expiry")
      .u16(n.relayFeeBps, "note.relayFeeBps");
  }

  hopClaims(claims: readonly HopClaim[]): this {
    this.u32(claims.length, "hops.length");
    for (const c of claims) this.pubkey(c.relayer).i64(c.at, "hop.at");
    return this;
  }

  toBuffer(): Buffer {
    const out = Buffer.alloc(this.length);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function data(name: InstructionName, args?: (w: BorshWriter) => void): Buffer {
  const w = new BorshWriter().bytes(DISCRIMINATORS[name]);
  args?.(w);
  return w.toBuffer();
}

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

function ix(keys: AccountMeta[], d: Buffer, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: d });
}

// ---------------------------------------------------------------------------
// Pouch lifecycle (owner signs)
// ---------------------------------------------------------------------------

export interface OpenPouchAccounts {
  owner: PublicKey;
  pouch: PublicKey;
  vault: PublicKey;
  /** Owner's token account the amount and bond come from. */
  funding: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

export function openPouchInstruction(
  a: OpenPouchAccounts,
  args: { amount: bigint; bond: bigint },
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix(
    [w(a.owner, true), w(a.pouch), w(a.vault), w(a.funding), r(a.mint), r(a.tokenProgram), r(SystemProgram.programId)],
    data("open_pouch", (x) => x.u64(args.amount, "amount").u64(args.bond, "bond")),
    programId,
  );
}

export type FundPouchAccounts = OpenPouchAccounts;

function fundKeys(a: FundPouchAccounts): AccountMeta[] {
  return [w(a.owner, true), w(a.pouch), w(a.vault), w(a.funding), r(a.mint), r(a.tokenProgram)];
}

export function refillPouchInstruction(a: FundPouchAccounts, amount: bigint, programId = PROGRAM_ID) {
  return ix(fundKeys(a), data("refill_pouch", (x) => x.u64(amount, "amount")), programId);
}

export function addBondInstruction(a: FundPouchAccounts, amount: bigint, programId = PROGRAM_ID) {
  return ix(fundKeys(a), data("add_bond", (x) => x.u64(amount, "amount")), programId);
}

export function advanceEpochInstruction(a: { owner: PublicKey; pouch: PublicKey }, programId = PROGRAM_ID) {
  return ix([r(a.owner, true), w(a.pouch)], data("advance_epoch"), programId);
}

export function closePouchInstruction(
  a: { owner: PublicKey; pouch: PublicKey; vault: PublicKey; destination: PublicKey; mint: PublicKey; tokenProgram: PublicKey },
  programId = PROGRAM_ID,
) {
  return ix(
    [w(a.owner, true), w(a.pouch), w(a.vault), w(a.destination), r(a.mint), r(a.tokenProgram)],
    data("close_pouch"),
    programId,
  );
}

// ---------------------------------------------------------------------------
// Settlement (anyone signs as settler)
// ---------------------------------------------------------------------------

export interface SettleAccounts {
  settler: PublicKey;
  pouch: PublicKey;
  vault: PublicKey;
  /** Token account owned by `note.to`. */
  recipient: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** One token account per hop, in hop order, each owned by that hop's relayer. */
  relayerAccounts: PublicKey[];
}

/**
 * `settle_note`. Must be preceded in the same transaction by an ed25519
 * precompile instruction carrying the note signature and both co-signatures
 * of every hop.
 */
export function settleNoteInstruction(
  a: SettleAccounts,
  note: Note,
  hops: readonly HopClaim[],
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix(
    [
      w(a.settler, true),
      w(a.pouch),
      w(a.vault),
      w(a.recipient),
      r(a.mint),
      r(a.tokenProgram),
      r(SYSVAR_INSTRUCTIONS_PUBKEY),
      ...a.relayerAccounts.map((k) => w(k)),
    ],
    data("settle_note", (x) => x.note(note).hopClaims(hops)),
    programId,
  );
}

/** `begin_settlement`. Needs the note signature in a preceding ed25519 instruction. */
export function beginSettlementInstruction(
  a: { settler: PublicKey; pouch: PublicKey; draft: PublicKey },
  note: Note,
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix(
    [w(a.settler, true), r(a.pouch), w(a.draft), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(SystemProgram.programId)],
    data("begin_settlement", (x) => x.note(note)),
    programId,
  );
}

/** `extend_settlement`. Needs both co-signatures of each claimed hop in a preceding ed25519 instruction. */
export function extendSettlementInstruction(
  a: { settler: PublicKey; draft: PublicKey },
  claims: readonly HopClaim[],
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix(
    [w(a.settler, true), w(a.draft), r(SYSVAR_INSTRUCTIONS_PUBKEY)],
    data("extend_settlement", (x) => x.hopClaims(claims)),
    programId,
  );
}

export function finalizeSettlementInstruction(
  a: SettleAccounts & { draft: PublicKey },
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix(
    [
      w(a.settler, true),
      w(a.pouch),
      w(a.draft),
      w(a.vault),
      w(a.recipient),
      r(a.mint),
      r(a.tokenProgram),
      ...a.relayerAccounts.map((k) => w(k)),
    ],
    data("finalize_settlement"),
    programId,
  );
}

export function abandonSettlementInstruction(
  a: { settler: PublicKey; draft: PublicKey },
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix([w(a.settler, true), w(a.draft)], data("abandon_settlement"), programId);
}

export function closeExpiredDraftInstruction(
  a: { draft: PublicKey; settler: PublicKey },
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix([w(a.draft), w(a.settler)], data("close_expired_draft"), programId);
}

/**
 * `prove_double_spend`. `noteA` settled, `noteB` lost. Needs the owner's
 * signatures over both notes in a preceding ed25519 instruction.
 */
export function proveDoubleSpendInstruction(
  a: {
    prover: PublicKey;
    pouch: PublicKey;
    vault: PublicKey;
    victim: PublicKey;
    proverPayout: PublicKey;
    claim: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
  },
  noteA: Note,
  noteB: Note,
  programId = PROGRAM_ID,
): TransactionInstruction {
  return ix(
    [
      w(a.prover, true),
      w(a.pouch),
      w(a.vault),
      w(a.victim),
      w(a.proverPayout),
      w(a.claim),
      r(a.mint),
      r(a.tokenProgram),
      r(SystemProgram.programId),
      r(SYSVAR_INSTRUCTIONS_PUBKEY),
    ],
    data("prove_double_spend", (x) => x.note(noteA).note(noteB)),
    programId,
  );
}

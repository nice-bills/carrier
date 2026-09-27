import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Commitment,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  createEd25519Instruction,
  hashNote,
  MAX_CHAIN,
  MAX_HOPS,
  type SignatureEntry,
} from "@carrier/protocol";
import type { Bundle } from "@carrier/mesh";
import { draftAddress, PROGRAM_ID, vaultAddress } from "./pda.js";
import { decodePouch, decodeSettlementDraft, type PouchState, type SettlementDraftState } from "./accounts.js";
import {
  beginSettlementInstruction,
  extendSettlementInstruction,
  finalizeSettlementInstruction,
  settleNoteInstruction,
  type HopClaim,
  type SettleAccounts,
} from "./instructions.js";
import { CarrierClientError, explainError, SettlementFailedError } from "./errors.js";
import { findPouchLookupTable } from "./lookup.js";
import { signSendAndConfirm, type TransactionSigner } from "./send.js";

/** Largest serialized transaction the network accepts. */
export const PACKET_DATA_SIZE = 1232;

/** Most hops one `extend_settlement` will be asked to verify (each is two signatures). */
const MAX_HOPS_PER_EXTEND = 8;

type SettleConnection = Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getLatestBlockhash">;

export interface BuildSettlementParams {
  bundle: Bundle;
  /** Who signs and pays the fees. Earns nothing unless also a carrier or the recipient. */
  settler: PublicKey;
  /** Lookup tables to compile against; include the pouch's table for two-hop fast settlement. */
  lookupTables?: AddressLookupTableAccount[];
  /** Blockhash to compile with. Fetched when omitted. `settleBundle` replaces it before signing. */
  recentBlockhash?: string;
  commitment?: Commitment;
  programId?: PublicKey;
}

export interface SettlementPlan {
  /** `fast`: one `settle_note`. `draft`: begin / extend / finalize across several transactions. */
  path: "fast" | "draft";
  /** Unsigned, in the order they must land. Each must confirm before the next is sent. */
  transactions: VersionedTransaction[];
  /** What each transaction does, parallel to `transactions`. */
  steps: SettlementStep[];
  /** Serialized size of each transaction, parallel to `transactions`. */
  sizes: number[];
  draft?: PublicKey;
  noteHash: Uint8Array;
}

export type SettlementStep = "accounts" | "settle" | "begin" | "extend" | "finalize";

/** Serialized size of a message as a transaction, or Infinity if it cannot be serialized. */
export function transactionSize(tx: VersionedTransaction): number {
  try {
    return tx.serialize().length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function compile(
  payer: PublicKey,
  blockhash: string,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[],
): { tx: VersionedTransaction; size: number } {
  let tx: VersionedTransaction;
  try {
    tx = new VersionedTransaction(
      new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(tables),
    );
  } catch {
    // Too many keys and the like. Treat as "does not fit".
    return { tx: undefined as unknown as VersionedTransaction, size: Number.POSITIVE_INFINITY };
  }
  return { tx, size: transactionSize(tx) };
}

function claimsOf(bundle: Bundle): HopClaim[] {
  return bundle.hops.map((h) => ({ relayer: h.relayer, at: h.at }));
}

function checkBundleShape(bundle: Bundle): void {
  const { hops, entries, note } = bundle;
  if (hops.length > MAX_CHAIN) {
    throw new CarrierClientError("TooManyHops", "This payment passed through too many phones to settle.");
  }
  if (entries.length !== 1 + 2 * hops.length) {
    throw new CarrierClientError("BadBundle", "This payment is missing signatures.");
  }
  const noteHash = hashNote(note);
  let prev = bundle.owner;
  hops.forEach((h, i) => {
    if (h.seq !== i || !h.prev.equals(prev) || !Buffer.from(h.noteHash).equals(Buffer.from(noteHash))) {
      throw new CarrierClientError("BadBundle", "The chain of handoffs on this payment is broken.");
    }
    prev = h.relayer;
  });
}

/** Everything settlement needs to know from the chain. */
interface Context {
  pouch: PouchState;
  tokenProgram: PublicKey;
  recipientAta: PublicKey;
  relayerAtas: PublicKey[];
  /** Instructions creating whichever of those token accounts do not exist yet. */
  createAtas: TransactionInstruction[];
  draft: PublicKey;
  existingDraft: SettlementDraftState | null;
}

async function loadContext(
  connection: SettleConnection,
  p: BuildSettlementParams,
  noteHash: Uint8Array,
): Promise<Context> {
  const { bundle, settler } = p;
  const programId = p.programId ?? PROGRAM_ID;
  const commitment = p.commitment ?? "confirmed";
  const note = bundle.note;

  const pouchInfo = await connection.getAccountInfo(note.pouch, commitment);
  if (!pouchInfo || !pouchInfo.owner.equals(programId)) {
    throw new CarrierClientError("PouchNotFound", "The pouch this payment draws on does not exist.");
  }
  const pouch = decodePouch(note.pouch, pouchInfo.data);

  if (!pouch.owner.equals(bundle.owner)) {
    throw new CarrierClientError("BadBundle", "This payment names the wrong sender.");
  }
  if (note.epoch !== pouch.epoch) {
    throw new CarrierClientError("EpochMismatch", "This payment is from an old round of the pouch. It can no longer be paid.");
  }
  if (pouch.isSlotSpent(note.slotIndex)) {
    throw new CarrierClientError("SlotAlreadySpent", "This payment was already settled.");
  }
  if (note.amount > pouch.available) {
    throw new CarrierClientError("InsufficientCommitted", "The sender's pouch does not have enough left to cover this.");
  }

  const owners = [note.to, ...bundle.hops.map((h) => h.relayer)];
  const atasFor = (tp: PublicKey) => owners.map((o) => getAssociatedTokenAddressSync(pouch.mint, o, true, tp));
  const classic = atasFor(TOKEN_PROGRAM_ID);
  const t22 = atasFor(TOKEN_2022_PROGRAM_ID);
  const draft = draftAddress(note.pouch, noteHash, settler, programId);

  // One round trip for the mint, the draft and both candidate sets of token accounts.
  const infos = await connection.getMultipleAccountsInfo([pouch.mint, draft, ...classic, ...t22], commitment);
  const mintInfo = infos[0];
  if (!mintInfo) throw new CarrierClientError("BadBundle", "The pouch's token does not exist on this network.");
  const isT22 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!isT22 && !mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    throw new CarrierClientError("BadBundle", "The pouch's token is not a token.");
  }
  const tokenProgram = mintInfo.owner;
  const atas = isT22 ? t22 : classic;
  const ataInfos: (AccountInfo<Buffer> | null)[] = isT22
    ? infos.slice(2 + owners.length)
    : infos.slice(2, 2 + owners.length);

  const createAtas = atas.flatMap((ata, i) =>
    ataInfos[i]
      ? []
      : [createAssociatedTokenAccountIdempotentInstruction(settler, ata, owners[i]!, pouch.mint, tokenProgram)],
  );

  const draftInfo = infos[1];
  const existingDraft = draftInfo && draftInfo.owner.equals(programId) ? decodeSettlementDraft(draft, draftInfo.data) : null;

  return {
    pouch,
    tokenProgram,
    recipientAta: atas[0]!,
    relayerAtas: atas.slice(1),
    createAtas,
    draft,
    existingDraft,
  };
}

/**
 * Build the transactions that settle `bundle`, unsigned and in order.
 *
 * Fast path: one transaction holding the ed25519 precompile (all signatures)
 * and `settle_note`, when the chain is at most `MAX_HOPS` and it fits in 1232
 * bytes. A two-hop chain fits only with a lookup table holding the pouch and
 * vault (see `createPouchLookupTable`).
 *
 * Otherwise the draft path: `begin_settlement` with the note signature, then
 * as many `extend_settlement` transactions as the hops need (packed as many
 * per transaction as fit), then `finalize_settlement`, which pays out. If this
 * settler already has a draft for the note (an earlier attempt stopped part
 * way), it picks up after the hops already verified.
 *
 * Token accounts for the recipient and carriers are created (idempotently) if
 * missing, in the first transaction if they fit, otherwise in their own.
 */
export async function buildSettlement(
  connection: SettleConnection,
  p: BuildSettlementParams,
): Promise<SettlementPlan> {
  const { bundle, settler } = p;
  const programId = p.programId ?? PROGRAM_ID;
  const tables = p.lookupTables ?? [];
  checkBundleShape(bundle);
  const noteHash = hashNote(bundle.note);
  const ctx = await loadContext(connection, p, noteHash);
  const blockhash = p.recentBlockhash ?? (await connection.getLatestBlockhash(p.commitment ?? "confirmed")).blockhash;

  const out: { tx: VersionedTransaction; size: number; step: SettlementStep }[] = [];
  const build = (ixs: TransactionInstruction[]) => compile(settler, blockhash, ixs, tables);
  const fits = (size: number) => size <= PACKET_DATA_SIZE;

  /**
   * Emit `core` as one transaction, with the missing-account instructions
   * in front if they fit, else in transactions of their own before it.
   * Returns false if `core` alone does not fit.
   */
  let pendingAtas = ctx.createAtas;
  const emit = (core: TransactionInstruction[], step: SettlementStep, dryRun = false): boolean => {
    const alone = build(core);
    if (!fits(alone.size)) return false;
    if (dryRun) return true;
    if (pendingAtas.length > 0) {
      const combined = build([...pendingAtas, ...core]);
      if (fits(combined.size)) {
        out.push({ ...combined, step });
        pendingAtas = [];
        return true;
      }
      for (const group of packInstructions(pendingAtas, build)) {
        out.push({ ...build(group), step: "accounts" });
      }
      pendingAtas = [];
    }
    out.push({ ...alone, step });
    return true;
  };

  const accounts: SettleAccounts = {
    settler,
    pouch: ctx.pouch.address,
    vault: vaultAddress(ctx.pouch.address, programId),
    recipient: ctx.recipientAta,
    mint: ctx.pouch.mint,
    tokenProgram: ctx.tokenProgram,
    relayerAccounts: ctx.relayerAtas,
  };
  const claims = claimsOf(bundle);

  // --- fast path -----------------------------------------------------------
  if (bundle.hops.length <= MAX_HOPS && !ctx.existingDraft) {
    const core = [
      createEd25519Instruction(bundle.entries),
      settleNoteInstruction(accounts, bundle.note, claims, programId),
    ];
    if (emit(core, "settle")) return plan("fast");
  }

  // --- draft path ----------------------------------------------------------
  const existing = ctx.existingDraft;
  let from = 0;
  if (existing) {
    if (!existing.settler.equals(settler) || !Buffer.from(existing.noteHash).equals(Buffer.from(noteHash))) {
      throw new CarrierClientError("BadBundle", "A settlement for this payment is already open under someone else.");
    }
    from = existing.nextSeq;
    const agrees = existing.lineage.every((k, i) => bundle.hops[i]?.relayer.equals(k));
    if (from > bundle.hops.length || !agrees) {
      throw new CarrierClientError("BadBundle", "An open settlement for this payment has a different chain.");
    }
  } else {
    const begin = [
      createEd25519Instruction([bundle.entries[0]!]),
      beginSettlementInstruction({ settler, pouch: ctx.pouch.address, draft: ctx.draft }, bundle.note, programId),
    ];
    if (!emit(begin, "begin")) throw new CarrierClientError("TooLarge", "This payment is too big to send.");
  }

  while (from < bundle.hops.length) {
    const room = Math.min(MAX_HOPS_PER_EXTEND, bundle.hops.length - from);
    let placed = false;
    for (let k = room; k >= 1; k -= 1) {
      const core = extendCore(bundle, claims, from, k, settler, ctx.draft, programId);
      if (emit(core, "extend", true)) {
        emit(core, "extend");
        from += k;
        placed = true;
        break;
      }
    }
    if (!placed) throw new CarrierClientError("TooLarge", "This payment is too big to send.");
  }

  const finalize: TransactionInstruction[] = [
    finalizeSettlementInstruction({ ...accounts, draft: ctx.draft }, programId),
  ];
  // Every carrier is one more transfer. Past a handful the default compute
  // budget is tight, so ask for room.
  if (ctx.relayerAtas.length > 4) {
    finalize.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + 40_000 * ctx.relayerAtas.length }));
  }
  if (!emit(finalize, "finalize")) throw new CarrierClientError("TooLarge", "This payment is too big to send.");
  return plan("draft");

  function plan(path: "fast" | "draft"): SettlementPlan {
    return {
      path,
      transactions: out.map((o) => o.tx),
      steps: out.map((o) => o.step),
      sizes: out.map((o) => o.size),
      draft: path === "draft" ? ctx.draft : undefined,
      noteHash,
    };
  }
}

function extendCore(
  bundle: Bundle,
  claims: HopClaim[],
  from: number,
  count: number,
  settler: PublicKey,
  draft: PublicKey,
  programId: PublicKey,
): TransactionInstruction[] {
  // entries[0] is the note; hop i contributes entries 1 + 2i and 2 + 2i.
  const entries: SignatureEntry[] = bundle.entries.slice(1 + 2 * from, 1 + 2 * (from + count));
  return [
    createEd25519Instruction(entries),
    extendSettlementInstruction({ settler, draft }, claims.slice(from, from + count), programId),
  ];
}

/** Greedily group independent instructions into as few fitting transactions as possible. */
function packInstructions(
  ixs: TransactionInstruction[],
  build: (ixs: TransactionInstruction[]) => { size: number },
): TransactionInstruction[][] {
  const groups: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  for (const ix of ixs) {
    const next = [...current, ix];
    if (current.length > 0 && build(next).size > PACKET_DATA_SIZE) {
      groups.push(current);
      current = [ix];
    } else {
      current = next;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export interface SettleOptions {
  /**
   * Lookup tables to use. When omitted, looks for the pouch owner's table
   * (`findPouchLookupTable`) and settles without one if none is found.
   */
  lookupTables?: AddressLookupTableAccount[];
  commitment?: Commitment;
  programId?: PublicKey;
  /** Called after each transaction confirms. */
  onProgress?: (e: { step: SettlementStep; index: number; total: number; signature: string }) => void;
}

/**
 * Build, sign, send and confirm a settlement, one transaction at a time.
 *
 * Throws `SettlementFailedError` whose `message` is a plain sentence for the
 * person (see `explainError`); `cause` holds the original error and
 * `signatures` what already landed. A draft-path settlement that fails part
 * way can simply be retried: it resumes from the draft.
 */
export async function settleBundle(
  connection: SettleConnection &
    Pick<Connection, "sendRawTransaction" | "getSignatureStatuses" | "getBlockHeight" | "getProgramAccounts">,
  signer: TransactionSigner,
  bundle: Bundle,
  opts: SettleOptions = {},
): Promise<{ signatures: string[]; path: "fast" | "draft" }> {
  const commitment = opts.commitment ?? "confirmed";
  const signatures: string[] = [];
  try {
    let tables = opts.lookupTables;
    if (!tables) {
      const found = await findPouchLookupTable(connection, {
        pouch: bundle.note.pouch,
        authority: bundle.owner,
        programId: opts.programId,
      }).catch(() => null);
      tables = found ? [found] : [];
    }
    const plan = await buildSettlement(connection, {
      bundle,
      settler: signer.publicKey,
      lookupTables: tables,
      commitment,
      programId: opts.programId,
    });
    for (const [index, tx] of plan.transactions.entries()) {
      const signature = await signSendAndConfirm(connection, signer, tx, commitment);
      signatures.push(signature);
      opts.onProgress?.({ step: plan.steps[index]!, index, total: plan.transactions.length, signature });
    }
    return { signatures, path: plan.path };
  } catch (e) {
    throw new SettlementFailedError(explainError(e), signatures, e);
  }
}

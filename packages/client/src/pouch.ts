import {
  PublicKey,
  Transaction,
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
import { pouchAddress, vaultAddress, PROGRAM_ID } from "./pda.js";
import {
  addBondInstruction,
  advanceEpochInstruction,
  closePouchInstruction,
  openPouchInstruction,
  refillPouchInstruction,
  type FundPouchAccounts,
} from "./instructions.js";
import { CarrierClientError } from "./errors.js";

type Conn = Pick<Connection, "getAccountInfo" | "getLatestBlockhash">;

/** The token program that owns `mint` (classic SPL Token or Token-2022). */
export async function tokenProgramForMint(
  connection: Pick<Connection, "getAccountInfo">,
  mint: PublicKey,
  commitment: Commitment = "confirmed",
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, commitment);
  if (!info) throw new CarrierClientError("BadBundle", "That token does not exist on this network.");
  if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return info.owner;
  throw new CarrierClientError("BadBundle", "That is not a token.");
}

/** Amount held in a token account (both token programs share this layout). */
export function tokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error("not a token account");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

export interface FundPouchParams {
  owner: PublicKey;
  mint: PublicKey;
  /** Looked up from the mint when omitted. */
  tokenProgram?: PublicKey;
  /** Token account to draw from. Defaults to the owner's associated token account. */
  funding?: PublicKey;
  programId?: PublicKey;
}

async function fundAccounts(connection: Conn, p: FundPouchParams, need: bigint) {
  const programId = p.programId ?? PROGRAM_ID;
  const tokenProgram = p.tokenProgram ?? (await tokenProgramForMint(connection, p.mint));
  const funding = p.funding ?? getAssociatedTokenAddressSync(p.mint, p.owner, true, tokenProgram);
  const info = await connection.getAccountInfo(funding, "confirmed");
  if (!info || tokenAccountAmount(info.data) < need) {
    throw new CarrierClientError("NotEnoughTokens", "You do not have that much to put in.");
  }
  const pouch = pouchAddress(p.owner, p.mint, programId);
  const accounts: FundPouchAccounts = {
    owner: p.owner,
    pouch,
    vault: vaultAddress(pouch, programId),
    funding,
    mint: p.mint,
    tokenProgram,
  };
  return { accounts, programId };
}

async function unsigned(connection: Conn, feePayer: PublicKey, ixs: TransactionInstruction[]): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  return new Transaction({ feePayer, blockhash, lastValidBlockHeight }).add(...ixs);
}

/**
 * Open a pouch: move `amount` (spendable offline) and `bond` (slashable if the
 * owner double spends) from the owner's token account into a new vault.
 * Unsigned; the owner signs and pays.
 */
export async function buildOpenPouchTx(
  connection: Conn,
  p: FundPouchParams & { amount: bigint; bond: bigint },
): Promise<Transaction> {
  const { accounts, programId } = await fundAccounts(connection, p, p.amount + p.bond);
  return unsigned(connection, p.owner, [
    openPouchInstruction(accounts, { amount: p.amount, bond: p.bond }, programId),
  ]);
}

/** Add spendable funds. Notes already handed over stay valid. */
export async function buildRefillTx(
  connection: Conn,
  p: FundPouchParams & { amount: bigint },
): Promise<Transaction> {
  const { accounts, programId } = await fundAccounts(connection, p, p.amount);
  return unsigned(connection, p.owner, [refillPouchInstruction(accounts, p.amount, programId)]);
}

/** Top up the bond. */
export async function buildAddBondTx(
  connection: Conn,
  p: FundPouchParams & { amount: bigint },
): Promise<Transaction> {
  const { accounts, programId } = await fundAccounts(connection, p, p.amount);
  return unsigned(connection, p.owner, [addBondInstruction(accounts, p.amount, programId)]);
}

/** Start a new epoch once the old one is fully over (see `PouchState.slashingEndsAt`). */
export async function buildAdvanceEpochTx(
  connection: Conn,
  p: { owner: PublicKey; mint: PublicKey; programId?: PublicKey },
): Promise<Transaction> {
  const programId = p.programId ?? PROGRAM_ID;
  const pouch = pouchAddress(p.owner, p.mint, programId);
  return unsigned(connection, p.owner, [advanceEpochInstruction({ owner: p.owner, pouch }, programId)]);
}

/** Withdraw everything and close the pouch once the epoch is fully over. */
export async function buildClosePouchTx(
  connection: Conn,
  p: { owner: PublicKey; mint: PublicKey; tokenProgram?: PublicKey; destination?: PublicKey; programId?: PublicKey },
): Promise<Transaction> {
  const programId = p.programId ?? PROGRAM_ID;
  const tokenProgram = p.tokenProgram ?? (await tokenProgramForMint(connection, p.mint));
  const pouch = pouchAddress(p.owner, p.mint, programId);
  const destination = p.destination ?? getAssociatedTokenAddressSync(p.mint, p.owner, true, tokenProgram);
  // The default destination may not exist yet (the pouch can be funded from
  // any account), and the program requires an existing token account.
  const ensureDestination = p.destination
    ? []
    : [createAssociatedTokenAccountIdempotentInstruction(p.owner, destination, p.owner, p.mint, tokenProgram)];
  return unsigned(connection, p.owner, [
    ...ensureDestination,
    closePouchInstruction(
      {
        owner: p.owner,
        pouch,
        vault: vaultAddress(pouch, programId),
        destination,
        mint: p.mint,
        tokenProgram,
      },
      programId,
    ),
  ]);
}

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  type Connection,
} from "@solana/web3.js";
import { PROGRAM_ID, vaultAddress } from "./pda.js";

/**
 * The keys every settlement of one pouch's notes shares, in table order.
 *
 * Per the audit (and `MAX_HOPS` in state.rs), a two-hop `settle_note` only
 * fits in 1232 bytes when at least the pouch and vault come from a table.
 * Per-payment keys (recipient, carriers, settler) are not worth tabling: they
 * differ every time. The program id is included for parity with the audit's
 * measured table, though invoked program ids are always written out in full.
 */
export function pouchLookupTableAddresses(p: {
  pouch: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  programId?: PublicKey;
}): PublicKey[] {
  const programId = p.programId ?? PROGRAM_ID;
  return [
    p.pouch,
    vaultAddress(p.pouch, programId),
    p.mint,
    p.tokenProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    programId,
    SystemProgram.programId,
  ];
}

/**
 * Create a lookup table for one pouch. Returns the unsigned transaction(s)
 * (create + extend fit in one) and the table's address.
 *
 * Make the pouch owner the `payer` (and so the authority): `findPouchLookupTable`
 * finds a table by its authority, so settlers who never met the owner online
 * can still discover it. A new table is usable from the slot after it was
 * extended, so wait one slot before settling through it.
 */
export async function createPouchLookupTable(
  connection: Pick<Connection, "getSlot" | "getLatestBlockhash">,
  p: {
    payer: PublicKey;
    pouch: PublicKey;
    mint: PublicKey;
    tokenProgram: PublicKey;
    /** Defaults to `payer`. */
    authority?: PublicKey;
    programId?: PublicKey;
  },
): Promise<{ transactions: Transaction[]; address: PublicKey; addresses: PublicKey[] }> {
  const authority = p.authority ?? p.payer;
  const recentSlot = await connection.getSlot("finalized");
  const [create, address] = AddressLookupTableProgram.createLookupTable({
    authority,
    payer: p.payer,
    recentSlot,
  });
  const addresses = pouchLookupTableAddresses(p);
  const extend = AddressLookupTableProgram.extendLookupTable({
    payer: p.payer,
    authority,
    lookupTable: address,
    addresses,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: p.payer, blockhash, lastValidBlockHeight }).add(create, extend);
  return { transactions: [tx], address, addresses };
}

/** Offset of the authority key in a lookup table account (after the `Some` tag). */
const LOOKUP_TABLE_AUTHORITY_OFFSET = 22;
const U64_MAX = (1n << 64n) - 1n;

/**
 * Find an active lookup table, owned by `authority` (normally the pouch
 * owner), that holds this pouch and its vault. `null` if there is none.
 *
 * Uses `getProgramAccounts` with an authority filter. Some public RPC nodes
 * refuse that; callers should treat a throw as "no table".
 */
export async function findPouchLookupTable(
  connection: Pick<Connection, "getProgramAccounts">,
  p: { pouch: PublicKey; authority: PublicKey; programId?: PublicKey },
): Promise<AddressLookupTableAccount | null> {
  const vault = vaultAddress(p.pouch, p.programId ?? PROGRAM_ID);
  const found = await connection.getProgramAccounts(AddressLookupTableProgram.programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: LOOKUP_TABLE_AUTHORITY_OFFSET, bytes: p.authority.toBase58() } }],
  });
  for (const { pubkey, account } of found) {
    let state;
    try {
      state = AddressLookupTableAccount.deserialize(account.data);
    } catch {
      continue;
    }
    if (state.deactivationSlot !== U64_MAX) continue;
    const has = (k: PublicKey) => state.addresses.some((a) => a.equals(k));
    if (has(p.pouch) && has(vault)) return new AddressLookupTableAccount({ key: pubkey, state });
  }
  return null;
}

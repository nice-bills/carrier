import { PublicKey } from "@solana/web3.js";

/**
 * The deployed Carrier program. Mirrors `declare_id!` in
 * programs/carrier/src/lib.rs (and the IDL's `address`).
 */
export const PROGRAM_ID = new PublicKey("CJBPBb6WBPWptmpiW4Kdb7SeRC7Cmob5YAaBtKSMXBvt");

/** Seeds from programs/carrier/src/instructions.rs. */
export const POUCH_SEED = new TextEncoder().encode("pouch");
export const VAULT_SEED = new TextEncoder().encode("vault");
export const DRAFT_SEED = new TextEncoder().encode("draft");
export const CLAIM_SEED = new TextEncoder().encode("claim");

function hash32(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

/** `["pouch", owner, mint]`. One pouch per owner per mint. */
export function pouchAddress(owner: PublicKey, mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POUCH_SEED, owner.toBytes(), mint.toBytes()],
    programId,
  )[0];
}

/** `["vault", pouch]`. The token account holding the pouch's funds and bond. */
export function vaultAddress(pouch: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, pouch.toBytes()], programId)[0];
}

/**
 * `["draft", pouch, note_hash, settler]`. Where a long chain's verification
 * accumulates. Each settler has their own draft for a note.
 */
export function draftAddress(
  pouch: PublicKey,
  noteHash: Uint8Array,
  settler: PublicKey,
  programId = PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DRAFT_SEED, pouch.toBytes(), hash32(noteHash, "noteHash"), settler.toBytes()],
    programId,
  )[0];
}

/**
 * `["claim", pouch, losing_note_hash]`. Marks one losing note of a double
 * spend as compensated, so it can only be claimed once.
 */
export function claimAddress(
  pouch: PublicKey,
  losingNoteHash: Uint8Array,
  programId = PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CLAIM_SEED, pouch.toBytes(), hash32(losingNoteHash, "losingNoteHash")],
    programId,
  )[0];
}

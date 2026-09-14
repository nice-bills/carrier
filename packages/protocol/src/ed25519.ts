import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Builder for a single ed25519 precompile instruction carrying *many*
 * signatures.
 *
 * `Ed25519Program.createInstructionWithPublicKey` packs exactly one signature
 * per instruction. Settling a note needs the sender's signature plus two
 * co-signatures per hop — up to 17 signatures for a full 8-hop chain. As
 * separate instructions that blows the transaction size limit and forces the
 * program to scan 17 instructions. One instruction with 17 entries is both
 * smaller and cheaper to introspect.
 *
 * Data layout (see solana_sdk::ed25519_instruction):
 *
 *   [num_signatures: u8][padding: u8]
 *   [Ed25519SignatureOffsets * num_signatures]   // 14 bytes each
 *   [blobs...]
 *
 * Each offsets entry:
 *   signature_offset             u16
 *   signature_instruction_index  u16
 *   public_key_offset            u16
 *   public_key_instruction_index u16
 *   message_data_offset          u16
 *   message_data_size            u16
 *   message_instruction_index    u16
 */

const OFFSETS_LEN = 14;
const HEADER_LEN = 2;
const SIGNATURE_LEN = 64;
const PUBKEY_LEN = 32;
/** Sentinel meaning "this same instruction". */
const IX_INDEX_CURRENT = 0xffff;

export interface SignatureEntry {
  publicKey: PublicKey;
  signature: Uint8Array;
  message: Uint8Array;
}

export function createEd25519Instruction(
  entries: SignatureEntry[],
): TransactionInstruction {
  if (entries.length === 0) {
    throw new Error("at least one signature entry is required");
  }
  if (entries.length > 255) {
    throw new Error("ed25519 precompile supports at most 255 signatures");
  }

  for (const entry of entries) {
    if (entry.signature.length !== SIGNATURE_LEN) {
      throw new Error(
        `signature must be ${SIGNATURE_LEN} bytes, got ${entry.signature.length}`,
      );
    }
  }

  const blobsStart = HEADER_LEN + entries.length * OFFSETS_LEN;

  // Both devices in a handoff sign the identical hop digest, so the same message
  // would otherwise be written into the instruction twice. The precompile lets
  // several entries point at one message region, and at the transaction size
  // limit those duplicate bytes are the difference between settling and not.
  const messageKey = (m: Uint8Array) => m.join(",");
  const uniqueMessages = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const key = messageKey(entry.message);
    if (!uniqueMessages.has(key)) uniqueMessages.set(key, entry.message);
  }

  const blobsSize =
    entries.length * (PUBKEY_LEN + SIGNATURE_LEN) +
    [...uniqueMessages.values()].reduce((n, m) => n + m.length, 0);

  const data = new Uint8Array(blobsStart + blobsSize);
  const view = new DataView(data.buffer);

  data[0] = entries.length;
  data[1] = 0; // padding

  // Messages first, each stored once, then the per-entry key/signature pairs.
  const messageOffsets = new Map<string, number>();
  let blobOffset = blobsStart;
  for (const [key, message] of uniqueMessages) {
    messageOffsets.set(key, blobOffset);
    data.set(message, blobOffset);
    blobOffset += message.length;
  }

  entries.forEach((entry, i) => {
    const publicKeyOffset = blobOffset;
    const signatureOffset = publicKeyOffset + PUBKEY_LEN;
    const messageOffset = messageOffsets.get(messageKey(entry.message))!;

    data.set(entry.publicKey.toBytes(), publicKeyOffset);
    data.set(entry.signature, signatureOffset);

    blobOffset = signatureOffset + SIGNATURE_LEN;

    let cursor = HEADER_LEN + i * OFFSETS_LEN;
    const putU16 = (value: number) => {
      view.setUint16(cursor, value, true);
      cursor += 2;
    };

    putU16(signatureOffset);
    putU16(IX_INDEX_CURRENT);
    putU16(publicKeyOffset);
    putU16(IX_INDEX_CURRENT);
    putU16(messageOffset);
    putU16(entry.message.length);
    putU16(IX_INDEX_CURRENT);
  });

  return new TransactionInstruction({
    keys: [],
    programId: Ed25519Program.programId,
    data: Buffer.from(data),
  });
}

import { describe, expect, it } from "vitest";
import { PublicKey, Keypair, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, type TransactionInstruction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { encodeNote, NOTE_DOMAIN, type Note } from "@carrier/protocol";
import { IDL } from "./idl.js";
import {
  DISCRIMINATORS,
  abandonSettlementInstruction,
  addBondInstruction,
  advanceEpochInstruction,
  beginSettlementInstruction,
  closeExpiredDraftInstruction,
  closePouchInstruction,
  extendSettlementInstruction,
  finalizeSettlementInstruction,
  openPouchInstruction,
  proveDoubleSpendInstruction,
  refillPouchInstruction,
  settleNoteInstruction,
  type InstructionName,
} from "./instructions.js";
import { ACCOUNT_DISCRIMINATORS } from "./accounts.js";
import { CARRIER_ERROR_NAMES, CARRIER_ERROR_OFFSET } from "./errors.js";
import { PROGRAM_ID } from "./pda.js";

const k = () => Keypair.generate().publicKey;

const note: Note = {
  pouch: new PublicKey("11111111111111111111111111111112"),
  to: new PublicKey("11111111111111111111111111111113"),
  amount: 1_500_000n,
  slotIndex: 7,
  epoch: 3,
  expiry: 1_800_000_000n,
  relayFeeBps: 250,
};

/** One instance of every builder, with fresh keys, keyed by IDL instruction name. */
function everyInstruction(): Record<InstructionName, TransactionInstruction> {
  const fund = { owner: k(), pouch: k(), vault: k(), funding: k(), mint: k(), tokenProgram: k() };
  const settle = { settler: k(), pouch: k(), vault: k(), recipient: k(), mint: k(), tokenProgram: k(), relayerAccounts: [] };
  return {
    open_pouch: openPouchInstruction(fund, { amount: 1n, bond: 2n }),
    refill_pouch: refillPouchInstruction(fund, 1n),
    add_bond: addBondInstruction(fund, 1n),
    advance_epoch: advanceEpochInstruction({ owner: k(), pouch: k() }),
    settle_note: settleNoteInstruction(settle, note, []),
    begin_settlement: beginSettlementInstruction({ settler: k(), pouch: k(), draft: k() }, note),
    extend_settlement: extendSettlementInstruction({ settler: k(), draft: k() }, []),
    finalize_settlement: finalizeSettlementInstruction({ ...settle, draft: k() }),
    abandon_settlement: abandonSettlementInstruction({ settler: k(), draft: k() }),
    close_expired_draft: closeExpiredDraftInstruction({ draft: k(), settler: k() }),
    close_pouch: closePouchInstruction({ owner: k(), pouch: k(), vault: k(), destination: k(), mint: k(), tokenProgram: k() }),
    prove_double_spend: proveDoubleSpendInstruction(
      { prover: k(), pouch: k(), vault: k(), victim: k(), proverPayout: k(), claim: k(), mint: k(), tokenProgram: k() },
      note,
      { ...note, to: k() },
    ),
  };
}

describe("instruction encoding matches the IDL", () => {
  it("covers exactly the program's instructions", () => {
    expect(Object.keys(DISCRIMINATORS).sort()).toEqual(IDL.instructions.map((i) => i.name).sort());
    expect(IDL.address).toBe(PROGRAM_ID.toBase58());
  });

  it("uses the IDL discriminators, which are sha256('global:<name>')[..8]", () => {
    for (const ixDef of IDL.instructions) {
      const ours = DISCRIMINATORS[ixDef.name as InstructionName];
      expect(ours, ixDef.name).toEqual([...ixDef.discriminator]);
      expect([...sha256(`global:${ixDef.name}`).slice(0, 8)], ixDef.name).toEqual([...ours]);
    }
  });

  it("lists accounts in IDL order with the IDL's signer and writable flags", () => {
    const built = everyInstruction();
    for (const ixDef of IDL.instructions) {
      const ix = built[ixDef.name as InstructionName];
      expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
      expect(ix.data.subarray(0, 8)).toEqual(Buffer.from(ixDef.discriminator));
      expect(ix.keys.length, ixDef.name).toBe(ixDef.accounts.length);
      ixDef.accounts.forEach((a, i) => {
        const meta = ix.keys[i]!;
        const where = `${ixDef.name}.${a.name}`;
        expect(meta.isSigner, where).toBe("signer" in a && a.signer === true);
        expect(meta.isWritable, where).toBe("writable" in a && a.writable === true);
        if (a.name === "system_program") expect(meta.pubkey.equals(SystemProgram.programId), where).toBe(true);
        if (a.name === "instructions") expect(meta.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY), where).toBe(true);
      });
    }
  });

  it("encodes Note arguments as the IDL's Borsh struct, identical to the signed bytes", () => {
    const noteType = IDL.types.find((t) => t.name === "Note")!;
    expect(noteType.type.kind).toBe("struct");
    expect((noteType.type as { fields: readonly { name: string; type: unknown }[] }).fields.map((f) => [f.name, f.type])).toEqual([
      ["pouch", "pubkey"],
      ["to", "pubkey"],
      ["amount", "u64"],
      ["slot_index", "u8"],
      ["epoch", "u32"],
      ["expiry", "i64"],
      ["relay_fee_bps", "u16"],
    ]);
    const ix = beginSettlementInstruction({ settler: k(), pouch: k(), draft: k() }, note);
    // The signed encoding is domain || borsh(note), and the Rust side asserts
    // the same golden hash, so the argument bytes are pinned from both ends.
    const signed = encodeNote(note).subarray(NOTE_DOMAIN.length);
    expect(ix.data.length).toBe(8 + 87);
    expect(Buffer.from(ix.data.subarray(8))).toEqual(Buffer.from(signed));
  });

  it("encodes settle_note(note, Vec<HopClaim>) byte for byte", () => {
    const relayer = new PublicKey(new Uint8Array(32).fill(0xab));
    const hops = [
      { relayer, at: 1_790_000_123n },
      { relayer: note.to, at: -5n },
    ];
    const hopType = IDL.types.find((t) => t.name === "HopClaim")!;
    expect((hopType.type as { fields: readonly { name: string; type: unknown }[] }).fields.map((f) => [f.name, f.type])).toEqual([
      ["relayer", "pubkey"],
      ["at", "i64"],
    ]);
    const ix = settleNoteInstruction(
      { settler: k(), pouch: k(), vault: k(), recipient: k(), mint: k(), tokenProgram: k(), relayerAccounts: [k(), k()] },
      note,
      hops,
    );
    const d = Buffer.from(ix.data);
    expect(d.length).toBe(8 + 87 + 4 + 2 * 40);
    let o = 8;
    expect(new PublicKey(d.subarray(o, o + 32)).equals(note.pouch)).toBe(true);
    o += 32;
    expect(new PublicKey(d.subarray(o, o + 32)).equals(note.to)).toBe(true);
    o += 32;
    expect(d.readBigUInt64LE(o)).toBe(1_500_000n);
    o += 8;
    expect(d.readUInt8(o)).toBe(7);
    o += 1;
    expect(d.readUInt32LE(o)).toBe(3);
    o += 4;
    expect(d.readBigInt64LE(o)).toBe(1_800_000_000n);
    o += 8;
    expect(d.readUInt16LE(o)).toBe(250);
    o += 2;
    expect(d.readUInt32LE(o)).toBe(2); // vec length
    o += 4;
    expect(new PublicKey(d.subarray(o, o + 32)).equals(relayer)).toBe(true);
    expect(d.readBigInt64LE(o + 32)).toBe(1_790_000_123n);
    o += 40;
    expect(d.readBigInt64LE(o + 32)).toBe(-5n);
    // Relayer token accounts ride along as writable remaining accounts.
    expect(ix.keys.slice(7).every((m) => m.isWritable && !m.isSigner)).toBe(true);
  });

  it("encodes u64 arguments little-endian and refuses values that do not fit", () => {
    const fund = { owner: k(), pouch: k(), vault: k(), funding: k(), mint: k(), tokenProgram: k() };
    const ix = openPouchInstruction(fund, { amount: 0x0102030405060708n, bond: 9n });
    expect([...ix.data.subarray(8)]).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 9, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => openPouchInstruction(fund, { amount: -1n, bond: 0n })).toThrow(RangeError);
    expect(() => openPouchInstruction(fund, { amount: 1n << 64n, bond: 0n })).toThrow(RangeError);
    expect(() => settleNoteInstruction({ ...fund, settler: k(), recipient: k(), relayerAccounts: [] }, { ...note, slotIndex: 256 }, [])).toThrow(RangeError);
  });

  it("uses the IDL account discriminators", () => {
    for (const acc of IDL.accounts) {
      const ours = ACCOUNT_DISCRIMINATORS[acc.name as keyof typeof ACCOUNT_DISCRIMINATORS];
      expect(ours, acc.name).toEqual([...acc.discriminator]);
      expect([...sha256(`account:${acc.name}`).slice(0, 8)]).toEqual([...ours]);
    }
  });

  it("knows every program error by its IDL code", () => {
    expect(IDL.errors.length).toBe(CARRIER_ERROR_NAMES.length);
    for (const e of IDL.errors) {
      expect(CARRIER_ERROR_NAMES[e.code - CARRIER_ERROR_OFFSET], String(e.code)).toBe(e.name);
    }
  });
});

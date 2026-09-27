import { describe, expect, it } from "vitest";
import {
  AddressLookupTableAccount,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  type VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { hashNote, MAX_HOPS, type Note } from "@carrier/protocol";
import type { Bundle } from "@carrier/mesh";
import { buildSettlement, PACKET_DATA_SIZE, type SettlementPlan } from "./settle.js";
import { pouchLookupTableAddresses } from "./lookup.js";
import { draftAddress, pouchAddress, PROGRAM_ID } from "./pda.js";
import { DISCRIMINATORS, type InstructionName } from "./instructions.js";
import { account, carry, device, world } from "./testkit.js";
import { CarrierClientError } from "./errors.js";
import { ACCOUNT_DISCRIMINATORS } from "./accounts.js";

const AT = 1_790_000_100n;

function setup(opts: { atas?: boolean } = {}) {
  const w = world(opts);
  const pouch = pouchAddress(w.owner.publicKey, w.mint);
  w.openPouch(pouch);
  const table = new AddressLookupTableAccount({
    key: new PublicKey(new Uint8Array(32).fill(42)),
    state: {
      deactivationSlot: (1n << 64n) - 1n,
      lastExtendedSlot: 1,
      lastExtendedSlotStartIndex: 0,
      authority: w.owner.publicKey,
      addresses: pouchLookupTableAddresses({ pouch, mint: w.mint, tokenProgram: TOKEN_PROGRAM_ID }),
    },
  });
  const note = (slotIndex: number): Note => ({
    pouch,
    to: w.recipient.publicKey,
    amount: 10_000_000n,
    slotIndex,
    epoch: w.epoch,
    expiry: AT + 86_400n,
    relayFeeBps: 200,
  });
  const bundleWith = (hops: number, slot = hops): Bundle => {
    const chain = Array.from({ length: hops }, (_, i) => device(100 + i));
    w.ata(w.recipient.publicKey);
    for (const d of chain) w.ata(d.publicKey);
    return carry(w.owner, note(slot), chain, AT);
  };
  return { ...w, pouch, table, note, bundleWith };
}

/** Program instructions in a compiled transaction, by name. */
function carrierSteps(tx: VersionedTransaction): string[] {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.flatMap((ci) => {
    const pid = keys[ci.programIdIndex]!;
    if (pid.equals(Ed25519Program.programId)) return [`ed25519x${ci.data[0]}`];
    if (pid.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return ["ata"];
    if (!pid.equals(PROGRAM_ID)) return ["other"];
    const name = (Object.keys(DISCRIMINATORS) as InstructionName[]).find((n) =>
      DISCRIMINATORS[n].every((b, i) => ci.data[i] === b),
    );
    return [name ?? "?"];
  });
}

function describePlan(plan: SettlementPlan): string[][] {
  return plan.transactions.map(carrierSteps);
}

describe("buildSettlement: fast path and its size", () => {
  const sizes: string[] = [];

  for (const hops of [0, 1, 2]) {
    it(`${hops} hop(s) with the pouch lookup table: one settle_note transaction`, async () => {
      const s = setup();
      const plan = await buildSettlement(s.conn as never, {
        bundle: s.bundleWith(hops),
        settler: s.settler.publicKey,
        lookupTables: [s.table],
      });
      sizes.push(`${hops} hop(s), table: ${plan.sizes.join(", ")} bytes`);
      expect(plan.path).toBe("fast");
      expect(describePlan(plan)).toEqual([[`ed25519x${1 + 2 * hops}`, "settle_note"]]);
      expect(plan.sizes[0]).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      expect(plan.sizes[0]).toBe(plan.transactions[0]!.serialize().length);
    });
  }

  for (const hops of [0, 1]) {
    it(`${hops} hop(s) without a table still fit the fast path`, async () => {
      const s = setup();
      const plan = await buildSettlement(s.conn as never, { bundle: s.bundleWith(hops), settler: s.settler.publicKey });
      sizes.push(`${hops} hop(s), no table: ${plan.sizes.join(", ")} bytes`);
      expect(plan.path).toBe("fast");
      expect(plan.transactions).toHaveLength(1);
    });
  }

  it("2 hops without a table do not fit, so it falls to the draft path", async () => {
    const s = setup();
    const plan = await buildSettlement(s.conn as never, { bundle: s.bundleWith(2), settler: s.settler.publicKey });
    sizes.push(`2 hop(s), no table: draft ${plan.sizes.join(", ")} bytes`);
    expect(plan.path).toBe("draft");
    expect(describePlan(plan)).toEqual([
      ["ed25519x1", "begin_settlement"],
      ["ed25519x4", "extend_settlement"],
      ["finalize_settlement"],
    ]);
    for (const n of plan.sizes) expect(n).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    console.log("\n  settlement sizes\n  " + sizes.join("\n  "));
  });

  it(`more than MAX_HOPS (${MAX_HOPS}) always takes the draft path, even with a table`, async () => {
    const s = setup();
    const plan = await buildSettlement(s.conn as never, {
      bundle: s.bundleWith(3),
      settler: s.settler.publicKey,
      lookupTables: [s.table],
    });
    expect(plan.path).toBe("draft");
    expect(plan.draft!.equals(draftAddress(s.pouch, hashNote(s.note(3)), s.settler.publicKey))).toBe(true);
  });

  it("pays carriers in hop order and puts the signatures the program needs in front", async () => {
    const s = setup();
    const bundle = s.bundleWith(2);
    const plan = await buildSettlement(s.conn as never, { bundle, settler: s.settler.publicKey, lookupTables: [s.table] });
    const tx = plan.transactions[0]!;
    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: [s.table] });
    const [ed, settle] = tx.message.compiledInstructions;
    const settleKeys = settle!.accountKeyIndexes.map((i) => keys.get(i)!);
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const ata = (o: PublicKey) => getAssociatedTokenAddressSync(s.mint, o, true);
    expect(settleKeys[0]!.equals(s.settler.publicKey)).toBe(true);
    expect(settleKeys[1]!.equals(s.pouch)).toBe(true);
    expect(settleKeys[3]!.equals(ata(s.recipient.publicKey))).toBe(true);
    expect(settleKeys[6]!.equals(SYSVAR_INSTRUCTIONS_PUBKEY)).toBe(true);
    expect(settleKeys.slice(7).map((k) => k.toBase58())).toEqual(bundle.hops.map((h) => ata(h.relayer).toBase58()));
    // The ed25519 instruction carries all five signatures over three distinct messages.
    expect(ed!.data[0]).toBe(5);
    expect(ed!.data.length).toBe(2 + 5 * 14 + 3 * 32 + 5 * 96);
    // Pouch and vault came from the table, not the static keys.
    expect(tx.message.staticAccountKeys.some((k) => k.equals(s.pouch))).toBe(false);
  });
});

describe("buildSettlement: draft path", () => {
  it("splits a sixteen-hop chain into begin, packed extends and finalize, every one under the limit", async () => {
    const s = setup();
    const bundle = s.bundleWith(16);
    const plan = await buildSettlement(s.conn as never, { bundle, settler: s.settler.publicKey, lookupTables: [s.table] });
    expect(plan.path).toBe("draft");
    const steps = describePlan(plan);
    expect(steps[0]).toEqual(["ed25519x1", "begin_settlement"]);
    expect(steps.at(-1)).toEqual(["other", "finalize_settlement"]); // compute budget first
    const extends_ = steps.slice(1, -1);
    // Every hop verified exactly once, in order.
    const perTx = extends_.map((st) => {
      expect(st[1]).toBe("extend_settlement");
      return Number(st[0]!.slice("ed25519x".length)) / 2;
    });
    expect(perTx.reduce((a, b) => a + b, 0)).toBe(16);
    // Packing takes as many hops per transaction as fit (three at this size).
    expect(Math.max(...perTx)).toBeGreaterThanOrEqual(3);
    for (const n of plan.sizes) expect(n).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    console.log(`\n  16 hops: ${plan.transactions.length} txs, hops per extend ${perTx.join("+")}, sizes ${plan.sizes.join(", ")}`);

    // The extend calls carry the right hops: decode each claims vector and compare.
    let seq = 0;
    for (const tx of plan.transactions.slice(1, -1)) {
      const ix = tx.message.compiledInstructions[1]!;
      const d = Buffer.from(ix.data);
      const n = d.readUInt32LE(8);
      for (let j = 0; j < n; j += 1) {
        const relayer = new PublicKey(d.subarray(12 + 40 * j, 44 + 40 * j));
        expect(relayer.equals(bundle.hops[seq]!.relayer)).toBe(true);
        expect(d.readBigInt64LE(44 + 40 * j)).toBe(AT);
        seq += 1;
      }
    }
    expect(seq).toBe(16);
  });

  it("resumes from a draft this settler already opened", async () => {
    const s = setup();
    const bundle = s.bundleWith(4);
    const draft = draftAddress(s.pouch, hashNote(bundle.note), s.settler.publicKey);
    // A draft that has verified the first two hops.
    const parts = [
      Buffer.from(ACCOUNT_DISCRIMINATORS.SettlementDraft),
      Buffer.alloc(87),
      Buffer.from(hashNote(bundle.note)),
      Buffer.from(s.pouch.toBytes()),
      Buffer.from(s.owner.publicKey.toBytes()),
      Buffer.from(s.settler.publicKey.toBytes()),
      Buffer.alloc(8),
      Buffer.from([2]),
      Buffer.from(bundle.hops[1]!.relayer.toBytes()),
      Buffer.from([2, 0, 0, 0]),
      Buffer.from(bundle.hops[0]!.relayer.toBytes()),
      Buffer.from(bundle.hops[1]!.relayer.toBytes()),
      Buffer.from([255]),
    ];
    s.conn.set(draft, account(PROGRAM_ID, Buffer.concat(parts)));
    const plan = await buildSettlement(s.conn as never, { bundle, settler: s.settler.publicKey, lookupTables: [s.table] });
    expect(describePlan(plan)).toEqual([["ed25519x4", "extend_settlement"], ["finalize_settlement"]]);
  });
});

describe("buildSettlement: token accounts", () => {
  it("creates missing recipient and carrier accounts in the same transaction when they fit", async () => {
    const s = setup({ atas: false });
    const plan = await buildSettlement(s.conn as never, { bundle: s.bundleWith(0), settler: s.settler.publicKey, lookupTables: [s.table] });
    expect(describePlan(plan)).toEqual([["ata", "ed25519x1", "settle_note"]]);
  });

  it("moves them to a transaction of their own when they do not", async () => {
    const s = setup({ atas: false });
    const plan = await buildSettlement(s.conn as never, { bundle: s.bundleWith(2), settler: s.settler.publicKey, lookupTables: [s.table] });
    expect(plan.path).toBe("fast");
    expect(plan.steps).toEqual(["accounts", "settle"]);
    expect(describePlan(plan)).toEqual([["ata", "ata", "ata"], ["ed25519x5", "settle_note"]]);
    for (const n of plan.sizes) expect(n).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it("packs many missing accounts across several transactions on the draft path", async () => {
    const s = setup({ atas: false });
    const plan = await buildSettlement(s.conn as never, { bundle: s.bundleWith(16), settler: s.settler.publicKey, lookupTables: [s.table] });
    const ataCount = describePlan(plan).flat().filter((x) => x === "ata").length;
    expect(ataCount).toBe(17);
    for (const n of plan.sizes) expect(n).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });
});

describe("buildSettlement: refuses what cannot settle, before sending", () => {
  it("a slot that already settled", async () => {
    const s = setup();
    s.openPouch(s.pouch, [1n << 7n, 0n, 0n, 0n]);
    const err = await buildSettlement(s.conn as never, { bundle: s.bundleWith(0, 7), settler: s.settler.publicKey }).catch((e) => e);
    expect(err).toBeInstanceOf(CarrierClientError);
    expect(err.code).toBe("SlotAlreadySpent");
    expect(err.message).toBe("This payment was already settled.");
  });

  it("a bundle missing signatures, or naming a different sender", async () => {
    const s = setup();
    const b = s.bundleWith(1);
    await expect(buildSettlement(s.conn as never, { bundle: { ...b, entries: b.entries.slice(1) }, settler: s.settler.publicKey })).rejects.toThrow(/missing signatures/);
    await expect(buildSettlement(s.conn as never, { bundle: { ...b, owner: device().publicKey, hops: [], entries: b.entries.slice(0, 1) }, settler: s.settler.publicKey })).rejects.toThrow(/wrong sender/);
  });

  it("a pouch that does not exist", async () => {
    const s = setup();
    const b = s.bundleWith(0);
    s.conn.accounts.delete(s.pouch.toBase58());
    await expect(buildSettlement(s.conn as never, { bundle: b, settler: s.settler.publicKey })).rejects.toThrow(/does not exist/);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SLOTS_PER_EPOCH } from "@carrier/protocol";
import { IDL } from "./idl.js";
import { decodePouch, fetchPouch, nextFreeSlot, POUCH_ACCOUNT_SIZE, decodeSettlementDraft, ACCOUNT_DISCRIMINATORS } from "./accounts.js";
import { claimAddress, draftAddress, pouchAddress, PROGRAM_ID, vaultAddress } from "./pda.js";
import { account, encodePouch, FakeConnection } from "./testkit.js";

const k = () => Keypair.generate().publicKey;

describe("PDA derivations", () => {
  it("use the seed strings the program declares", () => {
    const src = readFileSync(new URL("../../../programs/carrier/src/instructions.rs", import.meta.url), "utf8");
    for (const [name, seed] of [
      ["POUCH_SEED", "pouch"],
      ["VAULT_SEED", "vault"],
      ["DRAFT_SEED", "draft"],
      ["CLAIM_SEED", "claim"],
    ]) {
      expect(src).toContain(`pub const ${name}: &[u8] = b"${seed}";`);
    }
    // And the seed order each account constraint uses.
    expect(src).toContain("seeds = [POUCH_SEED, owner.key().as_ref(), mint.key().as_ref()]");
    expect(src).toContain("seeds = [VAULT_SEED, pouch.key().as_ref()]");
    expect(src).toMatch(/DRAFT_SEED,\s*pouch\.key\(\)\.as_ref\(\),\s*note\.hash\(\)\.as_ref\(\),\s*settler\.key\(\)\.as_ref\(\)/);
    expect(src).toContain("seeds = [CLAIM_SEED, pouch.key().as_ref(), note_b.hash().as_ref()]");
  });

  it("derive the same addresses as raw findProgramAddressSync over those seeds", () => {
    const owner = k();
    const mint = k();
    const settler = k();
    const hash = new Uint8Array(32).map((_, i) => i);
    const enc = (s: string) => Buffer.from(s);
    const find = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

    const pouch = pouchAddress(owner, mint);
    expect(pouch.equals(find([enc("pouch"), owner.toBytes(), mint.toBytes()]))).toBe(true);
    expect(vaultAddress(pouch).equals(find([enc("vault"), pouch.toBytes()]))).toBe(true);
    expect(draftAddress(pouch, hash, settler).equals(find([enc("draft"), pouch.toBytes(), hash, settler.toBytes()]))).toBe(true);
    expect(claimAddress(pouch, hash).equals(find([enc("claim"), pouch.toBytes(), hash]))).toBe(true);
    expect(() => draftAddress(pouch, hash.subarray(1), settler)).toThrow();
  });

  it("match a fixed vector, so a silent change to derivation shows up", () => {
    const owner = new PublicKey(new Uint8Array(32).fill(1));
    const mint = new PublicKey(new Uint8Array(32).fill(9));
    const pouch = pouchAddress(owner, mint);
    // Printed by Pubkey::find_program_address in Rust against the program crate.
    expect(pouch.toBase58()).toBe("3pVzjghwVWoKkczcyvRvPQFsoSyWSgFrBqAZ5wVwsM8t");
    expect(vaultAddress(pouch).toBase58()).toBe("8ZN5syoRspjSBJCDn9aPh25GaR81mbKvwA2H7HKn811U");
  });
});

describe("pouch account", () => {
  const owner = k();
  const mint = k();
  const spent = [1n | (1n << 63n), 0n, 1n << 5n, (1n << 64n) - 1n];
  const fps = Array.from({ length: SLOTS_PER_EPOCH }, (_, i) => BigInt(i) * 0x0101010101n);
  const fields = {
    owner,
    mint,
    committed: 100_000_000n,
    settled: 12_345n,
    bond: 50_000_000n,
    epoch: 1_790_000_000,
    epochStartedAt: 1_790_000_000n,
    spent,
    settledFingerprints: fps,
    bump: 253,
    vaultBump: 251,
  };

  it("has the size the program allocates (8 + Pouch::INIT_SPACE)", () => {
    expect(POUCH_ACCOUNT_SIZE).toBe(8 + 32 + 32 + 8 + 8 + 8 + 4 + 8 + 32 + 2048 + 1 + 1);
    const pouchType = IDL.types.find((t) => t.name === "Pouch")!;
    expect((pouchType.type as { fields: readonly { name: string }[] }).fields.map((f) => f.name)).toEqual([
      "owner",
      "mint",
      "committed",
      "settled",
      "bond",
      "epoch",
      "epoch_started_at",
      "spent",
      "settled_fp",
      "bump",
      "vault_bump",
    ]);
  });

  it("round-trips through the Anchor layout", () => {
    const address = k();
    const p = decodePouch(address, encodePouch(fields));
    expect(p.address.equals(address)).toBe(true);
    expect(p.owner.equals(owner)).toBe(true);
    expect(p.mint.equals(mint)).toBe(true);
    expect(p.committed).toBe(100_000_000n);
    expect(p.settled).toBe(12_345n);
    expect(p.bond).toBe(50_000_000n);
    expect(p.epoch).toBe(1_790_000_000);
    expect(p.epochStartedAt).toBe(1_790_000_000n);
    expect(p.spent).toEqual(spent);
    expect(p.settledFingerprints).toEqual(fps);
    expect(p.bump).toBe(253);
    expect(p.vaultBump).toBe(251);
    expect(p.available).toBe(100_000_000n - 12_345n);
    expect(p.epochClosesAt).toBe(1_790_000_000n + 30n * 86_400n);
    expect(p.slashingEndsAt).toBe(1_790_000_000n + 37n * 86_400n);
  });

  it("reads the slot bitmap exactly like Pouch::is_slot_spent", () => {
    const p = decodePouch(k(), encodePouch(fields));
    const expected = new Set([0, 63, 128 + 5, ...Array.from({ length: 64 }, (_, i) => 192 + i)]);
    for (let i = 0; i < SLOTS_PER_EPOCH; i += 1) expect(p.isSlotSpent(i), `slot ${i}`).toBe(expected.has(i));
    expect(() => p.isSlotSpent(256)).toThrow(RangeError);
    expect(() => p.isSlotSpent(-1)).toThrow(RangeError);
  });

  it("never reports negative availability", () => {
    expect(decodePouch(k(), encodePouch({ ...fields, settled: 200_000_000n })).available).toBe(0n);
  });

  it("refuses data that is not a pouch", () => {
    const bad = encodePouch(fields);
    bad[0] ^= 1;
    expect(() => decodePouch(k(), bad)).toThrow(/not a Carrier pouch/);
    expect(() => decodePouch(k(), encodePouch(fields).subarray(0, 100))).toThrow(/too short/);
  });

  it("fetchPouch returns null for a missing account and refuses a foreign owner", async () => {
    const conn = new FakeConnection();
    const addr = k();
    expect(await fetchPouch(conn, addr)).toBeNull();
    conn.set(addr, account(k(), encodePouch(fields)));
    await expect(fetchPouch(conn, addr)).rejects.toThrow(/not owned/);
    conn.set(addr, account(PROGRAM_ID, encodePouch(fields)));
    expect((await fetchPouch(conn, addr))!.bond).toBe(50_000_000n);
  });
});

describe("nextFreeSlot", () => {
  const pouchWith = (spent: bigint[]) => decodePouch(k(), encodePouch({
    owner: k(), mint: k(), committed: 0n, settled: 0n, bond: 0n, epoch: 1, epochStartedAt: 1n, spent, bump: 0, vaultBump: 0,
  }));

  it("takes the lowest slot free onchain and locally", () => {
    const p = pouchWith([0b1011n, 0n, 0n, 0n]);
    expect(nextFreeSlot(p, new Set())).toBe(2);
    expect(nextFreeSlot(p, new Set([2, 4]))).toBe(5);
  });

  it("never reuses a slot this device signed, even if it has not settled", () => {
    const p = pouchWith([0n, 0n, 0n, 0n]);
    const used = new Set<number>();
    for (let i = 0; i < SLOTS_PER_EPOCH; i += 1) {
      const s = nextFreeSlot(p, used)!;
      expect(used.has(s)).toBe(false);
      used.add(s);
    }
    expect(nextFreeSlot(p, used)).toBeNull();
  });

  it("returns null when every slot is spent onchain", () => {
    const all = (1n << 64n) - 1n;
    expect(nextFreeSlot(pouchWith([all, all, all, all]), new Set())).toBeNull();
    expect(nextFreeSlot(pouchWith([all, all, all, all - (1n << 63n)]), new Set())).toBe(255);
  });
});

describe("settlement draft account", () => {
  it("decodes the SettlementDraft layout", () => {
    const note = { pouch: k(), to: k(), amount: 5n, slotIndex: 3, epoch: 9, expiry: 100n, relayFeeBps: 20 };
    const [owner, settler, a, b] = [k(), k(), k(), k()];
    const hash = new Uint8Array(32).fill(4);
    const parts: Buffer[] = [Buffer.from(ACCOUNT_DISCRIMINATORS.SettlementDraft)];
    const u = (n: number, bytes: number) => {
      const x = Buffer.alloc(bytes);
      x.writeUIntLE(n, 0, bytes);
      return x;
    };
    const i64 = (v: bigint) => {
      const x = Buffer.alloc(8);
      x.writeBigInt64LE(v);
      return x;
    };
    parts.push(Buffer.from(note.pouch.toBytes()), Buffer.from(note.to.toBytes()), i64(note.amount), u(3, 1), u(9, 4), i64(100n), u(20, 2));
    parts.push(Buffer.from(hash), Buffer.from(note.pouch.toBytes()), Buffer.from(owner.toBytes()), Buffer.from(settler.toBytes()));
    parts.push(i64(77n), u(2, 1), Buffer.from(b.toBytes()), u(2, 4), Buffer.from(a.toBytes()), Buffer.from(b.toBytes()), u(250, 1));
    const d = decodeSettlementDraft(k(), Buffer.concat(parts));
    expect(d.note).toEqual(note);
    expect(d.noteHash).toEqual(hash);
    expect(d.owner.equals(owner)).toBe(true);
    expect(d.settler.equals(settler)).toBe(true);
    expect(d.epochStartedAt).toBe(77n);
    expect(d.nextSeq).toBe(2);
    expect(d.lastCarrier.equals(b)).toBe(true);
    expect(d.lineage.map((x) => x.toBase58())).toEqual([a.toBase58(), b.toBase58()]);
    expect(d.bump).toBe(250);
  });
});

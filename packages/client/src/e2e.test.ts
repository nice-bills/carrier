/**
 * End to end against a live RPC: open a pouch, publish its lookup table,
 * carry notes offline through the mesh, settle them with this client.
 *
 * Skipped unless CARRIER_E2E_RPC is set. It needs an endpoint with the Carrier
 * program deployed at PROGRAM_ID and a working airdrop, for example:
 *
 *   solana-test-validator --bpf-program <PROGRAM_ID> target/deploy/carrier.so
 *   CARRIER_E2E_RPC=http://127.0.0.1:8899 npx vitest run src/e2e.test.ts
 *
 * It also runs under the native solana-program-test harness used during
 * development, which serves the same JSON-RPC calls from an in-process bank.
 */
import { describe, expect, it } from "vitest";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { Note } from "@carrier/protocol";
import {
  buildAddBondTx,
  buildOpenPouchTx,
  buildRefillTx,
  buildSettlement,
  createPouchLookupTable,
  fetchPouch,
  findPouchLookupTable,
  keypairSigner,
  nextFreeSlot,
  pouchAddress,
  requestDevnetAirdrop,
  settleBundle,
  signSendAndConfirm,
  SettlementFailedError,
  tokenAccountAmount,
  explainError,
} from "./index.js";
import { carry, device } from "./testkit.js";

const RPC = process.env.CARRIER_E2E_RPC;

describe.skipIf(!RPC)("end to end against a live program", () => {
  it("opens a pouch and settles fast, draft and duplicate notes", async () => {
    const connection = new Connection(RPC!, "confirmed");
    const owner = device();
    const settler = Keypair.generate();
    const recipient = device();
    const ownerSigner = keypairSigner(owner.keypair);
    const settlerSigner = keypairSigner(settler);
    const log = (...a: unknown[]) => console.log("  e2e:", ...a);

    await requestDevnetAirdrop(connection, owner.publicKey, 2 * LAMPORTS_PER_SOL);
    await requestDevnetAirdrop(connection, settler.publicKey, 2 * LAMPORTS_PER_SOL);

    // A fresh mint the owner controls, and some tokens in the owner's account.
    const mintKp = Keypair.generate();
    const mint = mintKp.publicKey;
    const ownerAta = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const setup = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: owner.publicKey,
        newAccountPubkey: mint,
        lamports: rent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint, 6, owner.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerAta, owner.publicKey, mint),
      createMintToInstruction(mint, ownerAta, owner.publicKey, 1_000_000_000n),
    );
    setup.feePayer = owner.publicKey;
    await signSendAndConfirm(connection, {
      publicKey: owner.publicKey,
      signTransaction: <T,>(tx: T) => {
        (tx as Transaction).partialSign(owner.keypair, mintKp);
        return tx;
      },
    }, setup);

    // --- open, refill, bond -------------------------------------------------
    await signSendAndConfirm(
      connection,
      ownerSigner,
      await buildOpenPouchTx(connection, { owner: owner.publicKey, mint, amount: 100_000_000n, bond: 50_000_000n }),
    );
    await signSendAndConfirm(connection, ownerSigner, await buildRefillTx(connection, { owner: owner.publicKey, mint, amount: 5_000_000n }));
    await signSendAndConfirm(connection, ownerSigner, await buildAddBondTx(connection, { owner: owner.publicKey, mint, amount: 1_000_000n }));

    const address = pouchAddress(owner.publicKey, mint);
    const pouch = (await fetchPouch(connection, address))!;
    expect(pouch.owner.equals(owner.publicKey)).toBe(true);
    expect(pouch.committed).toBe(105_000_000n);
    expect(pouch.bond).toBe(51_000_000n);
    expect(pouch.available).toBe(105_000_000n);
    log(`pouch ${address.toBase58()} epoch ${pouch.epoch}`);

    // --- the pouch's lookup table ---------------------------------------------
    const lut = await createPouchLookupTable(connection, {
      payer: owner.publicKey,
      pouch: address,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    for (const tx of lut.transactions) await signSendAndConfirm(connection, ownerSigner, tx);
    // Usable from the next slot.
    const startSlot = await connection.getSlot("confirmed");
    while ((await connection.getSlot("confirmed")) <= startSlot) await new Promise((r) => setTimeout(r, 200));
    const table = (await findPouchLookupTable(connection, { pouch: address, authority: owner.publicKey }))!;
    expect(table?.key.equals(lut.address)).toBe(true);

    const balance = async (who: PublicKey) => {
      const info = await connection.getAccountInfo(getAssociatedTokenAddressSync(mint, who));
      return info ? tokenAccountAmount(info.data) : 0n;
    };

    const used = new Set<number>();
    const at = pouch.epochStartedAt;
    const note = (amount: bigint, to = recipient.publicKey): Note => {
      const slotIndex = nextFreeSlot(pouch, used)!;
      used.add(slotIndex);
      return { pouch: address, to, amount, slotIndex, epoch: pouch.epoch, expiry: at + 86_400n, relayFeeBps: 200 };
    };

    // --- two hops, fast path through the discovered table --------------------
    const [a, b] = [device(), device()];
    const twoHop = carry(owner, note(10_000_000n), [a, b], at);
    const fast = await settleBundle(connection, settlerSigner, twoHop);
    log("two-hop", fast.path, fast.signatures.length, "tx");
    expect(fast.path).toBe("fast");
    expect(await balance(recipient.publicKey)).toBe(9_800_000n);
    expect(await balance(a.publicKey)).toBe(100_000n);
    expect(await balance(b.publicKey)).toBe(100_000n);
    const after = (await fetchPouch(connection, address))!;
    expect(after.isSlotSpent(twoHop.note.slotIndex)).toBe(true);
    expect(after.settled).toBe(10_000_000n);

    // Settling it again is refused before anything is sent.
    const again = await settleBundle(connection, settlerSigner, twoHop).catch((e) => e);
    expect(again).toBeInstanceOf(SettlementFailedError);
    expect(again.message).toBe("This payment was already settled.");

    // --- the program's own refusal, mapped to a sentence ----------------------
    // Two settlers race the same note: both plans are built while the slot is
    // free, the second lands after the first and the program refuses it.
    const race = carry(owner, note(1_000_000n), [], at);
    const rival = Keypair.generate();
    await requestDevnetAirdrop(connection, rival.publicKey, LAMPORTS_PER_SOL);
    const planA = await buildSettlement(connection, { bundle: race, settler: settler.publicKey, lookupTables: [table] });
    const planB = await buildSettlement(connection, { bundle: race, settler: rival.publicKey, lookupTables: [table] });
    for (const tx of planA.transactions) await signSendAndConfirm(connection, settlerSigner, tx);
    const lost = await signSendAndConfirm(connection, keypairSigner(rival), planB.transactions.at(-1)!).catch((e) => e);
    log("race loser:", explainError(lost));
    expect(explainError(lost)).toBe("This payment was already settled.");

    // --- three hops: draft path -----------------------------------------------
    const chain3 = [device(), device(), device()];
    const threeHop = carry(owner, note(20_000_000n), chain3, at);
    const draft = await settleBundle(connection, settlerSigner, threeHop, { lookupTables: [table] });
    log("three-hop", draft.path, draft.signatures.length, "txs");
    expect(draft.path).toBe("draft");
    for (const d of chain3) expect(await balance(d.publicKey)).toBe(133_333n);

    // --- two hops with no table: also the draft path ---------------------------
    const [c, d] = [device(), device()];
    const noTable = carry(owner, note(3_000_000n), [c, d], at);
    const plan = await buildSettlement(connection, { bundle: noTable, settler: settler.publicKey, lookupTables: [] as AddressLookupTableAccount[] });
    expect(plan.path).toBe("draft");
    const res = await settleBundle(connection, settlerSigner, noTable, { lookupTables: [] });
    expect(res.path).toBe("draft");
    expect(await balance(c.publicKey)).toBe(30_000n);

    const final = (await fetchPouch(connection, address))!;
    log(`settled ${final.settled} of ${final.committed}; slots used ${[...used].join(",")}`);
  }, 300_000);
});

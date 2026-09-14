import { describe, it, expect, beforeAll } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { existsSync, readFileSync } from "node:fs";
import {
  noteSigningPayload,
  hopSigningPayload,
  hashNote,
  createEd25519Instruction,
  type SignatureEntry,
} from "@carrier/protocol";

/**
 * End-to-end settlement against a validator.
 *
 * This is the test that matters. Everything about Carrier rests on one claim:
 * signatures produced on phones that were never online can be verified at
 * settlement, by a program that never sees those devices as signers. That path
 * runs through the ed25519 precompile and instruction introspection, which is
 * subtle enough that unit tests on the encoder prove very little. So we sign
 * exactly the way a phone would — raw nacl over the wire bytes, no wallet, no
 * RPC — and make the chain accept it.
 */

const PROGRAM_ID = new PublicKey("CJBPBb6WBPWptmpiW4Kdb7SeRC7Cmob5YAaBtKSMXBvt");
const POUCH_SEED = Buffer.from("pouch");
const VAULT_SEED = Buffer.from("vault");

const DECIMALS = 6;
const ONE_TOKEN = 10n ** BigInt(DECIMALS);

/** A device in the mesh: a keypair that signs bytes and never touches an RPC. */
class Device {
  readonly keypair: Keypair;
  constructor(keypair = Keypair.generate()) {
    this.keypair = keypair;
  }
  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }
  sign(message: Uint8Array): Uint8Array {
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
  entry(message: Uint8Array): SignatureEntry {
    return {
      publicKey: this.publicKey,
      signature: this.sign(message),
      message,
    };
  }
}

describe("carrier settlement", () => {
  let connection: Connection;
  let provider: anchor.AnchorProvider;
  let program: anchor.Program;
  let payer: Keypair;
  let mint: PublicKey;

  // The cast of the demo: a sender who goes offline, two strangers who carry
  // the note across town, and a recipient who is never present for any of it.
  let sender: Device;
  let relayerA: Device;
  let relayerB: Device;
  let recipient: Device;
  let settler: Keypair;

  let pouch: PublicKey;
  let vault: PublicKey;
  let recipientAta: PublicKey;
  let settlerAta: PublicKey;
  let relayerAAta: PublicKey;
  let relayerBAta: PublicKey;
  let lookupTable: anchor.web3.AddressLookupTableAccount;

  beforeAll(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    connection = provider.connection;
    payer = (provider.wallet as anchor.Wallet).payer;

    // Anchor refuses to publish an IDL account on localnet, so read the one the
    // build produced. Falls back to the chain for devnet/mainnet runs.
    const local = new URL("../target/idl/carrier.json", import.meta.url);
    const idl = existsSync(local)
      ? JSON.parse(readFileSync(local, "utf8"))
      : await anchor.Program.fetchIdl(PROGRAM_ID, provider);
    if (!idl) throw new Error("no IDL — run scripts/localnet.sh");
    program = new anchor.Program(idl, provider);

    sender = new Device();
    relayerA = new Device();
    relayerB = new Device();
    recipient = new Device();
    settler = Keypair.generate();

    // The sender needs lamports because opening a pouch is the one online step.
    for (const kp of [sender.keypair, settler]) {
      const sig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);

    const ataFor = async (owner: PublicKey) =>
      createAssociatedTokenAccount(connection, payer, mint, owner);

    recipientAta = await ataFor(recipient.publicKey);
    settlerAta = await ataFor(settler.publicKey);
    relayerAAta = await ataFor(relayerA.publicKey);
    relayerBAta = await ataFor(relayerB.publicKey);

    const senderAta = await ataFor(sender.publicKey);
    await mintTo(connection, payer, mint, senderAta, payer, 1000n * ONE_TOKEN);

    [pouch] = PublicKey.findProgramAddressSync(
      [POUCH_SEED, sender.publicKey.toBuffer(), mint.toBuffer()],
      PROGRAM_ID,
    );
    [vault] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, pouch.toBuffer()],
      PROGRAM_ID,
    );

    await program.methods
      .openPouch(new BN(100n * ONE_TOKEN), new BN(50n * ONE_TOKEN))
      .accounts({
        owner: sender.publicKey,
        pouch,
        vault,
        funding: senderAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([sender.keypair])
      .rpc();

    lookupTable = await buildLookupTable();
  }, 120_000);

  /** Put every account a settlement touches into one lookup table. */
  async function buildLookupTable(): Promise<anchor.web3.AddressLookupTableAccount> {
    const slot = await connection.getSlot("finalized");
    const [createIx, address] =
      anchor.web3.AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot,
      });

    const extendIx = anchor.web3.AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: address,
      addresses: [
        pouch,
        vault,
        recipientAta,
        settlerAta,
        relayerAAta,
        relayerBAta,
        mint,
        TOKEN_PROGRAM_ID,
        SYSVAR_INSTRUCTIONS_PUBKEY,
        PROGRAM_ID,
      ],
    });

    await provider.sendAndConfirm!(
      new anchor.web3.Transaction().add(createIx, extendIx),
      [payer],
    );

    // A table is only usable once its creation slot is behind the chain, so
    // give it one block rather than racing the first settlement against it.
    const start = await connection.getSlot("confirmed");
    while ((await connection.getSlot("confirmed")) <= start + 1) {
      await new Promise((r) => setTimeout(r, 200));
    }

    const fetched = await connection.getAddressLookupTable(address);
    if (!fetched.value) throw new Error("lookup table did not materialise");
    return fetched.value;
  }

  /**
   * How long a chain actually fits in one transaction.
   *
   * `MAX_HOPS` is a promise the mesh makes to itself: devices keep extending a
   * chain up to that length. If settlement cannot verify a chain that long, the
   * mesh manufactures bundles that can never be redeemed and nobody finds out
   * until the money fails to arrive. So the limit is measured here rather than
   * asserted, and `MAX_HOPS` is set to what this prints.
   */
  it("measures the real hop ceiling inside one transaction", async () => {
    const sizes: string[] = [];
    let ceiling = 0;

    for (let hops = 1; hops <= 8; hops += 1) {
      const chain = Array.from({ length: hops }, () => new Device());
      const note = buildNote(200 + hops, ONE_TOKEN);
      const { entries } = carry(note, chain);
      const claims = chain.map((d) => ({
        relayer: d.publicKey,
        at: new BN(Math.floor(Date.now() / 1000)),
      }));

      const settleIx = await program.methods
        .settleNote(noteArg(note), claims)
        .accounts({
          settler: settler.publicKey,
          pouch,
          vault,
          recipient: recipientAta,
          settlerPayout: settlerAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts(
          chain.map(() => ({
            pubkey: relayerAAta,
            isSigner: false,
            isWritable: true,
          })),
        )
        .instruction();

      const message = new anchor.web3.TransactionMessage({
        payerKey: settler.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [createEd25519Instruction(entries), settleIx],
      }).compileToV0Message([lookupTable]);

      let size: number;
      try {
        size = new anchor.web3.VersionedTransaction(message).serialize().length;
      } catch {
        // Serialization throws rather than reporting when it overflows.
        size = Number.POSITIVE_INFINITY;
      }
      const fits = size <= 1232;
      if (fits) ceiling = hops;
      sizes.push(`${hops} hop(s): ${Number.isFinite(size) ? size : ">1232"} bytes ${fits ? "ok" : "TOO LARGE"}`);
    }

    console.log("\n  transaction size by chain length\n  " + sizes.join("\n  "));
    console.log(`\n  => single-transaction ceiling: ${ceiling} hops\n`);

    expect(ceiling).toBeGreaterThanOrEqual(2);
  }, 120_000);

  /** Build a note the way a phone would: offline, against a chosen slot. */
  function buildNote(slotIndex: number, amount: bigint, relayFeeBps = 200) {
    return {
      pouch,
      to: recipient.publicKey,
      amount,
      slotIndex,
      epoch: 0,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60),
      relayFeeBps,
    };
  }

  /** Anchor wants camelCase + BN; the wire codec wants bigint. */
  function noteArg(note: ReturnType<typeof buildNote>) {
    return {
      pouch: note.pouch,
      to: note.to,
      amount: new BN(note.amount.toString()),
      slotIndex: note.slotIndex,
      epoch: note.epoch,
      expiry: new BN(note.expiry.toString()),
      relayFeeBps: note.relayFeeBps,
    };
  }

  /**
   * Hand the note down a chain of devices, co-signing each handoff.
   * Returns the hops plus every signature the precompile will need to verify.
   */
  function carry(note: ReturnType<typeof buildNote>, chain: Device[]) {
    const noteHash = hashNote(note);
    const hops: any[] = [];
    const entries: SignatureEntry[] = [sender.entry(noteSigningPayload(note))];

    let prev = sender;
    chain.forEach((relayer, seq) => {
      const hop = {
        noteHash,
        relayer: relayer.publicKey,
        prev: prev.publicKey,
        seq,
        at: BigInt(Math.floor(Date.now() / 1000)),
      };
      const message = hopSigningPayload(hop);

      // Both devices sign the same handoff — that mutual signature is what
      // makes a hop a proof of proximity rather than a claim.
      entries.push(relayer.entry(message));
      entries.push(prev.entry(message));

      // Only what the program cannot derive. noteHash, prev and seq are
      // rebuilt on-chain from the note and the position in the chain.
      hops.push({ relayer: hop.relayer, at: new BN(hop.at.toString()) });
      prev = relayer;
    });

    return { hops, entries };
  }

  async function balance(ata: PublicKey): Promise<bigint> {
    return (await getAccount(connection, ata)).amount;
  }

  /**
   * Send a settlement as a versioned transaction through the lookup table.
   *
   * A legacy transaction spends 32 bytes on every account key, and settling a
   * two-hop note touches twelve accounts — 384 bytes of the 1232 budget, on top
   * of the signatures the precompile needs. A lookup table turns each of those
   * into a one-byte index, which is the difference between settling a two-hop
   * chain and not. Real clients would keep one warm table per deployment; the
   * test builds one because it starts from an empty validator.
   */
  async function sendSettled(
    instructions: anchor.web3.TransactionInstruction[],
    signers: Keypair[],
  ): Promise<string> {
    const message = new anchor.web3.TransactionMessage({
      payerKey: settler.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions,
    }).compileToV0Message([lookupTable]);

    const tx = new anchor.web3.VersionedTransaction(message);
    tx.sign(signers);
    const sig = await connection.sendTransaction(tx);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    return sig;
  }

  it("settles a note that crossed two strangers with no connectivity", async () => {
    const amount = 10n * ONE_TOKEN;
    const note = buildNote(7, amount, 200); // 2% to the carriers
    const { hops, entries } = carry(note, [relayerA, relayerB]);

    const before = {
      recipient: await balance(recipientAta),
      relayerA: await balance(relayerAAta),
      relayerB: await balance(relayerBAta),
    };

    const settleIx = await program.methods
      .settleNote(noteArg(note), hops)
      .accounts({
        settler: settler.publicKey,
        pouch,
        vault,
        recipient: recipientAta,
        settlerPayout: settlerAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: relayerAAta, isSigner: false, isWritable: true },
        { pubkey: relayerBAta, isSigner: false, isWritable: true },
      ])
      .instruction();

    await sendSettled([createEd25519Instruction(entries), settleIx], [settler]);

    const relayFee = (amount * 200n) / 10_000n;
    const perRelayer = relayFee / 2n;

    expect(await balance(recipientAta)).toBe(before.recipient + amount - relayFee);
    // Carrying a stranger's payment paid. This is the whole reason the mesh has
    // carriers, so it gets asserted rather than assumed.
    expect(await balance(relayerAAta)).toBe(before.relayerA + perRelayer);
    expect(await balance(relayerBAta)).toBe(before.relayerB + perRelayer);

    const state: any = await program.account.pouch.fetch(pouch);
    expect(state.settled.toString()).toBe(amount.toString());
    // Slot 7 lives in the first word of the bitmap.
    expect((state.spent[0].toNumber() >> 7) & 1).toBe(1);
  }, 60_000);

  it("refuses to settle the same slot twice", async () => {
    const note = buildNote(7, 5n * ONE_TOKEN);
    const { hops, entries } = carry(note, [relayerA]);

    await expect(
      program.methods
        .settleNote(noteArg(note), hops)
        .accounts({
          settler: settler.publicKey,
          pouch,
          vault,
          recipient: recipientAta,
          settlerPayout: settlerAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: relayerAAta, isSigner: false, isWritable: true },
        ])
        .preInstructions([createEd25519Instruction(entries)])
        .signers([settler])
        .rpc(),
    ).rejects.toThrow(/SlotAlreadySpent/);
  }, 60_000);

  it("rejects a note whose signature was never verified by the precompile", async () => {
    const note = buildNote(9, ONE_TOKEN);
    const { hops } = carry(note, [relayerA]);

    // Everything is well-formed except that we never prepend the precompile
    // instruction. Without it the program has no evidence the sender authorised
    // anything, and must refuse.
    await expect(
      program.methods
        .settleNote(noteArg(note), hops)
        .accounts({
          settler: settler.publicKey,
          pouch,
          vault,
          recipient: recipientAta,
          settlerPayout: settlerAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: relayerAAta, isSigner: false, isWritable: true },
        ])
        .signers([settler])
        .rpc(),
    ).rejects.toThrow(/SignatureNotVerified/);
  }, 60_000);

  it("rejects a hop chain with a forged link", async () => {
    const note = buildNote(11, ONE_TOKEN);
    const noteHash = hashNote(note);
    const entries: SignatureEntry[] = [sender.entry(noteSigningPayload(note))];

    // relayerB claims it received the note from relayerA, but relayerA never
    // co-signed that handoff — relayerB signed both halves itself.
    const hop = {
      noteHash,
      relayer: relayerB.publicKey,
      prev: relayerA.publicKey,
      seq: 0,
      at: BigInt(Math.floor(Date.now() / 1000)),
    };
    const message = hopSigningPayload(hop);
    entries.push(relayerB.entry(message));

    await expect(
      program.methods
        .settleNote(noteArg(note), [
          { relayer: hop.relayer, at: new BN(hop.at.toString()) },
        ])
        .accounts({
          settler: settler.publicKey,
          pouch,
          vault,
          recipient: recipientAta,
          settlerPayout: settlerAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: relayerBAta, isSigner: false, isWritable: true },
        ])
        .preInstructions([createEd25519Instruction(entries)])
        .signers([settler])
        .rpc(),
    ).rejects.toThrow(/HopChainBroken|SignatureNotVerified/);
  }, 60_000);

  it("slashes the bond when the sender signs two notes against one slot", async () => {
    // The attack the protocol admits to: same slot, two recipients, both valid.
    const noteA = buildNote(42, 3n * ONE_TOKEN);
    const noteB = { ...buildNote(42, 3n * ONE_TOKEN), to: relayerA.publicKey };

    const entries = [
      sender.entry(noteSigningPayload(noteA)),
      sender.entry(noteSigningPayload(noteB)),
    ];

    const victimBefore = await balance(relayerAAta);
    const state: any = await program.account.pouch.fetch(pouch);
    const bond = BigInt(state.bond.toString());
    expect(bond).toBeGreaterThan(0n);

    await program.methods
      .proveDoubleSpend(noteArg(noteA), noteArg(noteB))
      .accounts({
        prover: settler.publicKey,
        pouch,
        vault,
        victim: relayerAAta,
        proverPayout: settlerAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([createEd25519Instruction(entries)])
      .signers([settler])
      .rpc();

    const proverCut = bond / 10n;
    const victimCut = bond - proverCut;

    // The victim is made whole from the cheat's own stake.
    expect(await balance(relayerAAta)).toBe(victimBefore + victimCut);

    const after: any = await program.account.pouch.fetch(pouch);
    expect(after.bond.toString()).toBe("0");
  }, 60_000);
});

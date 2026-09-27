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
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { existsSync, readFileSync } from "node:fs";
import {
  MAX_HOPS,
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
const DRAFT_SEED = Buffer.from("draft");
const CLAIM_SEED = Buffer.from("claim");

const DECIMALS = 6;
const ONE_TOKEN = 10n ** BigInt(DECIMALS);
const BOND = 50n * ONE_TOKEN;

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
  let epoch: number;
  let senderAta: PublicKey;
  let recipientAta: PublicKey;
  let settlerAta: PublicKey;
  let relayerAAta: PublicKey;
  let relayerBAta: PublicKey;
  let lookupTable: anchor.web3.AddressLookupTableAccount;

  beforeAll(async () => {
    // Anchor's default commitment is `processed`, which is fine against a local
    // validator and wrong against a real cluster: a blockhash fetched at that
    // commitment can be newer than the node asked to simulate against it, and
    // the whole run dies on "Blockhash not found" before a single test runs.
    // `confirmed` costs a little latency and makes the suite survive devnet.
    const env = anchor.AnchorProvider.env();
    connection = new Connection(env.connection.rpcEndpoint, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 90_000,
    });
    provider = new anchor.AnchorProvider(connection, env.wallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    anchor.setProvider(provider);
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
    await fund([sender.publicKey, settler.publicKey], LAMPORTS_PER_SOL);

    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);

    recipientAta = await ataFor(recipient.publicKey);
    settlerAta = await ataFor(settler.publicKey);
    relayerAAta = await ataFor(relayerA.publicKey);
    relayerBAta = await ataFor(relayerB.publicKey);

    senderAta = await ataFor(sender.publicKey);
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
      .openPouch(new BN((100n * ONE_TOKEN).toString()), new BN(BOND.toString()))
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

    // The first epoch is the time the pouch opened, so a reopened pouch never
    // reuses an old epoch number.
    epoch = (await pouchState()).epoch;
    expect(epoch).toBeGreaterThan(1_600_000_000);

    lookupTable = await buildLookupTable();
  }, 120_000);

  async function ataFor(owner: PublicKey): Promise<PublicKey> {
    return createAssociatedTokenAccount(connection, payer, mint, owner);
  }

  /** Untyped: the program is built from a JSON IDL, not generated types. */
  async function pouchState(): Promise<any> {
    return (program.account as any).pouch.fetch(pouch);
  }

  /**
   * Give the cast enough lamports to sign with.
   *
   * Airdrops only exist on a local validator. Devnet's faucet is rate-limited
   * per IP and will refuse a run that wants several funded keypairs, so on any
   * real cluster the money comes from the wallet that is already paying — which
   * is what a deployment script would do anyway.
   */
  async function fund(targets: PublicKey[], lamports: number) {
    const local = connection.rpcEndpoint.includes("localhost") ||
      connection.rpcEndpoint.includes("127.0.0.1");

    if (local) {
      for (const target of targets) {
        const sig = await connection.requestAirdrop(target, lamports);
        await connection.confirmTransaction(sig, "confirmed");
      }
      return;
    }

    const tx = new anchor.web3.Transaction();
    for (const target of targets) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: target,
          lamports,
        }),
      );
    }
    await provider.sendAndConfirm!(tx, [payer]);
  }

  /**
   * The lookup table a real settler can count on.
   *
   * Only accounts that are the same for every note from this pouch: the pouch,
   * its vault, the mint, and fixed program ids. The owner would publish this
   * when opening the pouch. Recipient, relayer and settler accounts differ per
   * payment, so they are not in it and cost 32 bytes each (audit M8).
   */
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
      await sleep(200);
    }

    const fetched = await connection.getAddressLookupTable(address);
    if (!fetched.value) throw new Error("lookup table did not materialise");
    return fetched.value;
  }

  /** Accounts every `settle_note` call shares. */
  function settleAccounts(recipientAccount = recipientAta) {
    return {
      settler: settler.publicKey,
      pouch,
      vault,
      recipient: recipientAccount,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    };
  }

  function writable(pubkeys: PublicKey[]) {
    return pubkeys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  }

  /** Settle a note in one transaction and wait for it. */
  async function settle(
    note: ReturnType<typeof buildNote>,
    chain: Device[],
    relayerAtas: PublicKey[],
    recipientAccount = recipientAta,
  ) {
    const { hops, entries } = carry(note, chain);
    const ix = await program.methods
      .settleNote(noteArg(note), hops)
      .accounts(settleAccounts(recipientAccount))
      .remainingAccounts(writable(relayerAtas))
      .instruction();
    return sendSettled([createEd25519Instruction(entries), ix], [settler]);
  }

  function draftAddress(note: ReturnType<typeof buildNote>, by: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [DRAFT_SEED, pouch.toBuffer(), Buffer.from(hashNote(note)), by.toBuffer()],
      PROGRAM_ID,
    )[0];
  }

  function claimAddress(losing: ReturnType<typeof buildNote>): PublicKey {
    return PublicKey.findProgramAddressSync(
      [CLAIM_SEED, pouch.toBuffer(), Buffer.from(hashNote(losing))],
      PROGRAM_ID,
    )[0];
  }

  /**
   * A chain longer than one transaction can verify.
   *
   * This is the point of the draft: signature checking is what does not fit, so
   * it is accumulated across several transactions and the payout happens once,
   * at the end. Four hops is twice what `settle_note` can manage.
   */
  it("settles a four-hop chain by accumulating verification", async () => {
    const chain = [new Device(), new Device(), new Device(), new Device()];
    const atas = await Promise.all(chain.map((d) => ataFor(d.publicKey)));

    const amount = 20n * ONE_TOKEN;
    const note = buildNote(88, amount, 400); // 4% split four ways
    const { entries, times: hopTimes } = carry(note, chain);
    const draft = draftAddress(note, settler.publicKey);

    // 1. Prove the sender authorised the note. One signature.
    await program.methods
      .beginSettlement(noteArg(note))
      .accounts({
        settler: settler.publicKey,
        pouch,
        draft,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([createEd25519Instruction([entries[0]!])])
      .signers([settler])
      .rpc();

    // 2. Verify the hops two at a time — exactly what fits in one transaction.
    for (let i = 0; i < chain.length; i += 2) {
      const batch = chain.slice(i, i + 2);
      // entries[0] is the note; each hop contributes two co-signatures.
      const hopEntries = entries.slice(1 + i * 2, 1 + (i + batch.length) * 2);

      await program.methods
        .extendSettlement(
          batch.map((d, j) => ({
            relayer: d.publicKey,
            at: new BN(hopTimes[i + j]!.toString()),
          })),
        )
        .accounts({
          settler: settler.publicKey,
          draft,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([createEd25519Instruction(hopEntries)])
        .signers([settler])
        .rpc();
    }

    const before = await Promise.all(atas.map(balance));
    const recipientBefore = await balance(recipientAta);

    // 3. Pay out. No signatures here at all — they are already verified.
    await program.methods
      .finalizeSettlement()
      .accounts({
        settler: settler.publicKey,
        pouch,
        draft,
        vault,
        recipient: recipientAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(writable(atas))
      .signers([settler])
      .rpc();

    const relayFee = (amount * 400n) / 10_000n;
    const perRelayer = relayFee / 4n;

    expect(await balance(recipientAta)).toBe(recipientBefore + amount - relayFee);
    for (let i = 0; i < atas.length; i += 1) {
      expect(await balance(atas[i]!)).toBe(before[i]! + perRelayer);
    }

    // The draft is gone and its rent returned.
    expect(await connection.getAccountInfo(draft)).toBeNull();

    const state = await pouchState();
    expect((state.spent[1].toNumber() >> (88 - 64)) & 1).toBe(1);
  }, 120_000);

  /**
   * Taking a relay fee without carrying anything.
   *
   * Neither rule stops one person with two phones — nothing on-chain can, since
   * two phones in a pocket are genuinely two keys that genuinely met. What they
   * close are the cheaper versions: bouncing a note between two keys to mint
   * hops, and the sender quietly paying themselves a carrier's share.
   */
  it("refuses a chain where the same key carries twice", async () => {
    const note = buildNote(120, ONE_TOKEN);
    const noteHash = hashNote(note);
    const entries: SignatureEntry[] = [sender.entry(noteSigningPayload(note))];

    // sender -> A -> A. Both hops are genuinely co-signed; A simply appears
    // twice, which would earn it two shares of a fixed pot.
    const claims: any[] = [];
    let prev: Device = sender;
    for (let seq = 0; seq < 2; seq += 1) {
      const at = nowSeconds();
      const hop = { noteHash, relayer: relayerA.publicKey, prev: prev.publicKey, seq, at };
      const message = hopSigningPayload(hop);
      entries.push(relayerA.entry(message), prev.entry(message));
      claims.push({ relayer: relayerA.publicKey, at: new BN(at.toString()) });
      prev = relayerA;
    }

    const ix = await program.methods
      .settleNote(noteArg(note), claims)
      .accounts(settleAccounts())
      .remainingAccounts(writable([relayerAAta, relayerAAta]))
      .instruction();

    await expect(
      sendSettled([createEd25519Instruction(entries), ix], [settler]),
    ).rejects.toThrow(/RepeatedCarrier/);
  }, 60_000);

  it("refuses to pay the sender as one of its own carriers", async () => {
    const note = buildNote(121, ONE_TOKEN);
    const noteHash = hashNote(note);
    const at = nowSeconds();

    // The sender hands to itself: a real co-signed hop, but the sender is a
    // party to the payment, not a carrier of it.
    const hop = {
      noteHash,
      relayer: sender.publicKey,
      prev: sender.publicKey,
      seq: 0,
      at,
    };
    const message = hopSigningPayload(hop);
    const entries: SignatureEntry[] = [
      sender.entry(noteSigningPayload(note)),
      sender.entry(message),
    ];

    const ix = await program.methods
      .settleNote(noteArg(note), [
        { relayer: sender.publicKey, at: new BN(at.toString()) },
      ])
      .accounts(settleAccounts())
      .remainingAccounts(writable([senderAta]))
      .instruction();

    await expect(
      sendSettled([createEd25519Instruction(entries), ix], [settler]),
    ).rejects.toThrow(/SelfDealingCarrier/);
  }, 60_000);

  /**
   * How long a chain actually fits in one transaction.
   *
   * `MAX_HOPS` is a promise the mesh makes to itself: devices keep extending a
   * chain up to that length. If settlement cannot verify a chain that long, the
   * mesh manufactures bundles that can never be redeemed and nobody finds out
   * until the money fails to arrive. So the limit is measured here rather than
   * asserted, and `MAX_HOPS` is set to what this prints.
   *
   * Measured the way a real settlement looks: every carrier has their own token
   * account, and neither those nor the recipient's are in the lookup table.
   * Only the pouch table is (see `buildLookupTable`).
   */
  it("measures the real hop ceiling inside one transaction", async () => {
    const sizes: string[] = [];
    let ceiling = -1;

    for (let hops = 0; hops <= 4; hops += 1) {
      const chain = Array.from({ length: hops }, () => new Device());
      const note = buildNote(200 + hops, ONE_TOKEN);
      const { hops: claims, entries } = carry(note, chain);
      const relayerAtas = chain.map((d) =>
        getAssociatedTokenAddressSync(mint, d.publicKey),
      );

      const settleIx = await program.methods
        .settleNote(noteArg(note), claims)
        .accounts(settleAccounts())
        .remainingAccounts(writable(relayerAtas))
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

    expect(ceiling).toBeGreaterThanOrEqual(MAX_HOPS);
  }, 120_000);

  /** Build a note the way a phone would: offline, against a chosen slot. */
  function buildNote(
    slotIndex: number,
    amount: bigint,
    relayFeeBps = 200,
    to: PublicKey = recipient.publicKey,
    expiry = nowSeconds() + 24n * 60n * 60n,
  ) {
    return {
      pouch,
      to,
      amount,
      slotIndex,
      epoch,
      expiry,
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
    // The exact instants that were signed. A claim built from a fresh
    // `Date.now()` would describe a different hop and fail to verify.
    const times: bigint[] = [];
    const entries: SignatureEntry[] = [sender.entry(noteSigningPayload(note))];

    let prev = sender;
    chain.forEach((relayer, seq) => {
      const at = nowSeconds();
      times.push(at);
      const hop = {
        noteHash,
        relayer: relayer.publicKey,
        prev: prev.publicKey,
        seq,
        at,
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

    return { hops, entries, times };
  }

  function nowSeconds(): bigint {
    return BigInt(Math.floor(Date.now() / 1000));
  }

  function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function balance(ata: PublicKey): Promise<bigint> {
    return (await getAccount(connection, ata)).amount;
  }

  /** The validator's clock, which is what `Clock::unix_timestamp` reads. */
  async function chainTime(): Promise<bigint> {
    const slot = await connection.getSlot("confirmed");
    const time = await connection.getBlockTime(slot);
    return BigInt(time ?? Math.floor(Date.now() / 1000));
  }

  /**
   * Send a settlement as a versioned transaction through the lookup table.
   *
   * A legacy transaction spends 32 bytes on every account key. A lookup table
   * turns the ones shared by every note from this pouch into one-byte indexes,
   * which is the difference between settling a two-hop chain and not.
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
    const result = await connection.confirmTransaction(
      { signature: sig, ...bh },
      "confirmed",
    );
    // Preflight catches most failures, but a transaction can still land and
    // fail. Confirmation reports that in `err` rather than throwing.
    if (result.value.err) {
      throw new Error(`transaction ${sig} failed: ${JSON.stringify(result.value.err)}`);
    }
    return sig;
  }

  it("settles a note that crossed two strangers with no connectivity", async () => {
    const amount = 10n * ONE_TOKEN;
    const note = buildNote(7, amount, 200); // 2% to the carriers

    const settledBefore = BigInt((await pouchState()).settled.toString());
    const before = {
      recipient: await balance(recipientAta),
      relayerA: await balance(relayerAAta),
      relayerB: await balance(relayerBAta),
    };

    await settle(note, [relayerA, relayerB], [relayerAAta, relayerBAta]);

    const relayFee = (amount * 200n) / 10_000n;
    const perRelayer = relayFee / 2n;

    expect(await balance(recipientAta)).toBe(before.recipient + amount - relayFee);
    // Carrying a stranger's payment paid. This is the whole reason the mesh has
    // carriers, so it gets asserted rather than assumed.
    expect(await balance(relayerAAta)).toBe(before.relayerA + perRelayer);
    expect(await balance(relayerBAta)).toBe(before.relayerB + perRelayer);

    const state = await pouchState();
    // A delta, not an absolute: other tests in this file settle against the
    // same pouch, so the running total is not this note's amount. The fee
    // splits evenly here, so all of it left the vault.
    expect(BigInt(state.settled.toString()) - settledBefore).toBe(amount);
    // Slot 7 lives in the first word of the bitmap.
    expect((state.spent[0].toNumber() >> 7) & 1).toBe(1);
  }, 60_000);

  /**
   * Dropping every hop used to hand the settler the whole relay fee. Now the
   * unearned fee stays in the vault, so there is nothing to gain by it.
   */
  it("pays no bounty when a note settles with no hops", async () => {
    const amount = 5n * ONE_TOKEN;
    const note = buildNote(8, amount, 200);
    const relayFee = (amount * 200n) / 10_000n;

    const settledBefore = BigInt((await pouchState()).settled.toString());
    const recipientBefore = await balance(recipientAta);
    const settlerBefore = await balance(settlerAta);
    const vaultBefore = await balance(vault);

    await settle(note, [], []);

    expect(await balance(recipientAta)).toBe(recipientBefore + amount - relayFee);
    expect(await balance(settlerAta)).toBe(settlerBefore);
    // Only the recipient's share left. The fee is still the owner's.
    expect(await balance(vault)).toBe(vaultBefore - (amount - relayFee));
    const state = await pouchState();
    expect(BigInt(state.settled.toString()) - settledBefore).toBe(amount - relayFee);
  }, 60_000);

  it("refuses to settle the same slot twice", async () => {
    await settle(buildNote(12, ONE_TOKEN), [relayerA], [relayerAAta]);

    const replay = buildNote(12, 5n * ONE_TOKEN);
    await expect(
      settle(replay, [relayerA], [relayerAAta]),
    ).rejects.toThrow(/SlotAlreadySpent/);
  }, 60_000);

  it("rejects a note whose signature was never verified by the precompile", async () => {
    const note = buildNote(9, ONE_TOKEN);
    const { hops } = carry(note, [relayerA]);

    // Everything is well-formed except that we never prepend the precompile
    // instruction. Without it the program has no evidence the sender authorised
    // anything, and must refuse.
    const ix = await program.methods
      .settleNote(noteArg(note), hops)
      .accounts(settleAccounts())
      .remainingAccounts(writable([relayerAAta]))
      .instruction();

    await expect(sendSettled([ix], [settler])).rejects.toThrow(/SignatureNotVerified/);
  }, 60_000);

  it("rejects a handoff the previous carrier never signed", async () => {
    const note = buildNote(11, ONE_TOKEN);
    const noteHash = hashNote(note);
    const at = nowSeconds();

    // sender -> A is genuine. A -> B is not: B signed both halves itself and
    // A never agreed to hand the note on.
    const first = { noteHash, relayer: relayerA.publicKey, prev: sender.publicKey, seq: 0, at };
    const second = { noteHash, relayer: relayerB.publicKey, prev: relayerA.publicKey, seq: 1, at };
    const firstMsg = hopSigningPayload(first);
    const secondMsg = hopSigningPayload(second);
    const entries: SignatureEntry[] = [
      sender.entry(noteSigningPayload(note)),
      relayerA.entry(firstMsg),
      sender.entry(firstMsg),
      relayerB.entry(secondMsg),
    ];

    const ix = await program.methods
      .settleNote(noteArg(note), [
        { relayer: relayerA.publicKey, at: new BN(at.toString()) },
        { relayer: relayerB.publicKey, at: new BN(at.toString()) },
      ])
      .accounts(settleAccounts())
      .remainingAccounts(writable([relayerAAta, relayerBAta]))
      .instruction();

    await expect(
      sendSettled([createEd25519Instruction(entries), ix], [settler]),
    ).rejects.toThrow(/SignatureNotVerified/);
  }, 60_000);

  /**
   * Topping up used to start a new epoch, which voided every note already in
   * someone's pocket. Now it only adds money.
   */
  it("refills without touching the epoch or the slots", async () => {
    const before = await pouchState();

    await program.methods
      .refillPouch(new BN((10n * ONE_TOKEN).toString()))
      .accounts({
        owner: sender.publicKey,
        pouch,
        vault,
        funding: senderAta,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender.keypair])
      .rpc();

    const after = await pouchState();
    expect(after.epoch).toBe(before.epoch);
    expect(after.epochStartedAt.toString()).toBe(before.epochStartedAt.toString());
    expect(BigInt(after.committed.toString()) - BigInt(before.committed.toString()))
      .toBe(10n * ONE_TOKEN);
    expect(after.spent.map((w: BN) => w.toString()))
      .toEqual(before.spent.map((w: BN) => w.toString()));
  }, 60_000);

  it("will not advance the epoch or close while notes can still settle", async () => {
    await expect(
      program.methods
        .advanceEpoch()
        .accounts({ owner: sender.publicKey, pouch })
        .signers([sender.keypair])
        .rpc(),
    ).rejects.toThrow(/EpochStillOpen/);

    await expect(
      program.methods
        .closePouch()
        .accounts({
          owner: sender.publicKey,
          pouch,
          vault,
          destination: senderAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender.keypair])
        .rpc(),
    ).rejects.toThrow(/PouchNotDrainable/);
  }, 60_000);

  describe("double spend", () => {
    // The attack the protocol admits to: same slot, two recipients, both
    // validly signed. The recipient's note settles; the victim's loses.
    const SLOT = 42;
    let victim: Device;
    let victimAta: PublicKey;
    let winner: ReturnType<typeof buildNote>;
    let loser: ReturnType<typeof buildNote>;

    beforeAll(async () => {
      victim = new Device();
      victimAta = await ataFor(victim.publicKey);
      winner = buildNote(SLOT, 3n * ONE_TOKEN);
      loser = buildNote(SLOT, 3n * ONE_TOKEN, 200, victim.publicKey);
      await settle(winner, [], []);
    }, 60_000);

    function prove(
      settled: ReturnType<typeof buildNote>,
      losing: ReturnType<typeof buildNote>,
      victimAccount: PublicKey,
    ) {
      return program.methods
        .proveDoubleSpend(noteArg(settled), noteArg(losing))
        .accounts({
          prover: settler.publicKey,
          pouch,
          vault,
          victim: victimAccount,
          proverPayout: settlerAta,
          claim: claimAddress(losing),
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([
          createEd25519Instruction([
            sender.entry(noteSigningPayload(settled)),
            sender.entry(noteSigningPayload(losing)),
          ]),
        ])
        .signers([settler])
        .rpc();
    }

    it("refuses to pay anyone but the losing note's recipient", async () => {
      // The prover's own account, as a cheating sender would try.
      await expect(prove(winner, loser, relayerAAta)).rejects.toThrow(/VictimMismatch/);
    }, 60_000);

    it("refuses a proof that names the losing note as the settled one", async () => {
      await expect(prove(loser, winner, recipientAta)).rejects.toThrow(/NoteNotSettled/);
    }, 60_000);

    it("pays the victim from the bond and keeps the rest for others", async () => {
      const victimBefore = await balance(victimAta);
      const proverBefore = await balance(settlerAta);
      const bondBefore = BigInt((await pouchState()).bond.toString());
      expect(bondBefore).toBeGreaterThan(loser.amount);

      await prove(winner, loser, victimAta);

      const toVictim = loser.amount;
      const toProver = loser.amount / 10n;
      expect(await balance(victimAta)).toBe(victimBefore + toVictim);
      expect(await balance(settlerAta)).toBe(proverBefore + toProver);

      const after = await pouchState();
      expect(BigInt(after.bond.toString())).toBe(bondBefore - toVictim - toProver);
    }, 60_000);

    it("pays each losing note once", async () => {
      await expect(prove(winner, loser, victimAta)).rejects.toThrow(/already in use|0x0/);
    }, 60_000);

    it("never pays the owner for their own double spend", async () => {
      const settled = buildNote(43, ONE_TOKEN);
      const toSelf = buildNote(43, ONE_TOKEN, 200, sender.publicKey);
      await settle(settled, [], []);
      await expect(prove(settled, toSelf, senderAta)).rejects.toThrow(/VictimIsOwner/);
    }, 60_000);

    it("lets the owner top the bond back up", async () => {
      const before = BigInt((await pouchState()).bond.toString());
      await program.methods
        .addBond(new BN((5n * ONE_TOKEN).toString()))
        .accounts({
          owner: sender.publicKey,
          pouch,
          vault,
          funding: senderAta,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender.keypair])
        .rpc();
      const after = BigInt((await pouchState()).bond.toString());
      expect(after - before).toBe(5n * ONE_TOKEN);
    }, 60_000);
  });

  /**
   * A draft nobody finishes used to lock its rent and its slot for good. Once
   * the note has expired, anyone can clear it, and the rent goes back to
   * whoever opened it.
   */
  it("lets anyone close a draft once its note has expired", async () => {
    const expiry = (await chainTime()) + 6n;
    const note = buildNote(150, ONE_TOKEN, 200, recipient.publicKey, expiry);
    const draft = draftAddress(note, settler.publicKey);

    await program.methods
      .beginSettlement(noteArg(note))
      .accounts({
        settler: settler.publicKey,
        pouch,
        draft,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        createEd25519Instruction([sender.entry(noteSigningPayload(note))]),
      ])
      .signers([settler])
      .rpc();

    // A stranger pays the fee. They are not the settler and sign nothing else.
    const stranger = Keypair.generate();
    await fund([stranger.publicKey], LAMPORTS_PER_SOL / 10);
    const strangerProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(stranger),
      { commitment: "confirmed", preflightCommitment: "confirmed" },
    );
    const asStranger = new anchor.Program(program.idl, strangerProvider);
    const closeAsStranger = () =>
      asStranger.methods
        .closeExpiredDraft()
        .accounts({ draft, settler: settler.publicKey })
        .rpc();

    await expect(closeAsStranger()).rejects.toThrow(/DraftNotExpired/);

    while ((await chainTime()) <= expiry) await sleep(500);
    // One more slot so the next transaction's clock is past expiry too.
    await sleep(1_000);

    const rentBefore = await connection.getBalance(settler.publicKey);
    await closeAsStranger();
    expect(await connection.getAccountInfo(draft)).toBeNull();
    expect(await connection.getBalance(settler.publicKey)).toBeGreaterThan(rentBefore);
  }, 60_000);
});

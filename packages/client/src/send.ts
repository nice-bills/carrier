import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type BlockhashWithExpiryBlockHeight,
  type Commitment,
  type Connection,
} from "@solana/web3.js";

/**
 * Anything that can sign a transaction for one key: a wallet adapter, a
 * secure-enclave bridge, or `keypairSigner` below.
 */
export interface TransactionSigner {
  readonly publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> | T;
}

/** Wrap a local keypair. For tests and scripts; phones should keep keys in secure storage. */
export function keypairSigner(keypair: Keypair): TransactionSigner {
  return {
    publicKey: keypair.publicKey,
    signTransaction<T extends Transaction | VersionedTransaction>(tx: T): T {
      if (tx instanceof VersionedTransaction) tx.sign([keypair]);
      else tx.partialSign(keypair);
      return tx;
    },
  };
}

/** A transaction that landed and failed. `err` is the runtime's error object. */
export class TransactionFailedError extends Error {
  constructor(
    readonly signature: string,
    readonly err: unknown,
  ) {
    super(`transaction ${signature} failed: ${JSON.stringify(err)}`);
    this.name = "TransactionFailedError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a signature by polling, not by websocket subscription: phones drop
 * sockets on every network change, and polling survives that.
 */
export async function confirmSignature(
  connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">,
  signature: string,
  blockhash: Pick<BlockhashWithExpiryBlockHeight, "lastValidBlockHeight">,
  commitment: Commitment = "confirmed",
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const wantFinal = commitment === "finalized";
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) throw new TransactionFailedError(signature, status.err);
      const level = status.confirmationStatus;
      if (level === "finalized" || (!wantFinal && level === "confirmed")) return;
    } else if ((await connection.getBlockHeight("confirmed")) > blockhash.lastValidBlockHeight) {
      throw new Error(`transaction ${signature} expired: block height exceeded`);
    }
    if (Date.now() > deadline) throw new Error(`transaction ${signature} timed out`);
    await sleep(pollMs);
  }
}

/**
 * Put a fresh blockhash on `tx`, have `signer` sign it, send it, and wait
 * until it is confirmed. Returns the signature.
 */
export async function signSendAndConfirm(
  connection: Pick<
    Connection,
    "getLatestBlockhash" | "sendRawTransaction" | "getSignatureStatuses" | "getBlockHeight"
  >,
  signer: TransactionSigner,
  tx: Transaction | VersionedTransaction,
  commitment: Commitment = "confirmed",
): Promise<string> {
  const bh = await connection.getLatestBlockhash(commitment);
  if (tx instanceof VersionedTransaction) {
    tx.message.recentBlockhash = bh.blockhash;
  } else {
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer ??= signer.publicKey;
  }
  const signed = await signer.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: commitment,
  });
  await confirmSignature(connection, signature, bh, commitment);
  return signature;
}

/**
 * Ask a devnet or localnet faucet for SOL and wait for it. Devnet limits
 * this per IP and per day; expect it to fail sometimes.
 */
export async function requestDevnetAirdrop(
  connection: Pick<Connection, "requestAirdrop" | "getLatestBlockhash" | "getSignatureStatuses" | "getBlockHeight">,
  key: PublicKey,
  lamports: number,
): Promise<string> {
  const bh = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.requestAirdrop(key, lamports);
  await confirmSignature(connection, signature, bh, "confirmed");
  return signature;
}

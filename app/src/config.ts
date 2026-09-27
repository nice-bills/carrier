import { PublicKey } from "@solana/web3.js";

/**
 * Where this build talks to when it has signal. Devnet only for now: the
 * tokens are test tokens, and the app says so wherever money is set aside.
 *
 * Nothing here is needed to carry or hand over a payment. It is read only when
 * the phone is online: to look up its pouch, to set one up, and to settle.
 */

export const CLUSTER = "devnet" as const;

/** JSON-RPC endpoint. The public devnet one is rate limited; swap for your own. */
export const RPC_URL = "https://api.devnet.solana.com";

/** Token the pouch holds. Devnet USDC (Circle's faucet hands it out). */
export const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const MINT_SYMBOL = "USDC";
export const MINT_DECIMALS = 6;

/** Where to get test tokens, shown on the pouch setup sheet. */
export const TOKEN_FAUCET_URL = "https://faucet.circle.com/";

/** Offline allowances offered at setup, in whole tokens. */
export const ALLOWANCE_CHOICES = [10, 25, 50, 100] as const;
/** Bond set aside alongside the allowance, as a fraction of it (in basis points). */
export const BOND_BPS = 2_000;

/** Relay fees offered when paying, in basis points. 2% is the default. */
export const FEE_CHOICES_BPS = [0, 100, 200, 500] as const;
export const DEFAULT_FEE_BPS = 200;

/** Default note lifetime. Capped further by the pouch epoch (30 days from its start). */
export const DEFAULT_NOTE_LIFETIME_SECONDS = 7n * 24n * 60n * 60n;

/** How often to check for signal while the app is open. */
export const PROBE_INTERVAL_MS = 20_000;
/** How long one probe waits before calling the phone offline. */
export const PROBE_TIMEOUT_MS = 5_000;
/** How often, while online, to refresh the pouch and look for settlements. */
export const REFRESH_INTERVAL_MS = 60_000;
/** Devnet airdrop asked for when the phone has no SOL for fees. */
export const AIRDROP_LAMPORTS = 500_000_000;

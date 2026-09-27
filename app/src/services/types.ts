import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Bundle, Signer, Transport } from "@carrier/mesh";
import type { Pocket, RestoreReport } from "../pocket";
import type { CachedPouch } from "../ledger";
import type { LocationService } from "../map/location";

/**
 * Everything the screens need from the device and the network, behind one
 * seam. `services/native.ts` wires the real modules (keystore, files, radio,
 * RPC); `demo/services.ts` wires in-memory fakes so the whole UI runs in a
 * browser with sample slips, people and a pouch. Screens never import a
 * device module directly.
 */

/** The device key as the app uses it. */
export interface AppWallet extends Signer {
  readonly label: string;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
}

export interface PermissionResult {
  granted: boolean;
  /** True when at least one was refused with "don't ask again". */
  blocked: boolean;
}

/** The radio, as the app drives it. The mesh `Transport` plus "I'm handing you these". */
export interface Radio extends Transport {
  hand(peer: PublicKey, noteHashes: string[]): Promise<void>;
}

export interface RadioEvents {
  peerReady?(peer: PublicKey): void;
  peerGone?(peer: PublicKey): void;
  handed?(peer: PublicKey, digests: string[]): void;
  error?(where: string, e: unknown): void;
}

export interface Balances {
  /** Lamports, for fees. */
  sol: bigint;
  /** Base units of the pouch token held outside the pouch, or null if unknown. */
  token: bigint | null;
}

/** What the phone does when it has signal. */
export interface ChainService {
  readonly cluster: string;
  /** True if the RPC answered within the timeout. Never throws. */
  probe(): Promise<boolean>;
  /** This owner's pouch address for the configured mint. */
  pouchAddress(owner: PublicKey): PublicKey;
  /** A pouch as storage-form state, or null if it does not exist. */
  fetchPouch(address: PublicKey): Promise<CachedPouch | null>;
  /** First slot free on-chain (as cached) and not in `used`. */
  nextFreeSlot(pouch: CachedPouch, used: ReadonlySet<number>): number | null;
  balances(owner: PublicKey): Promise<Balances>;
  /** Settle a bundle, this phone paying the fees. */
  settle(wallet: AppWallet, bundle: Bundle): Promise<{ signatures: string[] }>;
  /** Open this phone's pouch: commit `amount` and a `bond`, both in base units. */
  openPouch(wallet: AppWallet, amount: bigint, bond: bigint): Promise<string>;
  /** Devnet only: ask for test SOL for fees. */
  airdrop(owner: PublicKey): Promise<void>;
  /** A sentence a person can act on, from any error the above threw. */
  explain(e: unknown): string;
}

export interface Services {
  /** The key already on this phone, or null. Throws `WalletError` on keystore trouble. */
  existingWallet(): Promise<AppWallet | null>;
  /** Load the key, creating it if there is none. */
  createWallet(): Promise<AppWallet>;
  openPocket(wallet: AppWallet): Promise<{ pocket: Pocket; report: RestoreReport }>;
  requestRadioPermissions(): Promise<PermissionResult>;
  /** Null when the radio can run here, else a sentence saying why not. */
  radioUnavailable(): Promise<string | null>;
  createRadio(wallet: AppWallet, pocket: Pocket, events: RadioEvents): Radio;
  chain: ChainService;
  /** Where the phone is, for the spread map. Only read while the person has it on. */
  location: LocationService;
  openSettings(): void;
  openUrl(url: string): void;
  /** Share text (the device key) through the system share sheet. */
  share(text: string): Promise<void>;
}

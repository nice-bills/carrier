import * as SecureStore from "expo-secure-store";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { Signer } from "@carrier/mesh";

const KEY = "carrier.device.secret";

/**
 * The device's identity.
 *
 * Stored in the platform keystore rather than AsyncStorage, because this key is
 * what a hop signature actually means: "this device was here". A key readable by
 * any other app is a key anyone can claim to be.
 *
 * On hardware with a secure element this is where the enclave-backed version
 * goes — the signing key never leaving it is what raises forging a hop from
 * editing a file to defeating the hardware. `expo-secure-store` already uses
 * Android Keystore, but ed25519 signing still happens in JS, so the private key
 * is in process memory while the app runs. Honest limitation, not a fix.
 */
export class DeviceWallet implements Signer {
  private constructor(private readonly keypair: Keypair) {}

  /**
   * Load the device key, creating one only when the keystore genuinely has
   * none. A keystore error or a corrupt entry throws `WalletError` instead:
   * silently minting a fresh identity would orphan every hop and note signed
   * with the old one, and the user would never know why their share vanished.
   */
  static async load(): Promise<DeviceWallet> {
    let stored: string | null;
    try {
      stored = await SecureStore.getItemAsync(KEY);
    } catch (e) {
      throw new WalletError("keystore-unavailable", "The phone's keystore could not be read", e);
    }

    if (stored === null) {
      const fresh = Keypair.generate();
      try {
        await SecureStore.setItemAsync(KEY, JSON.stringify([...fresh.secretKey]));
      } catch (e) {
        throw new WalletError("keystore-unavailable", "The phone's keystore refused the new key", e);
      }
      return new DeviceWallet(fresh);
    }

    return new DeviceWallet(parseStoredKey(stored));
  }

  get publicKey() {
    return this.keypair.publicKey;
  }

  /** Short form for showing a peer on screen. Full keys are unreadable at a glance. */
  get label() {
    const s = this.keypair.publicKey.toBase58();
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
  }

  sign(message: Uint8Array): Uint8Array {
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
}

export const shorten = (key: { toBase58(): string }) => {
  const s = key.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

export type WalletErrorCode = "keystore-unavailable" | "corrupt-key";

export class WalletError extends Error {
  constructor(
    readonly code: WalletErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Parse the stored secret, refusing anything that is not exactly a 64-byte key. */
export function parseStoredKey(stored: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (e) {
    throw new WalletError("corrupt-key", "The stored device key is not valid JSON", e);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new WalletError("corrupt-key", "The stored device key has the wrong shape");
  }
  try {
    // fromSecretKey checks that the public half matches the private half.
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch (e) {
    throw new WalletError("corrupt-key", "The stored device key does not verify", e);
  }
}

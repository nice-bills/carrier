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

  static async load(): Promise<DeviceWallet> {
    const stored = await SecureStore.getItemAsync(KEY);
    if (stored) {
      const secret = Uint8Array.from(JSON.parse(stored));
      return new DeviceWallet(Keypair.fromSecretKey(secret));
    }

    const fresh = Keypair.generate();
    await SecureStore.setItemAsync(KEY, JSON.stringify([...fresh.secretKey]));
    return new DeviceWallet(fresh);
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

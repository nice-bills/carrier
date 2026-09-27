/** Keystore failures, kept apart from `wallet.ts` so screens can test for them without loading the keystore module. */

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


/**
 * Globals that @solana/web3.js, tweetnacl and @carrier/* expect and Hermes may
 * not provide. Imported first from `index.ts`, before anything that could touch
 * them at module load, so it has to stay free of imports that use them.
 *
 * - `crypto.getRandomValues`: `Keypair.generate()` and tweetnacl's randomness.
 *   Backed by expo-crypto, which reads the platform CSPRNG. Without it the
 *   first launch cannot create a key at all (it throws; it never falls back to
 *   a weak source).
 * - `Buffer`: web3.js and `createEd25519Instruction` use it as a global.
 * - `TextEncoder` / `TextDecoder`: the protocol codec encodes its domain tags at
 *   module load. Recent Hermes ships TextEncoder but not always TextDecoder.
 * - `atob` / `btoa`: the mesh wire format's base64.
 *
 * Each one is installed only when missing, so a runtime that already has a
 * native implementation keeps it.
 */
import { getRandomValues } from "expo-crypto";
import { Buffer } from "buffer";

type Mutable = Record<string, unknown>;
const g = globalThis as unknown as Mutable;

if (typeof g.Buffer === "undefined") g.Buffer = Buffer;

const cryptoObj = (g.crypto ?? {}) as Mutable;
if (typeof cryptoObj.getRandomValues !== "function") {
  cryptoObj.getRandomValues = getRandomValues;
  g.crypto = cryptoObj;
}

if (typeof g.TextEncoder === "undefined") {
  class BufferTextEncoder {
    readonly encoding = "utf-8";
    encode(input = ""): Uint8Array {
      return new Uint8Array(Buffer.from(input, "utf8"));
    }
  }
  g.TextEncoder = BufferTextEncoder;
}

if (typeof g.TextDecoder === "undefined") {
  class BufferTextDecoder {
    readonly encoding = "utf-8";
    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) return "";
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return Buffer.from(bytes).toString("utf8");
    }
  }
  g.TextDecoder = BufferTextDecoder;
}

if (typeof g.btoa === "undefined") {
  g.btoa = (binary: string) => Buffer.from(binary, "latin1").toString("base64");
}
if (typeof g.atob === "undefined") {
  g.atob = (b64: string) => Buffer.from(b64, "base64").toString("latin1");
}

export {};

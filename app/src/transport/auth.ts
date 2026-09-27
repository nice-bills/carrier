import nacl from "tweetnacl";
import type { PublicKey } from "@solana/web3.js";

/**
 * Peer authentication: prove the key behind a radio session.
 *
 * Nearby only gives us an endpoint id and whatever name the peer advertised,
 * and anyone can advertise anything. So the name is a throwaway session id,
 * and the wallet key is revealed only inside this handshake, signed over:
 *
 *   "carrier:peer-auth:v1" | nonce(32) | prover session | verifier session | prover key
 *
 * - The domain tag keeps this from ever being a valid note or hop signature:
 *   those sign 32-byte digests, and this message is always longer.
 * - The verifier's fresh random nonce stops replay of an old proof.
 * - Both session ids bind the proof to this one pairing, so a relay in the
 *   middle cannot forward someone else's proof as its own: the victim would
 *   have signed the relay's session id as verifier, not ours.
 */
export const AUTH_DOMAIN = new TextEncoder().encode("carrier:peer-auth:v1");
export const NONCE_BYTES = 32;

function lengthPrefixed(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 255) throw new Error("session id too long");
  const out = new Uint8Array(1 + bytes.length);
  out[0] = bytes.length;
  out.set(bytes, 1);
  return out;
}

export function authMessage(
  nonce: Uint8Array,
  proverSession: string,
  verifierSession: string,
  proverKey: PublicKey,
): Uint8Array {
  if (nonce.length !== NONCE_BYTES) throw new Error("nonce must be 32 bytes");
  const parts = [
    AUTH_DOMAIN,
    nonce,
    lengthPrefixed(proverSession),
    lengthPrefixed(verifierSession),
    proverKey.toBytes(),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function verifyProof(
  message: Uint8Array,
  signature: Uint8Array,
  key: PublicKey,
): boolean {
  return signature.length === 64 && nacl.sign.detached.verify(message, signature, key.toBytes());
}

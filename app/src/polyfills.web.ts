/**
 * The browser preview's polyfills. Browsers have crypto, TextEncoder and
 * atob/btoa already; web3.js and the protocol codec still want a global
 * `Buffer`. Kept apart from `polyfills.ts` so the preview does not load
 * expo-crypto's native module.
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;

export {};

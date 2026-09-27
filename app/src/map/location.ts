import type { Cell } from "./types";

/**
 * Where the phone is, as the map needs it: rounded, and only when asked.
 * `map/expoLocation.ts` reads the real GPS; the browser preview's fake device
 * answers from its cast (`demo/places.ts`).
 */
export interface LocationService {
  /** Ask for foreground location. True if granted. Never throws. */
  request(): Promise<boolean>;
  /** The phone's cell, or null if no fix arrived within `timeoutMs`. Never throws. */
  fix(timeoutMs: number): Promise<Cell | null>;
}

/** How long a handoff-time fix may take before the point is simply left out. */
export const FIX_TIMEOUT_MS = 1_500;
/** The regular refresh is not tied to a handoff, so it may wait longer for a cold GPS. */
export const FIX_REFRESH_TIMEOUT_MS = 10_000;
/** A fix older than this is not used for a new point. */
export const FIX_FRESH_MS = 3 * 60_000;
/** How often to refresh the fix while the map is on and the app is open. */
export const FIX_EVERY_MS = 60_000;

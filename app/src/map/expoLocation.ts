import * as Location from "expo-location";
import type { LocationService } from "./location";
import { roundCell, type Cell } from "./types";

/**
 * The phone's GPS, read as cheaply as it allows: the last known position if it
 * is recent, otherwise one Balanced (Wi-Fi and cell, not satellite) read.
 * Nothing waits longer than the caller's timeout, and only the rounded cell
 * leaves this file; the raw coordinates are dropped here.
 */

/** A last-known position this recent is good enough. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
/** Last-known positions vaguer than this are not used. */
const LAST_KNOWN_ACCURACY_M = 200;

const cellOf = (p: Location.LocationObject | null): Cell | null =>
  p && Number.isFinite(p.coords.latitude) && Number.isFinite(p.coords.longitude)
    ? roundCell(p.coords.latitude, p.coords.longitude)
    : null;

function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

export function expoLocation(): LocationService {
  return {
    async request() {
      try {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        return granted;
      } catch {
        return false;
      }
    },
    async fix(timeoutMs) {
      const started = Date.now();
      const last = await within(
        Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS, requiredAccuracy: LAST_KNOWN_ACCURACY_M }),
        timeoutMs,
      );
      const hit = cellOf(last);
      if (hit) return hit;
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) return null;
      return cellOf(await within(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), left));
    },
  };
}

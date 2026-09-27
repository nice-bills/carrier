import { PermissionsAndroid, Platform, type Permission } from "react-native";

/**
 * Runtime permissions Nearby Connections needs before advertising or
 * discovering. The manifest entries come from the expo-nearby-connections config
 * plugin (see app.json); declaring them is not enough on Android 6+, the user
 * has to grant them at runtime, and the set differs by API level.
 *
 * Location is asked for on every level: Nearby Connections still refuses to
 * discover over Bluetooth on some Android 12+ builds without it. Carrier never
 * reads a location.
 */
export function requiredPermissions(apiLevel: number): Permission[] {
  const P = PermissionsAndroid.PERMISSIONS;
  const set: Permission[] = [P.ACCESS_FINE_LOCATION, P.ACCESS_COARSE_LOCATION];
  if (apiLevel >= 31) {
    set.push(P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT, P.BLUETOOTH_SCAN);
  }
  if (apiLevel >= 33) set.push(P.NEARBY_WIFI_DEVICES);
  return set;
}

export interface PermissionResult {
  granted: boolean;
  /** Permissions the user refused, for the one-sentence explanation on screen. */
  missing: Permission[];
  /** True when at least one was refused with "don't ask again". */
  blocked: boolean;
}

export async function ensureRadioPermissions(): Promise<PermissionResult> {
  // iOS has no runtime call for these: the system asks for Local Network and
  // Bluetooth itself the first time the radio starts, using the Info.plist
  // strings from app.json. A refusal there shows up as nobody in range.
  if (Platform.OS === "ios") return { granted: true, missing: [], blocked: false };
  if (Platform.OS !== "android") {
    return { granted: false, missing: [], blocked: false };
  }
  const apiLevel = typeof Platform.Version === "number" ? Platform.Version : Number(Platform.Version);
  const wanted = requiredPermissions(apiLevel);
  const result = await PermissionsAndroid.requestMultiple(wanted);
  const missing = wanted.filter((p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED);
  const blocked = wanted.some((p) => result[p] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
  return { granted: missing.length === 0, missing, blocked };
}

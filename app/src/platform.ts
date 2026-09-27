import { Platform } from "react-native";

/**
 * The few words that differ between an iPhone and an Android phone. Android
 * asks for Nearby devices and Location before it lets an app scan; iOS asks
 * for Local Network and Bluetooth by itself when the radio first starts, and
 * never needs Location for it. The browser preview can play an iPhone with
 * `?os=ios`.
 */
export const IS_IOS =
  Platform.OS === "ios" ||
  (Platform.OS === "web" && typeof location !== "undefined" && /[?&]os=ios\b/.test(location.search));

/** Rows on the onboarding radio card: what the phone will ask for, and why. */
export const RADIO_ASKS: readonly (readonly [string, string, string | null])[] = IS_IOS
  ? [
      ["Local network", "To find iPhones within about 10 metres and hand payments to them. Nothing goes on the internet.", null],
      ["Bluetooth", "So iPhones can see each other even with no Wi-Fi around.", null],
    ]
  : [
      ["Nearby devices", "Bluetooth and Wi-Fi Direct, to see phones within about 10 metres and hand payments to them.", null],
      ["Location", "Android requires it before any app may scan for other phones.", "We never look at where you are."],
    ];

/** Who a phone can hand payments to. */
export const PASSES_WITH = IS_IOS ? "other iPhones" : "other Android phones";

/** The privacy policy's paragraph on location. */
export const LOCATION_POLICY = IS_IOS
  ? "Carrier does not need your location to find phones. It asks for it only if you turn the map on, and keeps it rounded to about 100 m."
  : "Android requires location permission before an app can scan for nearby devices. Carrier asks for it for that reason alone and never reads your location.";

import type { RadioState } from "../useCarrier";

/** One sentence about the radio: what it is doing, or what it needs and why. */
export function radioLine(radio: RadioState, people: number): string {
  switch (radio.state) {
    case "on":
      return people ? `Listening. ${people} ${people === 1 ? "phone" : "phones"} in range.` : "Listening for phones nearby.";
    case "starting":
      return "Turning the radio on.";
    case "off":
      return "Radio off. Nobody nearby can find you.";
    case "needs-permission":
      return radio.blocked
        ? "Nearby access is off. Allow Nearby devices and Location in settings; Android needs Location to scan, and Carrier never reads it."
        : "Nearby access is off. Carrier needs Nearby devices and Location to find phones; it never reads your location.";
    case "unavailable":
      return radio.reason;
  }
}

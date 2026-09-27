import { Platform } from "react-native";

/**
 * Type families. The mockup is set in Bricolage Grotesque, JetBrains Mono and
 * Kalam; none of those font files ship with the app yet, so on Android these
 * are the system faces that come closest (Roboto at heavy weights, the system
 * monospace, and "casual", Android's built-in handwriting face). In a browser
 * preview the real families are named first, so they are used if the page
 * loads them.
 */
export const FONT = {
  /** Headings, labels, body. */
  face: Platform.select({
    web: '"Bricolage Grotesque", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    default: undefined,
  }),
  /** Amounts, keys, stamps, receipts. */
  mono: Platform.select({
    web: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
    ios: "Menlo",
    default: "monospace",
  }),
  /** Handwritten notes, used sparingly. */
  hand: Platform.select({
    web: '"Kalam", "Segoe Print", "Bradley Hand", cursive',
    android: "casual",
    default: undefined,
  }),
} as const;

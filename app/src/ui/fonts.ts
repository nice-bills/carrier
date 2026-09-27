import { Platform } from "react-native";

/**
 * Type families. The design is set in Inter, with JetBrains Mono for keys and
 * stamps. Neither font file ships with the app yet, so on Android these are
 * the system faces that come closest (Roboto, and the system monospace). In a
 * browser preview the real families are named first, so they are used if the
 * machine has them.
 */
export const FONT = {
  /** Headings, labels, body, amounts. */
  face: Platform.select({
    web: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    default: undefined,
  }),
  /** Keys, stamps, transaction ids. */
  mono: Platform.select({
    web: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
    ios: "Menlo",
    default: "monospace",
  }),
} as const;

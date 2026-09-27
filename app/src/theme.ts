/**
 * The design language, in one place.
 *
 * Mirrors `docs/pocket.html`, where the tokens are authored in OKLCH; these are
 * the light-theme values converted to sRGB hex for React Native.
 *
 * Carrier lives in your pocket, so everything is a thing you could find in one:
 *
 *   slip      a payment: amber paper, perforated; the one saturated object
 *   stamp     a handoff, in red ink; the row of stamps is the hop lineage
 *   SETTLED   green ink, landed when the chain reaches signal
 *   denim     the pocket the slip sits in, with amber contrast stitching
 *   tag       the device key, on kraft
 *   receipt   any record: the signed terms, what you earned, who was paid
 *
 * Colour carries state and nothing else: amber is value in motion, green is
 * settled or live, red ink is a stamp or a warning. Objects keep their own
 * colours; no blur, no gloss, no drop shadows, no text on translucency.
 *
 * This file has no imports so `scripts/contrast.ts` can check it in plain Node.
 * Font families are platform-specific and live in `src/ui/fonts.ts`.
 */

export const C = {
  // the phone's paper and ink
  paper: "#F5F4F1",
  paper2: "#E9E8E2",
  card: "#FCFBF9",
  rule: "#D6D4CD",
  ruleStrong: "#A7A59C",
  ink: "#141B26",
  ink2: "#474D58",
  ink3: "#5F636C",
  onInk: "#F6F5F1",
  red: "#BE2323",
  green: "#007145",

  // objects
  slip: "#FAB048",
  slipDeep: "#DF8623",
  slipInk: "#311805",
  slipInk2: "#593215",
  stampInk: "#B7191C",
  paidInk: "#006B40",
  denim: "#294971",
  denimDeep: "#1A3051",
  denimDark: "#111F37",
  thread: "#EDB154",
  chalk: "#E9EFF6",
  chalk2: "#BCCDDE",
  kraft: "#CFAA7C",
  kraftRing: "#A48664",
  kraftInk: "#36210E",
  receipt: "#FAFAF9",
  receiptInk: "#1A1F29",
  receiptInk2: "#51555E",
  /** Ballpoint blue, for the signature on the terms. */
  signInk: "#0E3685",

  /** A person row with a slip hovering over it. */
  slipWell: "#FBE3BC",
  /** Masking tape on a coach note, and the identicon's paper. Decorative, no text. */
  tape: "#ECE3C8",
  identWell: "#E0C9AA",

  /** The only translucent colour: the scrim behind a sheet. Nothing is written on it. */
  scrim: "rgba(17, 22, 32, 0.55)",
} as const;

/**
 * Avatars are not coloured by name. Someone you have met is inked in, a
 * stranger is an outlined well: the only thing an avatar's colour may say is
 * whether that person counts toward your rank.
 */
export const avatar = (met: boolean) =>
  met
    ? { backgroundColor: C.ink, color: C.onInk, borderColor: C.ink }
    : { backgroundColor: C.paper2, color: C.ink, borderColor: C.ruleStrong };

export const R = {
  box: 6,
  mark: 3,
  sheet: 16,
} as const;

/** Spacing, in dp. */
export const S = {
  xs: 4,
  s: 8,
  m: 12,
  l: 16,
  gutter: 20,
  xl: 24,
  xxl: 32,
} as const;

/** Type scale, in sp. Mirrors the mockup's sizes, nudged up where it read small. */
export const T = {
  hero: 44,
  title: 30,
  sheetTitle: 25,
  rank: 40,
  amount: 46,
  amountSmall: 32,
  head: 17,
  body: 16,
  small: 14,
  micro: 12,
} as const;

/** Smallest touch target, in dp (WCAG 2.2 target size, Android's 48dp). */
export const TARGET = 48;

/** Motion durations, in ms. Zero when the person asked for reduced motion. */
export const MOTION = {
  quick: 180,
  settle: 300,
  sheet: 280,
} as const;

/**
 * Every text/background pair the screens use, checked by
 * `app/scripts/contrast.ts` against WCAG 2.2 AA: 4.5:1 for text, 3:1 for
 * non-text marks (borders, rings, indicators) that carry meaning.
 */
export const CONTRAST_PAIRS: readonly { fg: keyof typeof C; bg: keyof typeof C; use: string; min: 4.5 | 3 }[] = [
  // paper
  { fg: "ink", bg: "paper", use: "body text", min: 4.5 },
  { fg: "ink2", bg: "paper", use: "secondary text", min: 4.5 },
  { fg: "ink3", bg: "paper", use: "tertiary text, times", min: 4.5 },
  { fg: "red", bg: "paper", use: "handwritten notes, warnings", min: 4.5 },
  { fg: "green", bg: "paper", use: "live, allowed, earned", min: 4.5 },
  { fg: "stampInk", bg: "paper", use: "stamps on the page", min: 4.5 },
  { fg: "paidInk", bg: "paper", use: "PAID marks", min: 4.5 },
  { fg: "ink", bg: "paper2", use: "avatar initials (stranger)", min: 4.5 },
  { fg: "ink2", bg: "paper2", use: "text on pressed rows", min: 4.5 },
  { fg: "ink", bg: "card", use: "tab bar, coach note, banner", min: 4.5 },
  { fg: "ink2", bg: "card", use: "tab labels, secondary on card", min: 4.5 },
  { fg: "ink3", bg: "card", use: "inactive tab labels", min: 4.5 },
  { fg: "red", bg: "card", use: "coach numbers", min: 4.5 },
  { fg: "green", bg: "card", use: "earned on banner", min: 4.5 },
  { fg: "onInk", bg: "ink", use: "primary button, toast, met avatar", min: 4.5 },
  { fg: "onInk", bg: "ink2", use: "primary button pressed", min: 4.5 },
  { fg: "onInk", bg: "red", use: "danger button", min: 4.5 },
  // ruleStrong (2.2:1) is for decorative rules only; a control's outline uses ink3.
  { fg: "ink3", bg: "paper", use: "outlined buttons, unchecked states", min: 3 },
  // slip
  { fg: "slipInk", bg: "slip", use: "slip amount and names", min: 4.5 },
  { fg: "slipInk2", bg: "slip", use: "slip secondary text", min: 4.5 },
  { fg: "stampInk", bg: "slip", use: "stamps on a slip (non-text ring)", min: 3 },
  { fg: "slipInk", bg: "slipDeep", use: "lifted slip", min: 4.5 },
  // A lifted slip draws all its text in slipInk: slipInk2 on slipDeep is 4.0:1.
  // denim pocket
  { fg: "chalk", bg: "denim", use: "empty pocket text", min: 4.5 },
  { fg: "chalk2", bg: "denim", use: "empty pocket small print", min: 4.5 },
  { fg: "thread", bg: "denim", use: "stitching (non-text)", min: 3 },
  { fg: "denimDark", bg: "chalk", use: "settle button on the pocket", min: 4.5 },
  { fg: "chalk", bg: "denim", use: "chalk buttons and outlines on the pocket", min: 3 },
  { fg: "ink", bg: "slipWell", use: "drop target name", min: 4.5 },
  { fg: "ink2", bg: "slipWell", use: "drop target state", min: 4.5 },
  { fg: "red", bg: "slipWell", use: "FOR THEM mark on a target", min: 4.5 },
  // kraft tag
  { fg: "kraftInk", bg: "kraft", use: "device key", min: 4.5 },
  // receipt
  { fg: "receiptInk", bg: "receipt", use: "receipt values", min: 4.5 },
  { fg: "receiptInk2", bg: "receipt", use: "receipt labels", min: 4.5 },
  { fg: "paidInk", bg: "receipt", use: "earned, SETTLED on a receipt", min: 4.5 },
  { fg: "red", bg: "receipt", use: "errors on a receipt", min: 4.5 },
  { fg: "stampInk", bg: "receipt", use: "stamps on a receipt", min: 4.5 },
  { fg: "signInk", bg: "receipt", use: "signature on the terms", min: 4.5 },
  { fg: "receipt", bg: "receiptInk", use: "signed button on a receipt", min: 4.5 },
];

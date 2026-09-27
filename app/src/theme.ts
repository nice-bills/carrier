/**
 * The design language, in one place.
 *
 * Carrier is a bright, rounded phone app. Surfaces are soft cards on warm
 * off-white; corners are generous; one saturated object carries the story:
 *
 *   slip      a payment: an amber card, perforated, with a notch each side
 *   stamp     a handoff, in red ink; the row of stamps is the hop lineage
 *   pocket    the navy card the slip sits in
 *   check     green, drawn when a payment settles
 *
 * Colour carries state and nothing else: amber is value in motion, green is
 * settled or live, red is a stamp or a warning. No gradients, no glass, no text
 * on translucency; shadows are soft and only lift cards off the page.
 *
 * This file has no imports so `scripts/contrast.ts` can check it in plain Node.
 * Font families are platform-specific and live in `src/ui/fonts.ts`.
 */

export const C = {
  // the page, cards and ink
  paper: "#F5F4F0",
  paper2: "#EEEDE8",
  card: "#FFFFFF",
  rule: "#E7E5DF",
  ruleStrong: "#C9C6BE",
  /** Outlines that carry meaning (a stranger's avatar, an unchosen control): 3:1 on cards. */
  outline: "#86837B",
  ink: "#15171C",
  ink2: "#555A64",
  ink3: "#676B74",
  onInk: "#FFFFFF",
  red: "#B8261F",
  green: "#0A7447",

  // soft fills for tags and banners, each with its own ink
  greenSoft: "#E3F4EA",
  greenInk: "#075F3A",
  amberSoft: "#FFF1DC",
  amberInk: "#7E4705",
  /** Ring round a chosen person or drop target: 3:1 on cards. */
  amberRing: "#B8650A",
  redSoft: "#FBE9E7",
  redInk: "#94221C",

  // objects
  slip: "#FFB54C",
  slipDeep: "#F39A2B",
  slipInk: "#3A1F06",
  slipInk2: "#653F15",
  stampInk: "#B7191C",
  paidInk: "#0A6B42",
  denim: "#1E3558",
  denimDeep: "#2A4670",
  denimDark: "#111F37",
  thread: "#EDB154",
  chalk: "#E9EFF6",
  chalk2: "#BCCDDE",
  kraft: "#CFAA7C",
  kraftRing: "#A48664",
  kraftInk: "#36210E",
  receipt: "#FFFFFF",
  receiptInk: "#15171C",
  receiptInk2: "#555A64",
  /** Ballpoint blue, for the signature on the terms. */
  signInk: "#0E3685",

  /** A person row with a slip hovering over it, or chosen. */
  slipWell: "#FFF1DC",
  /** The identicon's paper. Decorative, no text. */
  tape: "#ECE3C8",
  identWell: "#F1EEE8",

  /** The rank-up screen. */
  night: "#15171C",
  night2: "#2A2D35",
  onNight2: "#B9BCC4",
  nightAmber: "#F7C27A",

  /** The only translucent colour: the scrim behind a sheet. Nothing is written on it. */
  scrim: "rgba(15, 18, 24, 0.45)",
} as const;

/**
 * Avatars are not coloured by name. Someone you have met is inked in, a
 * stranger is an outlined well: the only thing an avatar's colour may say is
 * whether that person counts toward your rank.
 */
export const avatar = (met: boolean) =>
  met
    ? { backgroundColor: C.ink, color: C.onInk, borderColor: C.ink }
    : { backgroundColor: C.card, color: C.ink, borderColor: C.outline };

/** Corner radii. */
export const R = {
  /** Buttons, inputs, list rows. */
  box: 16,
  /** Cards, the slip. */
  card: 24,
  /** Chips, tags, pills. */
  pill: 999,
  /** Small marks. */
  mark: 8,
  sheet: 32,
} as const;

/** The one shadow: lifts a card a little off the page. */
export const SHADOW = {
  shadowColor: "#15171C",
  shadowOpacity: 0.07,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 5 },
  elevation: 2,
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

/** Type scale, in sp. */
export const T = {
  hero: 44,
  title: 32,
  sheetTitle: 26,
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
  // page
  { fg: "ink", bg: "paper", use: "body text", min: 4.5 },
  { fg: "ink2", bg: "paper", use: "secondary text", min: 4.5 },
  { fg: "ink3", bg: "paper", use: "tertiary text, times", min: 4.5 },
  { fg: "red", bg: "paper", use: "warnings", min: 4.5 },
  { fg: "green", bg: "paper", use: "live, allowed, earned", min: 4.5 },
  { fg: "stampInk", bg: "paper", use: "stamps on the page", min: 4.5 },
  { fg: "ink", bg: "paper2", use: "keys pressed, segmented control", min: 4.5 },
  { fg: "ink2", bg: "paper2", use: "notes, inactive segment", min: 4.5 },
  { fg: "ink3", bg: "paper2", use: "disabled button label", min: 4.5 },
  // cards
  { fg: "ink", bg: "card", use: "text on cards, tab bar", min: 4.5 },
  { fg: "ink2", bg: "card", use: "secondary on cards", min: 4.5 },
  { fg: "ink3", bg: "card", use: "inactive tab labels, times", min: 4.5 },
  { fg: "green", bg: "card", use: "earned on a card", min: 4.5 },
  { fg: "paidInk", bg: "card", use: "paid to you on a receipt", min: 4.5 },
  { fg: "red", bg: "card", use: "errors on a card", min: 4.5 },
  { fg: "stampInk", bg: "card", use: "stamps on a receipt", min: 4.5 },
  { fg: "signInk", bg: "card", use: "signature on the terms", min: 4.5 },
  { fg: "outline", bg: "card", use: "outline of a stranger's avatar, unchosen chips (non-text)", min: 3 },
  { fg: "outline", bg: "paper", use: "outlines on the page (non-text)", min: 3 },
  // soft fills
  { fg: "greenInk", bg: "greenSoft", use: "in range tag, signal banner", min: 4.5 },
  { fg: "amberInk", bg: "amberSoft", use: "holding tag, chosen person", min: 4.5 },
  { fg: "ink", bg: "amberSoft", use: "chosen person's name", min: 4.5 },
  { fg: "ink2", bg: "amberSoft", use: "chosen person's state", min: 4.5 },
  { fg: "amberRing", bg: "card", use: "chosen person's ring (non-text)", min: 3 },
  { fg: "amberRing", bg: "amberSoft", use: "chosen person's ring on its fill (non-text)", min: 3 },
  { fg: "redInk", bg: "redSoft", use: "over-the-limit line", min: 4.5 },
  { fg: "red", bg: "slipWell", use: "FOR THEM mark on a target", min: 4.5 },
  // ink fills
  { fg: "onInk", bg: "ink", use: "primary button, toast, met avatar", min: 4.5 },
  { fg: "onInk", bg: "ink2", use: "primary button pressed", min: 4.5 },
  { fg: "onInk", bg: "red", use: "danger button", min: 4.5 },
  { fg: "onInk", bg: "green", use: "hold to sign, filled", min: 4.5 },
  // slip
  { fg: "slipInk", bg: "slip", use: "slip amount and names", min: 4.5 },
  { fg: "slipInk2", bg: "slip", use: "slip secondary text", min: 4.5 },
  { fg: "stampInk", bg: "slip", use: "stamps on a slip (non-text ring)", min: 3 },
  { fg: "slipInk", bg: "slipDeep", use: "lifted slip", min: 4.5 },
  // pocket
  { fg: "chalk", bg: "denim", use: "empty pocket text", min: 4.5 },
  { fg: "chalk2", bg: "denim", use: "empty pocket small print", min: 4.5 },
  { fg: "denimDark", bg: "chalk", use: "settle button on the pocket", min: 4.5 },
  { fg: "chalk", bg: "denimDeep", use: "next slip button on the pocket", min: 4.5 },
  // rank up
  { fg: "onInk", bg: "night", use: "rank name", min: 4.5 },
  { fg: "onNight2", bg: "night", use: "rank-up text", min: 4.5 },
  { fg: "nightAmber", bg: "night", use: "NEW RANK", min: 4.5 },
  { fg: "onInk", bg: "night2", use: "keep going button", min: 4.5 },
  // key tag
  { fg: "kraftInk", bg: "kraft", use: "device key", min: 4.5 },
];

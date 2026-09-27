/**
 * The design language, in one place.
 *
 * Mirrors `docs/pocket.html`, where the tokens are authored in OKLCH; these are
 * the light-theme values converted to hex for React Native.
 *
 * Carrier lives in your pocket, so everything is a thing you could find in one:
 *
 *   slip      a payment: amber paper, perforated; the one saturated object
 *   stamp     a handoff, in red ink; the row of stamps is the hop lineage
 *   SETTLED   green ink, landed when the chain reaches signal
 *   denim     the pocket the slip sits in, with amber contrast stitching
 *   tag       the device key, on kraft
 *   receipt   any record: the signed terms, what you earned
 *
 * Objects keep their own colours in both themes; only paper and ink swap.
 * No blur, no gloss, no drop shadows: objects are told apart by material and
 * edge.
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
  thread: "#EDB154",
  chalk: "#E9EFF6",
  kraft: "#CFAA7C",
  kraftInk: "#36210E",
  receipt: "#FAFAF9",
  receiptInk: "#1A1F29",
} as const;

/**
 * Avatars are not coloured by name. Someone you have met is inked in, a
 * stranger is an outlined well: the only thing an avatar's colour may say is
 * whether that person counts toward your rank.
 */
export const avatar = (met: boolean) =>
  met
    ? { backgroundColor: C.ink, color: C.paper, borderColor: C.ink }
    : { backgroundColor: C.paper2, color: C.ink, borderColor: C.ruleStrong };

export const R = {
  box: 6,
  mark: 3,
} as const;

export const FONT = {
  /** Bricolage Grotesque: headings, labels, body. */
  face: "BricolageGrotesque",
  /** JetBrains Mono: amounts, keys, stamps, receipts. */
  mono: "JetBrainsMono",
  /** Kalam: handwritten notes, used sparingly. */
  hand: "Kalam",
} as const;

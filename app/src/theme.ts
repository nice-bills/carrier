/**
 * The design language, in one place.
 *
 * Mirrors `docs/pocket.html`. The rules that keep it out of slop territory are
 * worth stating because each one is a pattern rather than a preference:
 *
 *   flat fills only      gloss and gradient are the single most machine-made
 *                        thing a screen can contain
 *   one heavy outline    every object is drawn, not shaded
 *   hard offset shadow   sits directly under the object, never blurred
 *   no pure #000/#fff    both read as an untouched default
 *   one accent, one job  colour means something or it is not used
 */

export const C = {
  page: "#FBFBF9",
  card: "#FFFFFF",
  ink: "#3C3C3C",
  soft: "#7A7A7A",
  hair: "#E5E5E5",

  /** Value sitting in your hands. */
  sun: "#FFC93C",
  /** Where a payment is headed. */
  coral: "#FF5A5F",
  /** The action you can take right now. */
  grass: "#58CC02",
  grassEdge: "#46A302",
  /** Empty hands. */
  calm: "#E9F7DC",
} as const;

/** Avatar fills. Chosen for contrast against white with dark text over none. */
export const HUES = [
  "#FF5A5F", "#6C4AE0", "#0F8A6A", "#FFC93C",
  "#E8582F", "#2E86DE", "#D64C9B", "#3AAE6E",
] as const;

export const hueFor = (name: string) =>
  HUES[name.charCodeAt(0) % HUES.length]!;

export const R = {
  /** Interactive things are pills. */
  pill: 999,
  /** Containers are 16. Nothing else has a radius. */
  box: 16,
} as const;

/**
 * How far an object sits above its shadow.
 *
 * React Native's `elevation` blurs, which is exactly the look this design
 * rejects, so the shadow is a real View offset behind the object instead.
 */
export const LIFT = 6;

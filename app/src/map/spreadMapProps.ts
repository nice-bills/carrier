import type { Cell, Route } from "./types";

/** What both map components (`SpreadMap.tsx`, `SpreadMap.web.tsx`) take. */
export interface SpreadMapProps {
  /** The routes to draw. In "route" mode the others are drawn faint behind `focus`. */
  routes: readonly Route[];
  /** The chosen route, drawn bold with pins and times ("route" mode). */
  focus: Route | null;
  /** This phone's key (base58): its points are amber. */
  me: string;
  /** Where this phone is, rounded, if it knows. */
  here: Cell | null;
  mode: "route" | "today";
  /** Room the floating controls take at the top and bottom, in dp, so fitting keeps the route clear of them. */
  inset: { top: number; bottom: number };
  /** Bumped by the locate button: centre on `here`, or refit the route when there is no fix. */
  locate: number;
  /** What the map shows, in words, for a screen reader. */
  label: string;
  onReady?: () => void;
}

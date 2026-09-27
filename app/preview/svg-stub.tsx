// react-native-svg for the browser preview: the few elements the app draws,
// as plain DOM <svg>. (The package's own web build drags in native specs.)
import { createElement, type ReactNode } from "react";

type P = Record<string, unknown> & { children?: ReactNode };
const dom = (tag: string) => (props: P) => createElement(tag, props);

export default function Svg({ width, height, viewBox, fill, children }: P) {
  return createElement("svg", { width, height, viewBox, fill, style: { display: "block" } }, children);
}
export const Path = dom("path");
export const Rect = dom("rect");

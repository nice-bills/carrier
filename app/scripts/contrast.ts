/**
 * Check every text/background pair the app uses against WCAG 2.2 AA.
 *
 *   node --experimental-strip-types app/scripts/contrast.ts
 *
 * Reads the pairs from `CONTRAST_PAIRS` in `src/theme.ts`, so a new colour
 * cannot be added to the screens' vocabulary without being listed and checked.
 * Exits non-zero if any pair falls short.
 */
import { C, CONTRAST_PAIRS } from "../src/theme.ts";

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not an opaque #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

let failed = 0;
for (const p of CONTRAST_PAIRS) {
  const r = ratio(C[p.fg], C[p.bg]);
  const ok = r >= p.min;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "pass" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1  (needs ${p.min})  ${p.fg} on ${p.bg}  ${p.use}`,
  );
}
console.log(`\n${CONTRAST_PAIRS.length - failed}/${CONTRAST_PAIRS.length} pairs meet WCAG 2.2 AA`);
if (failed) process.exit(1);

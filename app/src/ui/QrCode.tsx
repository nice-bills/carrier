import { useMemo } from "react";
import { View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import QRCode from "qrcode";
import { C } from "../theme";

/**
 * A QR code drawn as one SVG path: every dark module is a unit square, and
 * runs along a row are merged, so a dense code is still a single element.
 * Slip parts are all base45, which the encoder packs in alphanumeric mode.
 */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { d, n } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    let d = "";
    for (let y = 0; y < n; y++) {
      let x = 0;
      while (x < n) {
        if (!qr.modules.get(y, x)) {
          x++;
          continue;
        }
        const start = x;
        while (x < n && qr.modules.get(y, x)) x++;
        d += `M${start} ${y}h${x - start}v1h${start - x}z`;
      }
    }
    return { d, n };
  }, [value]);
  // A quiet zone of two modules keeps cameras from reading into the card.
  const q = 2;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={size} height={size} viewBox={`${-q} ${-q} ${n + 2 * q} ${n + 2 * q}`}>
        <Rect x={-q} y={-q} width={n + 2 * q} height={n + 2 * q} fill="#FFFFFF" />
        <Path d={d} fill={C.ink} />
      </Svg>
    </View>
  );
}

/** Four corners and a line across: "scan a code". */
export function ScanIcon({ size = 18, colour = C.ink }: { size?: number; colour?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3M7 12h10" stroke={colour} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

/** Three finder squares and a dot: "show a code". */
export function QrGlyph({ size = 16, colour = C.chalk }: { size?: number; colour?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" stroke={colour} strokeWidth={2.2} strokeLinejoin="round" />
      <Path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5z" fill={colour} />
    </Svg>
  );
}

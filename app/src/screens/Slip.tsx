import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { formatUnits, mintOf } from "../amounts";
import { hhmm, percent, shorten, spokenKey } from "../format";
import { splitPayout } from "../ledger";
import { C } from "../theme";
import { FONT } from "../ui/fonts";
import { Stamp } from "../ui/kit";

/**
 * A payment, drawn as the thing it is: an amber slip, perforated, with a
 * rubber stamp for everyone who carried it. The one saturated object on any
 * screen.
 */

export interface SlipFacts {
  /** "12.5", or the raw base units if the token is not one we know. */
  value: string;
  /** "USDC", or "units". */
  unit: string;
  /** "12.5 USDC", as a screen reader should say it. */
  spoken: string;
  role: "for-me" | "own" | "carrying";
  /** What this phone gets if it settles now, as text, or null. */
  share: string | null;
  stamps: { key: string; top: string; mid: string; bottom: string; you: boolean }[];
}

export function slipFacts(b: Bundle, me: PublicKey): SlipFacts {
  const m = mintOf(b);
  const fmt = (n: bigint) => (m ? formatUnits(n, m.decimals) : n.toString());
  const value = fmt(b.note.amount);
  const unit = m ? m.symbol : "units";
  const role: SlipFacts["role"] = b.note.to.equals(me) ? "for-me" : b.owner.equals(me) && b.hops.length === 0 ? "own" : "carrying";
  let share: string | null = null;
  if (role === "carrying" && b.note.relayFeeBps > 0) {
    // Carriers split the fee evenly. More carriers after us only shrink it.
    share = `${fmt(splitPayout(b.note.amount, b.note.relayFeeBps, b.hops.length).perRelayer)} ${unit}`;
  }
  const stamps: SlipFacts["stamps"] = [
    { key: b.owner.toBase58(), top: b.owner.equals(me) ? "YOU" : b.owner.toBase58().slice(0, 4), mid: "--:--", bottom: "SENT", you: false },
    ...b.hops.map((h, i) => ({
      key: `${h.relayer.toBase58()}${i}`,
      top: h.relayer.equals(me) ? "YOU" : h.relayer.toBase58().slice(0, 4),
      mid: hhmm(Number(h.at) * 1000),
      bottom: `HOP ${i + 1}`,
      you: false,
    })),
  ];
  return { value, unit, spoken: m ? `${value} ${unit}` : `${value} base units of an unrecognised token`, role, share, stamps };
}

/** What a screen reader hears for a slip. Says everything the stamps show. */
export function slipLabel(b: Bundle, me: PublicKey, position?: string): string {
  const f = slipFacts(b, me);
  const hands = b.hops.length;
  const lead =
    f.role === "for-me"
      ? `Payment of ${f.spoken} paid to you, from ${spokenKey(b.owner)}.`
      : f.role === "own"
        ? `Payment of ${f.spoken} you signed for ${spokenKey(b.note.to)}.`
        : `Payment of ${f.spoken} for ${spokenKey(b.note.to)}, carried by ${hands} ${hands === 1 ? "person" : "people"} including you.`;
  return [position, lead, f.share ? `Your share if it settles now: ${f.share}.` : ""].filter(Boolean).join(" ");
}

export function SlipView({
  bundle,
  me,
  lifted,
  compact,
  style,
  counter,
  ground = C.denim,
}: {
  bundle: Bundle;
  me: PublicKey;
  lifted?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  /** "1 of 3", shown top right when there is more than one. */
  counter?: string;
  /** What the slip lies on, so the perforation notches read as holes. */
  ground?: string;
}) {
  const f = slipFacts(bundle, me);
  const who =
    f.role === "for-me" ? "Paid to " : f.role === "own" ? "You pay " : "For ";
  const whom = f.role === "for-me" ? "you" : shorten(bundle.note.to);
  const ink = C.slipInk;
  const ink2 = lifted ? C.slipInk : C.slipInk2;
  const bg = lifted ? C.slipDeep : C.slip;
  const notch = (side: "left" | "right") => (
    <View style={[s.notch, side === "left" ? { left: -9 } : { right: -9 }, { top: compact ? 58 : 100, backgroundColor: ground }]} />
  );
  return (
    <View style={[s.slip, { backgroundColor: bg }, style]}>
      <View style={[s.top, compact && { height: 66 }]}>
        <View style={s.row}>
          <Text style={[s.rowText, { color: ink2 }]}>
            {who}
            <Text style={{ color: ink, fontWeight: "800" }}>{whom}</Text>
          </Text>
          <Text style={[s.meta, { color: ink }]}>
            {counter ?? `${bundle.hops.length} ${bundle.hops.length === 1 ? "stamp" : "stamps"}`}
          </Text>
        </View>
        <Text style={[s.amount, { color: ink }, compact && { fontSize: 32 }]} numberOfLines={1} adjustsFontSizeToFit>
          {f.value}
          <Text style={[s.unit, { color: ink2 }]}> {f.unit}</Text>
        </Text>
      </View>
      {notch("left")}
      {notch("right")}
      <View style={[s.perf, { borderColor: ink2 }]} />
      <View style={s.stamps}>
        {f.stamps.map((st, i) => (
          <View key={st.key} style={i ? { marginLeft: -7 } : null}>
            <Stamp top={st.top} mid={st.mid} bottom={st.bottom} seed={st.key} size={compact ? 54 : 60} />
          </View>
        ))}
        {f.role === "carrying" ? (
          <View style={{ marginLeft: -7 }}>
            <Stamp top="NEXT" mid="--:--" bottom={`HOP ${f.stamps.length}`} seed="next" yours size={compact ? 54 : 60} />
          </View>
        ) : null}
      </View>
      {!compact ? (
        <View style={s.foot}>
          <Text style={[s.footText, { color: ink2 }]}>
            {f.role === "for-me"
              ? `Relay fee ${percent(bundle.note.relayFeeBps)}`
              : f.role === "own"
                ? `Carriers share up to ${percent(bundle.note.relayFeeBps)}`
                : f.share
                  ? "Your share "
                  : "No share on this one"}
            {f.share ? <Text style={[s.footStrong, { color: ink }]}>{f.share}</Text> : null}
          </Text>
          {f.role !== "for-me" ? <Text style={[s.hand, { color: ink }]}>drag me onto someone</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  slip: { borderRadius: 4, transform: [{ rotate: "-1.2deg" }] },
  top: { height: 108, paddingHorizontal: 18, paddingTop: 13 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowText: { fontFamily: FONT.face, fontSize: 15 },
  meta: { fontFamily: FONT.mono, fontSize: 13, fontWeight: "700" },
  amount: { fontFamily: FONT.mono, fontSize: 46, fontWeight: "700", letterSpacing: -2, marginTop: 6 },
  unit: { fontFamily: FONT.mono, fontSize: 15, fontWeight: "600", letterSpacing: 0 },
  notch: { position: "absolute", width: 18, height: 18, borderRadius: 9, backgroundColor: C.denim },
  perf: { marginHorizontal: 16, borderTopWidth: 2, borderStyle: "dashed" },
  stamps: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, flexWrap: "wrap" },
  foot: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10, paddingHorizontal: 18, paddingTop: 4, paddingBottom: 13 },
  footText: { fontFamily: FONT.face, fontSize: 14, flexShrink: 1 },
  footStrong: { fontFamily: FONT.mono, fontWeight: "700" },
  hand: { fontFamily: FONT.hand, fontSize: 15, fontWeight: "700" },
});

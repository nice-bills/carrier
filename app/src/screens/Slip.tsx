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
  freshLast,
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
  /** The slip just arrived: the last real stamp thuds on. */
  freshLast?: boolean;
}) {
  const f = slipFacts(bundle, me);
  const who = f.role === "for-me" ? "Paid to " : f.role === "own" ? "You pay " : "For ";
  const whom = f.role === "for-me" ? "you" : shorten(bundle.note.to);
  const ink = C.slipInk;
  // slipInk2 is only checked on the resting slip; the lifted one keeps full ink.
  const ink2 = lifted ? C.slipInk : C.slipInk2;
  const bg = lifted ? C.slipDeep : C.slip;
  const hops = bundle.hops.length;
  const stampSize = compact ? 46 : 52;
  return (
    <View style={[s.slip, compact && s.slipCompact, { backgroundColor: bg }, style]}>
      <View style={s.count}>
        <Text style={s.countText}>{counter ?? `${hops} ${hops === 1 ? "stamp" : "stamps"}`}</Text>
      </View>
      <Text style={[s.forLine, { color: ink2 }]} numberOfLines={1}>
        {who}
        <Text style={{ color: ink, fontWeight: "700" }}>{whom}</Text>
      </Text>
      <Text style={[s.amount, { color: ink }, compact && { fontSize: 32 }]} numberOfLines={1} adjustsFontSizeToFit>
        {f.value}
        <Text style={[s.unit, { color: ink2 }]}> {f.unit}</Text>
      </Text>
      <View style={[s.perfRow, compact && { marginVertical: 10 }]}>
        <View style={s.perf} />
        <View style={[s.notch, { left: -9, backgroundColor: ground }]} />
        <View style={[s.notch, { right: -9, backgroundColor: ground }]} />
      </View>
      <View style={s.stamps}>
        {f.stamps.map((st, i) => (
          <Stamp
            key={st.key}
            top={st.top}
            mid={st.mid}
            bottom={st.bottom}
            seed={st.key}
            size={stampSize}
            fresh={freshLast && i === f.stamps.length - 1}
          />
        ))}
        {f.role === "carrying" ? <Stamp top="NEXT" mid="--:--" bottom={`HOP ${f.stamps.length}`} seed="next" yours size={stampSize} /> : null}
      </View>
      {!compact ? (
        <>
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
            <Text style={[s.footText, { color: ink2 }]}>{hops ? `Hop ${hops}` : "Not handed yet"}</Text>
          </View>
          {f.role !== "for-me" ? <Text style={[s.dragHint, { color: ink2 }]}>Drag onto someone, or tap them</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  slip: { borderRadius: 20, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16 },
  slipCompact: { paddingTop: 14, paddingBottom: 12 },
  count: {
    position: "absolute",
    right: 16,
    top: 16,
    zIndex: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(58, 31, 6, 0.10)",
  },
  countText: { fontFamily: FONT.face, fontSize: 12, fontWeight: "600", color: C.slipInk },
  forLine: { fontFamily: FONT.face, fontSize: 14, fontWeight: "500", paddingRight: 72 },
  amount: { fontFamily: FONT.face, fontSize: 46, lineHeight: 50, fontWeight: "800", letterSpacing: -1.5, marginTop: 8 },
  unit: { fontFamily: FONT.face, fontSize: 16, fontWeight: "600", letterSpacing: 0 },
  perfRow: { marginHorizontal: -18, marginVertical: 14, height: 2, justifyContent: "center" },
  perf: { borderTopWidth: 2, borderStyle: "dashed", borderColor: C.slipInk, opacity: 0.28 },
  notch: { position: "absolute", top: -8, width: 18, height: 18, borderRadius: 9 },
  stamps: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  foot: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginTop: 12 },
  footText: { fontFamily: FONT.face, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  footStrong: { fontFamily: FONT.face, fontWeight: "700" },
  dragHint: { fontFamily: FONT.face, fontSize: 12, fontWeight: "500", marginTop: 6 },
});

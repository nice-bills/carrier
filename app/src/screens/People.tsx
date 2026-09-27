import { forwardRef, useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import type { PublicKey } from "@solana/web3.js";
import type { FeedEvent } from "../pocket";
import { ago, shorten, spokenKey } from "../format";
import { C, SHADOW } from "../theme";
import { FONT } from "../ui/fonts";
import { Avatar, Card, Mark, ease, useReducedMotion } from "../ui/kit";

/** A nearby, authenticated phone, as a row you can tap or drop a slip on. */
export interface PersonInfo {
  key: PublicKey;
  met: boolean;
  /** Payments they could hand us right now. */
  holding: number;
  /** They are who the current slip is for. */
  forThem: boolean;
}

export function personState(p: PersonInfo): string {
  if (p.forThem) return "this payment is theirs";
  if (p.holding) return `holding ${p.holding} ${p.holding === 1 ? "payment" : "payments"} you could take`;
  return p.met ? "met before" : "new to you";
}

export const PersonRow = forwardRef<View, {
  person: PersonInfo;
  selected: boolean;
  target: boolean;
  onPress: () => void;
  hint: string;
  /** First row in its card: no hairline above it. */
  first?: boolean;
}>(function PersonRow({ person, selected, target, onPress, hint, first }, ref) {
  const k = person.key.toBase58();
  const reduced = useReducedMotion();
  const on = selected || target;
  const ring = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    // The drop target shows at once; a tap fades the ring in.
    if (target) ring.setValue(1);
    else ease(ring, selected ? 1 : 0, reduced, 200).start();
  }, [selected, target, reduced, ring]);
  return (
    <View ref={ref} collapsable={false} style={pr.li}>
      {first ? null : <View style={pr.hair} />}
      <Animated.View pointerEvents="none" style={[pr.ring, target && pr.target, { opacity: ring }]} />
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${spokenKey(person.key)}, ${personState(person)}${person.met ? ", counts toward your rank" : ""}`}
        accessibilityHint={hint}
        accessibilityState={{ selected }}
        style={({ pressed }) => [pr.row, pressed && !on && pr.pressed]}
      >
        <Avatar text={k.slice(0, 2)} met={person.met} />
        <View style={pr.mid}>
          <Text style={pr.name} numberOfLines={1}>
            {shorten(person.key)}
          </Text>
          <Text style={pr.stateText}>{personState(person)}</Text>
        </View>
        <View>
          {person.forThem ? (
            <Mark text="FOR THEM" colour={C.red} />
          ) : person.holding ? (
            <Mark text={`Holding ${person.holding}`} tone="amber" />
          ) : (
            <Mark text="In range" tone="green" />
          )}
        </View>
      </Pressable>
    </View>
  );
});

const pr = StyleSheet.create({
  li: { paddingHorizontal: 6 },
  hair: { height: 1, backgroundColor: C.rule, marginHorizontal: 12 },
  ring: {
    position: "absolute",
    left: 6,
    right: 6,
    top: 3,
    bottom: 3,
    borderRadius: 16,
    backgroundColor: C.amberSoft,
    borderWidth: 2,
    borderColor: C.amberRing,
  },
  target: { backgroundColor: C.slipWell, borderWidth: 3, borderColor: C.amberRing, ...SHADOW },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 68,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginVertical: 3,
    borderRadius: 16,
  },
  pressed: { backgroundColor: C.paper2 },
  mid: { flex: 1 },
  name: { fontFamily: FONT.mono, fontSize: 15, fontWeight: "600", letterSpacing: -0.4, color: C.ink },
  stateText: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginTop: 2 },
});

/** What to say when nobody is there, in the card the list would be in. */
export function PeopleEmpty({ text }: { text: string }) {
  return (
    <Card>
      <Text style={{ fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2 }}>{text}</Text>
    </Card>
  );
}

/** One line of the logbook: who, what happened, how long ago. */
export function FeedRow({ e, first }: { e: FeedEvent; /** First row in its card: no hairline above it. */ first?: boolean }) {
  const when = ago(Date.now() - e.at);
  return (
    <View accessible accessibilityLabel={`${e.text} ${when === "now" ? "Just now" : `${when} ago`}`}>
      {first ? null : <View style={fd.hair} />}
      <View style={fd.row}>
        <Avatar text={e.mine ? "Yo" : (e.who ?? "").slice(0, 2)} you={e.mine} size={32} />
        <Text style={fd.text}>{e.text}</Text>
        <Text style={fd.time}>{when}</Text>
      </View>
    </View>
  );
}

const fd = StyleSheet.create({
  hair: { height: 1, backgroundColor: C.rule, marginHorizontal: 16 },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start", paddingVertical: 12, paddingHorizontal: 16 },
  text: { flex: 1, fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink, paddingTop: 5 },
  time: { fontFamily: FONT.face, fontSize: 13, color: C.ink3, paddingTop: 7 },
});

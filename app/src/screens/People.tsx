import { forwardRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PublicKey } from "@solana/web3.js";
import type { FeedEvent } from "../pocket";
import { ago, shorten, spokenKey } from "../format";
import { C, S } from "../theme";
import { FONT } from "../ui/fonts";
import { Avatar, Mark } from "../ui/kit";

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
}>(function PersonRow({ person, selected, target, onPress, hint }, ref) {
  const k = person.key.toBase58();
  return (
    <View ref={ref} collapsable={false} style={pr.li}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${spokenKey(person.key)}, ${personState(person)}${person.met ? ", counts toward your rank" : ""}`}
        accessibilityHint={hint}
        accessibilityState={{ selected }}
        style={({ pressed }) => [pr.row, selected && pr.selected, target && pr.target, pressed && !target && pr.pressed]}
      >
        <Avatar text={k.slice(0, 2)} met={person.met} />
        <View style={pr.mid}>
          <Text style={pr.name}>{shorten(person.key)}</Text>
          <View style={pr.state}>
            {person.forThem ? <Mark text="FOR THEM" colour={C.red} rotate={-4} /> : null}
            {!person.forThem && person.holding ? <View style={pr.mini} /> : null}
            <Text style={pr.stateText}>{personState(person)}</Text>
          </View>
        </View>
        <Text style={pr.near}>in range</Text>
      </Pressable>
    </View>
  );
});

const pr = StyleSheet.create({
  li: { borderBottomWidth: 1, borderColor: C.rule },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 64,
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "transparent",
  },
  selected: { borderColor: C.ink },
  target: { backgroundColor: C.slipWell, borderColor: C.slipDeep },
  pressed: { backgroundColor: C.paper2 },
  mid: { flex: 1 },
  name: { fontFamily: FONT.mono, fontSize: 16, fontWeight: "700", color: C.ink },
  state: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 2, flexWrap: "wrap" },
  stateText: { fontFamily: FONT.face, fontSize: 14, color: C.ink2 },
  mini: { width: 16, height: 10, borderRadius: 1.5, backgroundColor: C.slip, borderWidth: 1, borderColor: C.slipDeep, transform: [{ rotate: "-8deg" }] },
  near: { fontFamily: FONT.mono, fontSize: 12, color: C.ink2 },
});

/** The list's top rule, and what to say when nobody is there. */
export function PeopleEmpty({ text }: { text: string }) {
  return (
    <View style={{ borderTopWidth: 1.5, borderColor: C.ink, paddingTop: S.m }}>
      <Text style={{ fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink2 }}>{text}</Text>
    </View>
  );
}

/** One line of the logbook: who, what happened, how long ago. */
export function FeedRow({ e }: { e: FeedEvent }) {
  const when = ago(Date.now() - e.at);
  return (
    <View style={fd.row} accessible accessibilityLabel={`${e.text} ${when === "now" ? "Just now" : `${when} ago`}`}>
      <Avatar text={e.mine ? "Yo" : (e.who ?? "").slice(0, 2)} you={e.mine} size={30} />
      <Text style={fd.text}>{e.text}</Text>
      <Text style={fd.time}>{when}</Text>
    </View>
  );
}

const fd = StyleSheet.create({
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start", paddingVertical: 10, borderBottomWidth: 1, borderColor: C.rule },
  text: { flex: 1, fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink2, paddingTop: 4 },
  time: { fontFamily: FONT.mono, fontSize: 12, color: C.ink3, paddingTop: 6 },
});

import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { C } from "../theme";
import { FONT } from "./fonts";
import { SettledStamp } from "./kit";

/** The three tabs, as in the mockup. Icons are drawn with plain views. */
export type Tab = "carry" | "around" | "you";

function Icon({ tab, colour }: { tab: Tab; colour: string }) {
  if (tab === "carry") {
    // a slip: a ticket with a perforation
    return (
      <View style={[ic.slip, { borderColor: colour }]}>
        <View style={[ic.slipLine, { backgroundColor: colour, width: 9 }]} />
        <View style={[ic.slipLine, { backgroundColor: colour, width: 6 }]} />
      </View>
    );
  }
  if (tab === "around") {
    // radio: a dot inside two rings
    return (
      <View style={[ic.ring2, { borderColor: colour }]}>
        <View style={[ic.ring1, { borderColor: colour }]}>
          <View style={[ic.dot, { backgroundColor: colour }]} />
        </View>
      </View>
    );
  }
  // a person
  return (
    <View style={ic.person}>
      <View style={[ic.head, { borderColor: colour }]} />
      <View style={[ic.body, { borderColor: colour }]} />
    </View>
  );
}

const ic = StyleSheet.create({
  slip: { width: 22, height: 14, borderWidth: 1.7, borderRadius: 2, justifyContent: "center", paddingLeft: 4, gap: 2, marginVertical: 4 },
  slipLine: { height: 1.7, borderRadius: 1 },
  ring2: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.7, alignItems: "center", justifyContent: "center", borderStyle: "dashed" },
  ring1: { width: 13, height: 13, borderRadius: 6.5, borderWidth: 1.7, alignItems: "center", justifyContent: "center" },
  dot: { width: 4, height: 4, borderRadius: 2 },
  person: { width: 22, height: 22, alignItems: "center" },
  head: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.7, marginTop: 1 },
  body: { width: 16, height: 9, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderWidth: 1.7, borderBottomWidth: 0, marginTop: 2 },
});

export function TabBar({ tab, onTab, badges }: { tab: Tab; onTab: (t: Tab) => void; badges: Partial<Record<Tab, boolean>> }) {
  const tabs: [Tab, string][] = [
    ["carry", "Carry"],
    ["around", "Around"],
    ["you", "You"],
  ];
  return (
    <View style={tb.bar} accessibilityRole="tablist">
      {tabs.map(([t, label]) => {
        const on = t === tab;
        const colour = on ? C.ink : C.ink3;
        return (
          <Pressable
            key={t}
            onPress={() => onTab(t)}
            accessibilityRole="tab"
            accessibilityLabel={badges[t] ? `${label}, something new` : label}
            accessibilityState={{ selected: on }}
            style={tb.tab}
          >
            {on ? <View style={tb.mark} /> : null}
            <Icon tab={t} colour={colour} />
            <Text style={[tb.label, { color: colour }]}>{label}</Text>
            {badges[t] ? <View style={tb.badge} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const tb = StyleSheet.create({
  bar: { flexDirection: "row", backgroundColor: C.card, borderTopWidth: 1.5, borderColor: C.ink },
  tab: { flex: 1, minHeight: 60, alignItems: "center", justifyContent: "center", gap: 2, paddingTop: 8, paddingBottom: 8 },
  mark: { position: "absolute", top: -1.5, left: "30%", right: "30%", height: 3, backgroundColor: C.ink },
  label: { fontFamily: FONT.face, fontSize: 13, fontWeight: "700" },
  // Colour is not the only signal: the tab's spoken label says "something new".
  badge: { position: "absolute", top: 8, left: "58%", width: 9, height: 9, borderRadius: 5, backgroundColor: C.slipDeep, borderWidth: 1.5, borderColor: C.card },
});

/** A short line of news at the bottom, on solid ink. Goes away on its own or on tap. */
export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4200);
    return () => clearTimeout(t);
  }, [text, onDone]);
  return (
    <Pressable onPress={onDone} style={to.box} accessibilityRole="alert" accessibilityLabel={text} accessibilityHint="Dismisses this message">
      <Text style={to.text}>{text}</Text>
    </Pressable>
  );
}

const to = StyleSheet.create({
  box: { position: "absolute", left: 16, right: 16, bottom: 150, backgroundColor: C.ink, borderRadius: 6, paddingHorizontal: 16, paddingVertical: 13, minHeight: 48, justifyContent: "center" },
  text: { fontFamily: FONT.face, fontSize: 15, fontWeight: "700", color: C.onInk, lineHeight: 21 },
});

/** The settlement moment: a card at the top with SETTLED slammed on it. */
export function Moment({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [text, onDone]);
  return (
    <Pressable onPress={onDone} style={mo.box} accessibilityRole="alert" accessibilityLabel={`Settled. ${text}`} accessibilityHint="Dismisses this message">
      <Text style={mo.text}>{text}</Text>
      <SettledStamp size={15} />
    </Pressable>
  );
}

const mo = StyleSheet.create({
  box: {
    position: "absolute",
    left: 14,
    right: 14,
    top: 10,
    backgroundColor: C.card,
    borderWidth: 1.5,
    borderColor: C.ink,
    borderRadius: 6,
    padding: 12,
    paddingLeft: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 48,
  },
  text: { flex: 1, fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink },
});

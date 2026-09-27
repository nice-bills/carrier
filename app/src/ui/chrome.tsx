import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { C, R, SHADOW } from "../theme";
import { FONT } from "./fonts";
import { ease, spring, useReducedMotion } from "./kit";

/** The three tabs. Icons are drawn with plain views. */
export type Tab = "carry" | "around" | "you";

const TABS: [Tab, string][] = [
  ["carry", "Carry"],
  ["around", "Around"],
  ["you", "You"],
];

function Icon({ tab, colour }: { tab: Tab; colour: string }) {
  if (tab === "carry") {
    // a slip: a rounded ticket with a line across
    return (
      <View style={[ic.slip, { borderColor: colour }]}>
        <View style={[ic.slipLine, { backgroundColor: colour }]} />
      </View>
    );
  }
  if (tab === "around") {
    // radio: a dot inside a ring
    return (
      <View style={[ic.ring, { borderColor: colour }]}>
        <View style={[ic.dot, { backgroundColor: colour }]} />
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
  slip: { width: 20, height: 14, borderWidth: 1.8, borderRadius: 4, justifyContent: "center", paddingHorizontal: 3 },
  slipLine: { height: 1.8, borderRadius: 1 },
  ring: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.8, alignItems: "center", justifyContent: "center" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  person: { width: 20, height: 20, alignItems: "center" },
  head: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.8, marginTop: 1 },
  body: { width: 15, height: 8, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderWidth: 1.8, borderBottomWidth: 0, marginTop: 2 },
});

/**
 * A floating, rounded tab bar. The dark pill behind the chosen tab's icon
 * slides to the new tab.
 */
export function TabBar({ tab, onTab, badges }: { tab: Tab; onTab: (t: Tab) => void; badges: Partial<Record<Tab, boolean>> }) {
  const reduced = useReducedMotion();
  const [w, setW] = useState(0);
  const idx = TABS.findIndex(([t]) => t === tab);
  const x = useRef(new Animated.Value(idx)).current;
  useEffect(() => {
    spring(x, idx, reduced, 5).start();
  }, [idx, reduced, x]);
  const each = w / TABS.length;
  return (
    <View style={tb.wrap}>
      <View style={tb.bar} accessibilityRole="tablist" onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        {w ? (
          <Animated.View
            style={[tb.pill, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [each / 2 - 24, each / 2 - 24 + each] }) }] }]}
          />
        ) : null}
        {TABS.map(([t, label]) => {
          const on = t === tab;
          return (
            <Pressable
              key={t}
              onPress={() => onTab(t)}
              accessibilityRole="tab"
              accessibilityLabel={badges[t] ? `${label}, something new` : label}
              accessibilityState={{ selected: on }}
              style={tb.tab}
            >
              <View style={tb.ic}>
                <Icon tab={t} colour={on ? C.onInk : C.ink3} />
              </View>
              <Text style={[tb.label, { color: on ? C.ink : C.ink3 }]}>{label}</Text>
              {badges[t] ? <View style={tb.badge} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const tb = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, backgroundColor: C.paper },
  bar: { flexDirection: "row", backgroundColor: C.card, borderRadius: 24, ...SHADOW, shadowOpacity: 0.1, shadowRadius: 20, elevation: 6 },
  pill: { position: "absolute", top: 10, left: 0, width: 48, height: 30, borderRadius: R.pill, backgroundColor: C.ink },
  tab: { flex: 1, minHeight: 66, alignItems: "center", justifyContent: "center", gap: 5, paddingTop: 10, paddingBottom: 8 },
  ic: { height: 30, width: 48, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: FONT.face, fontSize: 12, fontWeight: "700" },
  // Colour is not the only signal: the tab's spoken label says "something new".
  badge: { position: "absolute", top: 10, left: "60%", width: 9, height: 9, borderRadius: 5, backgroundColor: C.slipDeep, borderWidth: 2, borderColor: C.card },
});

/** Where a screen's bottom buttons end, so a toast can sit above them. */
export const DockRoom = createContext<(height: number) => void>(() => {});

/** Put on a screen's bottom button area: toasts then sit above it, not over it. */
export function useDock() {
  const report = useContext(DockRoom);
  useEffect(() => () => report(0), [report]);
  return (e: LayoutChangeEvent) => report(e.nativeEvent.layout.height);
}

/**
 * A short line of news, sitting just above the screen's bottom buttons so it
 * never covers the top of a list or the button you need next. Slides up, goes
 * away on its own or on tap.
 */
export function Toast({ text, onDone, above = 0 }: { text: string; onDone: () => void; above?: number }) {
  const reduced = useReducedMotion();
  const p = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    spring(p, 1, reduced, 5).start();
    const t = setTimeout(() => ease(p, 0, reduced, 200).start(() => onDone()), 4200);
    return () => clearTimeout(t);
  }, [text, onDone, p, reduced]);
  return (
    <Animated.View
      style={[to.wrap, { bottom: above + 12, opacity: p, transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] }]}
    >
      <Pressable onPress={onDone} style={to.box} accessibilityRole="alert" accessibilityLabel={text} accessibilityHint="Dismisses this message">
        <Text style={to.text}>{text}</Text>
      </Pressable>
    </Animated.View>
  );
}

const to = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, bottom: 12 },
  box: { backgroundColor: C.ink, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, minHeight: 48, justifyContent: "center", ...SHADOW, shadowOpacity: 0.2, elevation: 8 },
  text: { fontFamily: FONT.face, fontSize: 15, fontWeight: "600", color: C.onInk, lineHeight: 21 },
});

/** A payment settled somewhere else: a card that drops in at the top, with a green tick. */
export function Moment({ text, onDone }: { text: string; onDone: () => void }) {
  const reduced = useReducedMotion();
  const p = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    spring(p, 1, reduced, 6).start();
    const t = setTimeout(() => ease(p, 0, reduced, 220).start(() => onDone()), 6000);
    return () => clearTimeout(t);
  }, [text, onDone, p, reduced]);
  return (
    <Animated.View style={[mo.wrap, { opacity: p, transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [-60, 0] }) }] }]}>
      <Pressable onPress={onDone} style={mo.box} accessibilityRole="alert" accessibilityLabel={`Settled. ${text}`} accessibilityHint="Dismisses this message">
        <View style={mo.tick}>
          <View style={mo.tickMark} />
        </View>
        <Text style={mo.text}>{text}</Text>
      </Pressable>
    </Animated.View>
  );
}

const mo = StyleSheet.create({
  wrap: { position: "absolute", left: 14, right: 14, top: 10 },
  box: { backgroundColor: C.card, borderRadius: 20, padding: 14, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, ...SHADOW, shadowOpacity: 0.14, elevation: 8 },
  tick: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.green, alignItems: "center", justifyContent: "center" },
  tickMark: { width: 12, height: 7, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: C.onInk, transform: [{ rotate: "-45deg" }, { translateY: -1 }] },
  text: { flex: 1, fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink, fontWeight: "600" },
});

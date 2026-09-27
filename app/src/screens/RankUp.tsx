import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { RANKS } from "../rank";
import { C, R, S } from "../theme";
import { FONT } from "../ui/fonts";
import { announce, buzz, ease, spring, useReducedMotion } from "../ui/kit";

/**
 * Reaching a new rank takes over the screen for a moment, on the dark page:
 * the name pops in, the ladder fills to it, and a share card gets its stamp.
 * With reduced motion it is all simply there. Android's back button closes it.
 */

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const SHORT: Record<string, string> = { Superspreader: "Super" };
const SPARKS = 8;

export function RankUp({
  visible,
  rank,
  next,
  peopleMet,
  carried,
  onShare,
  onClose,
}: {
  visible: boolean;
  rank: string;
  next: string | null;
  peopleMet: number;
  carried: number;
  onShare: () => void;
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(visible);
  // While fading out the parent may already have cleared the rank: keep the last one.
  const last = useRef({ rank, next, peopleMet, carried });
  if (visible && rank) last.current = { rank, next, peopleMet, carried };
  const v = last.current;

  const fade = useRef(new Animated.Value(0)).current;
  const kicker = useRef(new Animated.Value(0)).current;
  const name = useRef(new Animated.Value(0)).current;
  const text = useRef(new Animated.Value(0)).current;
  const fill = useRef(new Animated.Value(0)).current;
  const card = useRef(new Animated.Value(0)).current;
  const stamp = useRef(new Animated.Value(0)).current;
  const sparks = useRef(new Animated.Value(0)).current;
  const btns = useRef(new Animated.Value(0)).current;
  const all = [fade, kicker, name, text, card, stamp, btns];

  useEffect(() => {
    if (visible) {
      setShown(true);
      buzz("success");
      announce(`New rank: ${rank}`);
      if (reduced) {
        all.forEach((a) => a.setValue(1));
        fill.setValue(1);
        sparks.setValue(0);
        return;
      }
      all.forEach((a) => a.setValue(0));
      fill.setValue(0);
      sparks.setValue(0);
      Animated.parallel([
        ease(fade, 1, false, 300),
        ease(kicker, 1, false, 300, 300),
        Animated.sequence([Animated.delay(450), spring(name, 1, false, 12)]),
        ease(text, 1, false, 350, 700),
        Animated.timing(fill, { toValue: 1, duration: 700, delay: 900, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }),
        Animated.sequence([Animated.delay(1400), spring(card, 1, false, 6)]),
        Animated.timing(stamp, { toValue: 1, duration: 300, delay: 2200, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(sparks, { toValue: 1, duration: 720, delay: 2480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ease(btns, 1, false, 300, 2700),
      ]).start();
    } else if (shown) {
      ease(fade, 0, reduced, 220).start(({ finished }) => finished && setShown(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduced]);

  const idx = Math.max(
    0,
    RANKS.findIndex((r) => r.name === v.rank),
  );
  const d = new Date();
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const rise = (a: Animated.Value, by: number) => ({ opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [by, 0] }) }] });

  return (
    <Modal visible={shown} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[s.page, { opacity: fade }]} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={s.body}>
          <Animated.Text style={[s.kicker, rise(kicker, 10)]}>NEW RANK</Animated.Text>
          <Animated.Text
            accessibilityRole="header"
            accessibilityLabel={`New rank: ${v.rank}`}
            style={[
              s.name,
              {
                opacity: name.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 1, 1], extrapolate: "clamp" }),
                transform: [{ scale: name.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
              },
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {v.rank}
          </Animated.Text>
          <Animated.Text style={[s.p, rise(text, 8)]}>
            You’ve now met {v.peopleMet} {v.peopleMet === 1 ? "person" : "people"} who pay by hand.
            {v.next ? ` Carry to more people and you’ll become a ${v.next}.` : ""}
          </Animated.Text>

          <View
            style={s.lad}
            accessible
            accessibilityLabel={`Ranks: ${RANKS.map((r, i) => `${r.name}${i === idx ? ", your rank" : i < idx ? ", reached" : ""}`).join("; ")}`}
          >
            {RANKS.map((r, i) => (
              <View key={r.name} style={s.seg}>
                {i < idx ? <View style={[s.segFill, { width: "100%", backgroundColor: C.onInk }]} /> : null}
                {i === idx ? <Animated.View style={[s.segFill, { backgroundColor: C.slip, width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} /> : null}
              </View>
            ))}
          </View>
          <View style={s.ll} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {RANKS.map((r, i) => (
              <Text key={r.name} style={[s.llText, i === idx && s.llMe]} numberOfLines={1}>
                {SHORT[r.name] ?? r.name}
              </Text>
            ))}
          </View>

          <Animated.View
            style={[s.card, rise(card, 60)]}
            accessible
            accessibilityLabel={`Share card: You're now a ${v.rank}. ${v.peopleMet} ${v.peopleMet === 1 ? "person" : "people"} met, ${v.carried} ${v.carried === 1 ? "payment" : "payments"} carried.`}
          >
            <Text style={s.who}>Passed hand to hand, offline</Text>
            <Text style={s.title}>
              You’re now{"\n"}a {v.rank}
            </Text>
            <View style={s.stats}>
              <Stat n={v.peopleMet} label={v.peopleMet === 1 ? "person met" : "people met"} />
              <Stat n={v.carried} label={v.carried === 1 ? "payment carried" : "payments carried"} />
            </View>
            <View style={s.stampBox} pointerEvents="none">
              {Array.from({ length: SPARKS }, (_, i) => {
                const a = (i / SPARKS) * Math.PI * 2;
                const dist = sparks.interpolate({ inputRange: [0, 1], outputRange: [30, 64] });
                return (
                  <Animated.View
                    key={i}
                    style={[
                      s.spark,
                      {
                        opacity: sparks.interpolate({ inputRange: [0, 0.02, 1], outputRange: [0, 1, 0] }),
                        transform: [
                          { translateX: Animated.multiply(dist, Math.cos(a)) },
                          { translateY: Animated.multiply(dist, Math.sin(a)) },
                          { scale: sparks.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }) },
                        ],
                      },
                    ]}
                  />
                );
              })}
              <Animated.View
                style={[
                  s.stamp,
                  {
                    opacity: stamp.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] }),
                    transform: [{ rotate: "-10deg" }, { scale: stamp.interpolate({ inputRange: [0, 1], outputRange: [2.2, 1] }) }],
                  },
                ]}
              >
                <Text style={s.stampText} numberOfLines={1} adjustsFontSizeToFit>
                  {(SHORT[v.rank] ?? v.rank).toUpperCase()}
                </Text>
                <Text style={s.stampText}>{date}</Text>
              </Animated.View>
            </View>
          </Animated.View>

          <Animated.View style={[s.btns, rise(btns, 10)]}>
            <Btn label="Share card" hint="Opens the share sheet with a line about your new rank" onPress={onShare} light />
            <Btn label="Keep going" hint="Closes this and goes back to the app" onPress={onClose} />
          </Animated.View>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <View>
      <Text style={s.statN}>{n}</Text>
      <Text style={s.statK}>{label}</Text>
    </View>
  );
}

function Btn({ label, hint, onPress, light }: { label: string; hint: string; onPress: () => void; light?: boolean }) {
  const reduced = useReducedMotion();
  const sc = useRef(new Animated.Value(1)).current;
  return (
    <Animated.View style={{ flex: 1, transform: [{ scale: sc }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={() => spring(sc, 0.97, reduced, 0).start()}
        onPressOut={() => spring(sc, 1, reduced, 6).start()}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[s.btn, { backgroundColor: light ? C.card : C.night2 }]}
      >
        <Text style={[s.btnText, { color: light ? C.ink : C.onInk }]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.night },
  body: { paddingHorizontal: S.xl, paddingTop: 92, paddingBottom: 40 },
  kicker: { fontFamily: FONT.face, fontSize: 13, fontWeight: "700", letterSpacing: 1.4, color: C.nightAmber },
  name: { fontFamily: FONT.face, fontSize: 56, lineHeight: 62, fontWeight: "800", letterSpacing: -2, color: C.onInk, marginTop: 10, transformOrigin: "0% 80%" } as any,
  p: { fontFamily: FONT.face, fontSize: 16, lineHeight: 23, color: C.onNight2, marginTop: 12 },
  lad: { flexDirection: "row", gap: 6, marginTop: 26 },
  seg: { flex: 1, height: 10, borderRadius: R.pill, backgroundColor: C.night2, overflow: "hidden" },
  segFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: R.pill },
  ll: { flexDirection: "row", gap: 6, marginTop: 8 },
  llText: { flex: 1, textAlign: "center", fontFamily: FONT.face, fontSize: 12, fontWeight: "500", color: C.onNight2 },
  llMe: { color: C.onInk, fontWeight: "700" },
  card: { marginTop: 26, backgroundColor: C.slip, borderRadius: R.card, padding: 20 },
  who: { fontFamily: FONT.face, fontSize: 14, fontWeight: "600", color: C.slipInk2, paddingRight: 90 },
  title: { fontFamily: FONT.face, fontSize: 30, lineHeight: 33, fontWeight: "800", letterSpacing: -0.8, color: C.slipInk, marginTop: 6, paddingRight: 90 },
  stats: { flexDirection: "row", gap: 24, marginTop: 16 },
  statN: { fontFamily: FONT.face, fontSize: 22, fontWeight: "800", color: C.slipInk },
  statK: { fontFamily: FONT.face, fontSize: 12, fontWeight: "500", color: C.slipInk2 },
  stampBox: { position: "absolute", right: 18, top: 18, width: 78, height: 78, alignItems: "center", justifyContent: "center" },
  stamp: { width: 78, height: 78, borderRadius: 39, borderWidth: 2.5, borderColor: C.stampInk, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  stampText: { fontFamily: FONT.mono, fontSize: 11, lineHeight: 13, fontWeight: "700", color: C.stampInk, textAlign: "center" },
  spark: { position: "absolute", width: 6, height: 6, borderRadius: 3, backgroundColor: C.nightAmber },
  btns: { flexDirection: "row", gap: 10, marginTop: 22 },
  btn: { minHeight: 52, borderRadius: R.box, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  btnText: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700" },
});

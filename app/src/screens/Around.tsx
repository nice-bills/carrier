import { useEffect, useRef, useState } from "react";
import { Animated, Easing, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, R, S } from "../theme";
import { FONT } from "../ui/fonts";
import { Button, Card, Head, Note, ScreenHead, Segmented, useReducedMotion } from "../ui/kit";
import type { Carrier } from "../useCarrier";
import { FeedRow, PersonRow } from "./People";
import { radioLine } from "./radioLine";

/**
 * Around: who is in range now, and the logbook of what this phone has seen:
 * handoffs, arrivals, settlements. It only knows what reached this phone;
 * there is no server telling it about anyone else.
 */
export function AroundScreen({ c, onPick }: { c: Carrier; onPick: (key: string) => void }) {
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const pocket = c.pocket!;
  const rows = pocket.feed.filter((e) => filter === "all" || e.mine);
  const hour = Date.now() - 3_600_000;
  const recent = rows.filter((e) => e.at >= hour);
  const older = rows.filter((e) => e.at < hour);
  const n = c.peers.length;

  return (
    <View style={{ flex: 1 }}>
      <ScreenHead title="Around you" sub="People in range, and what this phone has seen" />
      <ScrollView contentContainerStyle={s.body}>
        {n ? (
          <>
            <Head title="In range" aside={`${n} ${n === 1 ? "phone" : "phones"}`} />
            <Card pad={false} style={s.list}>
              {c.peers.map((key, i) => {
                const k = key.toBase58();
                return (
                  <PersonRow
                    key={k}
                    person={{ key, met: pocket.hasMet(key), holding: c.holdings[k] ?? 0, forThem: false }}
                    first={i === 0}
                    selected={false}
                    target={false}
                    hint="Opens the Carry tab with them chosen, to hand over, take or pay"
                    onPress={() => onPick(k)}
                  />
                );
              })}
            </Card>
          </>
        ) : (
          <>
            <NobodyNearby c={c} />
            {c.slips.length ? (
              <Note>
                You’re still carrying {c.slips.length} {c.slips.length === 1 ? "payment" : "payments"}. They’re safe on this phone until you meet someone.
              </Note>
            ) : null}
          </>
        )}

        <View style={{ marginTop: 22 }}>
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              ["all", "Everything"],
              ["mine", "Just you"],
            ]}
          />
        </View>

        <View accessibilityLiveRegion="polite">
          {!rows.length ? (
            <Card style={{ marginTop: 16 }}>
              <Text style={s.emptyTitle}>Nothing here yet</Text>
              <Text style={s.emptySmall}>
                Every handoff you make, every payment that reaches you and every settlement you earn from is logged here.
              </Text>
            </Card>
          ) : null}
          {recent.length ? (
            <>
              <Head title="Last hour" />
              <Card pad={false} style={s.list}>
                {recent.map((e, i) => (
                  <FeedRow key={e.id} e={e} first={i === 0} />
                ))}
              </Card>
            </>
          ) : null}
          {older.length ? (
            <>
              <Head title="Earlier" />
              <Card pad={false} style={s.list}>
                {older.map((e, i) => (
                  <FeedRow key={e.id} e={e} first={i === 0} />
                ))}
              </Card>
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** Nobody in range: a quiet radar, and what this phone needs to be found. */
function NobodyNearby({ c }: { c: Carrier }) {
  const radio = c.radio;
  const allowed = radio.state !== "needs-permission";
  const on = radio.state === "on";
  let action: { label: string; hint: string; onPress: () => void } | null = null;
  if (radio.state === "needs-permission") {
    action = radio.blocked
      ? { label: "Open settings", hint: "Opens settings to allow Nearby devices", onPress: c.services.openSettings }
      : { label: "Allow nearby access", hint: "Asks Android for Nearby devices and Location", onPress: c.startRadio };
  } else if (radio.state === "off" || radio.state === "unavailable") {
    action = { label: "Look for people", hint: "Turns the radio on so nearby phones can find you", onPress: c.startRadio };
  }
  return (
    <Card style={s.empty}>
      <Radar live={on} />
      <Text style={s.emptyTitle} accessibilityRole="header">
        No one nearby yet
      </Text>
      <Text style={[s.emptySmall, { textAlign: "center" }]}>Phones running Carrier show up here on their own when they’re close.</Text>
      <View style={s.checks} accessibilityLiveRegion="polite">
        <Check
          tone={allowed ? "ok" : "warn"}
          text={allowed ? "Nearby access allowed" : "Nearby access is off"}
          detail={allowed ? undefined : radioLine(radio, 0)}
        />
        <Check
          tone={on ? "ok" : "warn"}
          text={on ? "Radio on" : radio.state === "starting" ? "Turning the radio on" : "Radio off"}
          detail={!on && allowed && radio.state !== "starting" ? radioLine(radio, 0) : undefined}
        />
        <Check tone="info" text="Keep Carrier open while you look" />
      </View>
      {action ? <Button label={action.label} hint={action.hint} onPress={action.onPress} style={{ alignSelf: "stretch", marginTop: 12 }} /> : null}
    </Card>
  );
}

function Check({ tone, text, detail }: { tone: "ok" | "warn" | "info"; text: string; detail?: string }) {
  const state = tone === "ok" ? "done" : tone === "warn" ? "not yet" : "tip";
  return (
    <View style={s.check} accessible accessibilityLabel={`${text}, ${state}.${detail ? ` ${detail}` : ""}`}>
      <View style={[s.ico, tone === "ok" ? s.icoOk : tone === "warn" ? s.icoWarn : s.icoInfo]}>
        {tone === "ok" ? (
          <View style={s.tick} />
        ) : (
          <Text style={[s.icoText, { color: tone === "warn" ? C.amberInk : C.ink2 }]}>{tone === "warn" ? "!" : "i"}</Text>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.checkText}>{text}</Text>
        {detail ? <Text style={s.checkDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/** Two still rings and a green dot that breathes while the radio listens. */
function Radar({ live }: { live: boolean }) {
  const reduced = useReducedMotion();
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!live || reduced) {
      p.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(p, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [live, reduced, p]);
  return (
    <View style={s.radar} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={[s.ring, { width: 120, height: 120, borderRadius: 60 }]} />
      <View style={[s.ring, { width: 80, height: 80, borderRadius: 40 }]} />
      <View style={s.core} />
      {live && !reduced ? (
        <Animated.View
          style={[
            s.pulse,
            { opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [1, 5] }) }] },
          ]}
        />
      ) : null}
      <View style={[s.halo, !live && { backgroundColor: C.paper2 }]} />
      <View style={[s.dot, !live && { backgroundColor: C.outline }]} />
    </View>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: S.gutter, paddingBottom: 32 },
  list: { overflow: "hidden", paddingVertical: 4 },
  empty: { marginTop: 16, alignItems: "center", paddingTop: 26 },
  emptyTitle: { fontFamily: FONT.face, fontSize: 18, fontWeight: "700", color: C.ink },
  emptySmall: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2, marginTop: 6 },
  radar: { width: 120, height: 120, alignItems: "center", justifyContent: "center", marginBottom: 14 },
  ring: { position: "absolute", borderWidth: 1.5, borderColor: C.rule },
  core: { position: "absolute", width: 40, height: 40, borderRadius: 20, backgroundColor: C.paper2 },
  pulse: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: C.green },
  halo: { position: "absolute", width: 26, height: 26, borderRadius: 13, backgroundColor: C.greenSoft },
  dot: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.green },
  checks: { alignSelf: "stretch", marginTop: 14 },
  check: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 11, borderTopWidth: 1, borderColor: C.rule },
  ico: { width: 22, height: 22, borderRadius: R.pill, alignItems: "center", justifyContent: "center" },
  icoOk: { backgroundColor: C.greenSoft },
  icoWarn: { backgroundColor: C.amberSoft },
  icoInfo: { backgroundColor: C.paper2 },
  icoText: { fontFamily: FONT.face, fontSize: 13, fontWeight: "800", lineHeight: 16 },
  tick: { width: 10, height: 6, borderLeftWidth: 2.2, borderBottomWidth: 2.2, borderColor: C.greenInk, transform: [{ translateY: -1 }, { rotate: "-45deg" }] },
  checkText: { fontFamily: FONT.face, fontSize: 14, fontWeight: "600", color: C.ink, lineHeight: 22 },
  checkDetail: { fontFamily: FONT.face, fontSize: 13, lineHeight: 18, color: C.ink2, marginTop: 2 },
});

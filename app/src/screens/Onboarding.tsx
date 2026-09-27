import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { shorten } from "../format";
import { C, R, S } from "../theme";
import { FONT } from "../ui/fonts";
import {
  Appear,
  Avatar,
  Button,
  Card,
  KeyTag,
  LinkButton,
  Mark,
  Receipt,
  Rule,
  SettledStamp,
  Stamp,
  announce,
  spring,
  type,
  useReducedMotion,
} from "../ui/kit";
import { useDock } from "../ui/chrome";
import type { Carrier } from "../useCarrier";
import { PeopleEmpty, PersonRow } from "./People";
import { radioLine } from "./radioLine";

/**
 * First run. Five steps, and the last one is not a slide: it is a real
 * handoff with a real phone nearby. The radio permission and the public
 * record are each explained in one sentence, on the step where they matter.
 */

export const STEPS = 5;

type Perm = "unset" | "granted" | "denied";

export function Onboarding({
  c,
  step,
  setStep,
  onLegal,
}: {
  c: Carrier;
  step: number;
  setStep: (n: number) => void;
  onLegal: (which: "terms" | "privacy") => void;
}) {
  const onDock = useDock();
  const [perm, setPerm] = useState<Perm>("unset");
  const [making, setMaking] = useState(false);
  const [signed, setSigned] = useState(false);
  const hasKey = !!c.wallet;
  const first = useRef(true);

  // Each step change is read out, so a screen reader is not left on the old one.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    announce(`Step ${step + 1} of ${STEPS}. ${TITLES[step]}`);
  }, [step]);

  const next = async () => {
    if (step === 0) return setStep(1);
    if (step === 1) {
      if (perm === "unset") {
        const r = await c.services.requestRadioPermissions().catch(() => ({ granted: false, blocked: false }));
        setPerm(r.granted ? "granted" : "denied");
        return;
      }
      return setStep(2);
    }
    if (step === 2) {
      if (hasKey) return setStep(3);
      setMaking(true);
      await c.makeKey();
      setMaking(false);
      return;
    }
    if (step === 3 && signed) {
      setStep(4);
      c.startRadio();
      return;
    }
    if (step === 4) return c.finishOnboarding();
  };

  const primary =
    step === 0
      ? { label: "Set up this phone" }
      : step === 1
        ? { label: perm === "unset" ? "Allow nearby access" : "Continue" }
        : step === 2
          ? { label: hasKey ? "Continue" : "Make my key", busy: making }
          : step === 3
            ? { label: "Start carrying", disabled: !signed }
            : { label: c.firstHandoff ? "Open my pocket" : "Waiting for a handoff", disabled: !c.firstHandoff };

  return (
    <View style={{ flex: 1 }}>
      <View style={s.top}>
        {step > 0 ? (
          <Pressable onPress={() => setStep(step - 1)} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [s.back, pressed && { opacity: 0.6 }]}>
            <Text style={s.backText}>Back</Text>
          </Pressable>
        ) : (
          <View style={s.back} />
        )}
        <View style={s.progress} accessible accessibilityLabel={`Step ${step + 1} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <View key={i} style={[s.pip, i <= step && s.pipDone]} />
          ))}
        </View>
        <Text style={s.count} importantForAccessibility="no">
          {step + 1} of {STEPS}
        </Text>
      </View>

      <ScrollView contentContainerStyle={s.body}>
        {step === 0 ? <Welcome /> : null}
        {step === 1 ? <Radio perm={perm} /> : null}
        {step === 2 ? <Key keyText={c.wallet?.publicKey.toBase58() ?? null} making={making} /> : null}
        {step === 3 ? <Terms signed={signed} setSigned={setSigned} onLegal={onLegal} /> : null}
        {step === 4 ? <FirstHandoff c={c} /> : null}
      </ScrollView>

      <View style={s.dock} onLayout={onDock}>
        <Button label={primary.label} busy={"busy" in primary ? primary.busy : false} disabled={"disabled" in primary ? primary.disabled : false} onPress={next} />
        {step === 1 && perm === "unset" ? (
          <Button
            label="Not now"
            variant="quiet"
            hint="You can still set up. Carrier cannot see anyone until this is on."
            onPress={() => {
              setPerm("denied");
              setStep(2);
            }}
          />
        ) : null}
        {step === 4 && !c.firstHandoff ? (
          <Button label="Skip for now" variant="quiet" hint="Opens the app. The tips there walk you through your first handoff." onPress={() => c.finishOnboarding()} />
        ) : null}
        {step === 0 ? <Text style={s.foot}>About a minute. No sign-up.</Text> : null}
        {step === 3 && !signed ? <Text style={s.foot}>Sign the receipt above to continue.</Text> : null}
      </View>
    </View>
  );
}

const TITLES = [
  "Money that travels by hand",
  "Let Carrier find phones near you",
  "This phone gets its own key",
  "Sign for it",
  "Make your first handoff",
];

function Kicker({ text }: { text: string }) {
  return <Text style={[type.label, { marginBottom: 6 }]}>{text}</Text>;
}

function H2({ children }: { children: ReactNode }) {
  return (
    <Text style={s.h2} accessibilityRole="header">
      {children}
    </Text>
  );
}

const LINES = [
  "Ama signs 12.00 for Zanele. Nobody here has signal.",
  "Chidi is heading that way. Both phones sign, and the slip gets his stamp.",
  "Mei takes it onto the bus. Another stamp.",
  "Tunde gets signal. The whole chain settles on Solana at once.",
  "Zanele is paid 12.00. Chidi, Mei and Tunde each get a share.",
];
const WALK = [
  ["Am", "Ama", "sends"],
  ["Ch", "Chidi", "carries"],
  ["Me", "Mei", "carries"],
  ["Tu", "Tunde", "finds signal"],
  ["Za", "Zanele", "is paid"],
] as const;
const HERO = ["Money that", "travels", "by hand."];

function Welcome() {
  const reduced = useReducedMotion();
  const [at, setAt] = useState(reduced ? 4 : 0);
  useEffect(() => {
    if (reduced) {
      setAt(4);
      return;
    }
    const t = setTimeout(() => setAt((a) => (a >= 4 ? 0 : a + 1)), at === 4 ? 3600 : 1900);
    return () => clearTimeout(t);
  }, [at, reduced]);
  const slide = useRef(new Animated.Value(reduced ? 0 : 1)).current;
  useEffect(() => {
    if (reduced) {
      slide.setValue(0);
      return;
    }
    Animated.sequence([Animated.delay(450), spring(slide, 0, false, 6)]).start();
  }, [reduced, slide]);
  const shown = Math.min(at, 3) + 1;
  return (
    <View>
      <Appear from={6}>
        <View style={s.wordmark}>
          <View style={s.glyph} />
          <Text style={s.wordText}>Carrier</Text>
        </View>
      </Appear>
      <View accessible accessibilityRole="header" accessibilityLabel="Money that travels by hand." style={{ marginBottom: 12 }}>
        {HERO.map((line, i) => (
          <Appear key={line} delay={100 + i * 120} from={18}>
            <Text style={s.hero}>{line}</Text>
          </Appear>
        ))}
      </View>
      <Appear delay={450} from={10}>
        <Text style={s.p}>
          Pay someone when nobody has signal. The payment passes from phone to phone, and the first phone to get back online settles it.
          Everyone who carried it gets a share.
        </Text>
      </Appear>
      <View
        accessible
        accessibilityLabel="Ama signs a payment of 12.00 for Zanele with no signal. Chidi and then Mei carry it, and each handoff adds a stamp signed by both phones. When Tunde finds signal the chain settles on Solana: Zanele is paid, and Chidi, Mei and Tunde each receive a share."
        style={{ marginTop: 4 }}
      >
        <Animated.View
          style={[
            s.demoSlip,
            { opacity: slide.interpolate({ inputRange: [0, 0.8, 1], outputRange: [1, 1, 0] }), transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, 320] }) }] },
          ]}
        >
          <View style={s.demoHead}>
            <Text style={s.demoFor}>
              For <Text style={{ fontWeight: "700", color: C.slipInk }}>Zanele</Text> · from Ama
            </Text>
            <Text style={s.demoAmt}>
              12.00<Text style={s.demoUnit}> USDC</Text>
            </Text>
          </View>
          <View style={s.perfRow}>
            <View style={[s.notch, { left: -9 }]} />
            <View style={s.perf}>
              {Array.from({ length: 28 }, (_, i) => (
                <View key={i} style={s.perfDot} />
              ))}
            </View>
            <View style={[s.notch, { right: -9 }]} />
          </View>
          <View style={s.demoStamps}>
            {["Ama", "Chidi", "Mei", "Tunde"].slice(0, shown).map((n, i) => (
              <View key={n} style={i ? { marginLeft: 6 } : null}>
                <Stamp top={n.toUpperCase()} mid={`1${i}:${i * 2}4`} bottom={i ? `HOP ${i}` : "SENT"} seed={n} size={52} fresh={!reduced} />
              </View>
            ))}
          </View>
          {at >= 3 ? (
            <View style={{ position: "absolute", right: 14, bottom: 22 }}>
              <SettledStamp size={15} animate={!reduced} key={at === 3 ? "slam" : "still"} />
            </View>
          ) : null}
        </Animated.View>
        <View style={s.walk}>
          {WALK.map(([ab, name, role], i) => (
            <View key={name} style={s.walkStep}>
              {i > 0 ? <Conn on={at >= i} /> : null}
              <View style={s.walker}>
                {i === 4 && at >= 4 ? (
                  <View style={s.paid}>
                    <Text style={s.paidText}>{ab}</Text>
                  </View>
                ) : (
                  <Avatar text={ab} met={i <= at && i < 4} size={40} />
                )}
                <Text style={s.walkName}>{name}</Text>
                <Text style={s.walkRole}>{role}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text style={s.caption}>
          <Text style={s.captionN}>{at + 1}/5 </Text>
          {LINES[at]}
        </Text>
      </View>
    </View>
  );
}

/** The line between two people on the walk; it fills in ink once the slip has passed. */
function Conn({ on }: { on: boolean }) {
  const reduced = useReducedMotion();
  const w = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(w, { toValue: on ? 1 : 0, duration: reduced ? 0 : on ? 320 : 180, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [on, reduced, w]);
  return (
    <View style={s.conn}>
      <Animated.View style={[s.connFill, { width: w.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
    </View>
  );
}

function Radio({ perm }: { perm: Perm }) {
  const state = perm === "granted" ? "ALLOWED" : perm === "denied" ? "OFF" : "NOT ASKED";
  const tone = perm === "granted" ? "green" : perm === "denied" ? "red" : "grey";
  return (
    <View>
      <Kicker text="First, the radio" />
      <H2>Let Carrier find phones near you</H2>
      <Text style={s.p}>Handoffs travel over local radio, about as far as you could pass something across a room.</Text>
      <Card pad={false} style={{ paddingHorizontal: 18 }}>
        {(
          [
            ["Nearby devices", "Bluetooth and Wi-Fi Direct, to see phones within about 10 metres and hand payments to them.", null],
            ["Location", "Android requires it before any app may scan for other phones.", "We never look at where you are."],
          ] as const
        ).map(([b, why, aside], i) => (
          <View
            key={b}
            style={[s.permRow, i > 0 && s.permSep]}
            accessible
            accessibilityLabel={`${b}: ${why} ${aside ? `Carrier never reads your location.` : ""} ${state.toLowerCase()}.`}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.permB}>{b}</Text>
              <Text style={s.permWhy}>{why}</Text>
              {aside ? <Text style={s.permAside}>{aside}</Text> : null}
            </View>
            <Mark text={state} tone={tone} />
          </View>
        ))}
      </Card>
      {perm !== "unset" ? (
        <Text style={s.after} accessibilityLiveRegion="polite">
          {perm === "granted"
            ? "Carrier only uses the radio while it is open."
            : "You can still set up. Carrier cannot see anyone until this is on, and you can turn it on from the Carry tab."}
        </Text>
      ) : null}
    </View>
  );
}

function Key({ keyText, making }: { keyText: string | null; making: boolean }) {
  return (
    <View>
      <Kicker text="Then, your key" />
      <H2>This phone gets its own key</H2>
      <Text style={s.p}>It signs every handoff you make. It is made on this phone and never leaves it. No account, no password.</Text>
      <KeyTag keyText={keyText} making={making} />
    </View>
  );
}

function Terms({ signed, setSigned, onLegal }: { signed: boolean; setSigned: (v: boolean) => void; onLegal: (w: "terms" | "privacy") => void }) {
  const items: [string, string, string][] = [
    ["This is a ", "test build on Solana devnet.", " Balances are test tokens and are worth nothing."],
    ["When a payment settles, ", "the keys of everyone who carried it are written to a public ledger,", " with the time of each handoff. That record cannot be deleted."],
    ["Nothing else leaves your phone. ", "No name, contacts or location.", ""],
    ["Sign two payments against the same slot and ", "your bond is taken", " and paid to whoever was cheated."],
  ];
  return (
    <View>
      <Kicker text="Last thing" />
      <H2>Sign for it</H2>
      <Receipt title="Carrier terms" subtitle="Devnet build · 23 Sep 2026" style={{ paddingBottom: 16 }}>
        {items.map(([a, b, c2], i) => (
          <View key={i} style={s.term}>
            <View style={s.termN}>
              <Text style={s.termNText}>{i + 1}</Text>
            </View>
            <Text style={s.termText}>
              {a}
              <Text style={{ fontWeight: "700", color: C.ink }}>{b}</Text>
              {c2}
            </Text>
          </View>
        ))}
        <Rule />
        <View style={{ flexDirection: "row", gap: 18 }}>
          <LinkButton label="Terms of use" onPress={() => onLegal("terms")} color={C.ink} />
          <LinkButton label="Privacy policy" onPress={() => onLegal("privacy")} color={C.ink} />
        </View>
        <View style={s.pad}>
          <Text style={s.x}>×</Text>
          {signed ? (
            <Appear from={4}>
              <Text style={s.sig}>Signed on this phone</Text>
            </Appear>
          ) : null}
        </View>
        <Text style={s.cap}>Signature</Text>
        <Pressable
          onPress={() => setSigned(!signed)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: signed }}
          accessibilityLabel="Sign to agree"
          accessibilityHint={signed ? "Signed. Tap to undo." : "Agrees to the four points above"}
          style={({ pressed }) => [s.signBtn, signed && s.signBtnOn, pressed && { opacity: 0.85 }]}
        >
          <View style={[s.box, signed && s.boxOn]}>{signed ? <View style={s.boxTick} /> : null}</View>
          <Text style={[s.signText, signed && { color: C.onInk }]}>{signed ? "Signed. Tap to undo" : "Sign to agree"}</Text>
        </Pressable>
      </Receipt>
    </View>
  );
}

function FirstHandoff({ c }: { c: Carrier }) {
  const pocket = c.pocket;
  return (
    <View>
      <Kicker text="Now, for real" />
      <H2>{c.firstHandoff ? "Stamped. That was a real handoff." : "Make your first handoff"}</H2>
      <Text style={s.p}>
        {c.firstHandoff
          ? "Both phones signed it. It is in your pocket now, or on its way in someone else's."
          : "Find someone else with Carrier open and stand near them. If they are holding a payment, take it. If they hand you one, it arrives on its own."}
      </Text>
      <Text style={s.radioLine} accessibilityLiveRegion="polite">
        {radioLine(c.radio, c.peers.length)}
      </Text>
      {c.peers.length && pocket ? (
        <Card pad={false} style={{ paddingVertical: 4, overflow: "hidden" }}>
          {c.peers.map((key, i) => {
            const k = key.toBase58();
            const holding = c.holdings[k] ?? 0;
            return (
              <View key={k}>
                <PersonRow
                  person={{ key, met: pocket.hasMet(key), holding, forThem: false }}
                  first={i === 0}
                  selected={false}
                  target={false}
                  hint={holding ? "Takes their payment" : "They have nothing to hand you yet"}
                  onPress={() => (holding ? c.take(key) : c.say(`${shorten(key)} is not holding anything yet. Ask them to hand you something.`))}
                />
              </View>
            );
          })}
        </Card>
      ) : (
        <PeopleEmpty text="Nobody in range yet. Hold your phone near someone else with Carrier open." />
      )}
      {c.radio.state === "needs-permission" || c.radio.state === "off" ? (
        <View style={{ marginTop: 12 }}>
          <Button label="Turn the radio on" variant="quiet" hint="Asks for nearby access again" onPress={c.startRadio} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 8, minHeight: 56 },
  back: { minWidth: 64, minHeight: 48, justifyContent: "center", paddingHorizontal: 8 },
  backText: { fontFamily: FONT.face, fontSize: 15, fontWeight: "600", color: C.ink2 },
  progress: { flexDirection: "row", gap: 6 },
  pip: { width: 26, height: 6, borderRadius: R.pill, backgroundColor: C.paper2 },
  pipDone: { backgroundColor: C.slip },
  count: { minWidth: 64, textAlign: "right", paddingRight: 8, fontFamily: FONT.face, fontSize: 13, fontWeight: "500", color: C.ink2 },
  body: { paddingHorizontal: S.gutter, paddingTop: 14, paddingBottom: 12 },
  dock: { paddingHorizontal: S.gutter, paddingTop: 10, paddingBottom: 16, gap: 8 },
  foot: { fontFamily: FONT.face, fontSize: 13, color: C.ink3, textAlign: "center" },
  h2: { fontFamily: FONT.face, fontSize: 30, fontWeight: "800", letterSpacing: -0.8, lineHeight: 35, color: C.ink, marginBottom: 10 },
  hero: { fontFamily: FONT.face, fontSize: 42, fontWeight: "800", letterSpacing: -1.4, lineHeight: 45, color: C.ink },
  p: { fontFamily: FONT.face, fontSize: 16, lineHeight: 23, color: C.ink2, marginBottom: 18 },
  wordmark: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 22, marginTop: 4 },
  glyph: { width: 26, height: 18, borderRadius: 5, backgroundColor: C.slip },
  wordText: { fontFamily: FONT.face, fontSize: 18, fontWeight: "700", color: C.ink },
  demoSlip: { backgroundColor: C.slip, borderRadius: 20, width: "100%", alignSelf: "center", maxWidth: 380 },
  demoHead: { paddingHorizontal: 18, paddingTop: 16 },
  demoFor: { fontFamily: FONT.face, fontSize: 14, fontWeight: "500", color: C.slipInk2 },
  demoAmt: { fontFamily: FONT.face, fontSize: 40, fontWeight: "800", letterSpacing: -1.4, color: C.slipInk, marginTop: 4 },
  demoUnit: { fontSize: 15, fontWeight: "600", color: C.slipInk2, letterSpacing: 0 },
  perfRow: { height: 18, justifyContent: "center", marginTop: 8 },
  perf: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16 },
  perfDot: { width: 4, height: 2, borderRadius: 1, backgroundColor: C.slipDeep },
  notch: { position: "absolute", top: 0, width: 18, height: 18, borderRadius: 9, backgroundColor: C.paper },
  demoStamps: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 6, paddingBottom: 16, minHeight: 80, alignItems: "center" },
  walk: { flexDirection: "row", marginTop: 22 },
  walkStep: { flexDirection: "row", flex: 1, alignItems: "flex-start" },
  walker: { alignItems: "center", gap: 4, width: 58 },
  conn: { flex: 1, height: 2, borderRadius: 1, backgroundColor: C.rule, marginTop: 19, marginHorizontal: -8, overflow: "hidden" },
  connFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: C.ink },
  paid: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.green, alignItems: "center", justifyContent: "center" },
  paidText: { fontFamily: FONT.face, fontWeight: "700", fontSize: 13, color: C.onInk },
  walkName: { fontFamily: FONT.face, fontSize: 12, fontWeight: "600", color: C.ink2 },
  walkRole: { fontFamily: FONT.face, fontSize: 11, color: C.ink3, textAlign: "center" },
  caption: { fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 14, minHeight: 44 },
  captionN: { fontFamily: FONT.face, fontWeight: "700", fontSize: 13, color: C.ink3 },
  permRow: { flexDirection: "row", gap: 14, paddingVertical: 16, alignItems: "flex-start" },
  permSep: { borderTopWidth: 1, borderColor: C.rule },
  permB: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700", color: C.ink },
  permWhy: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 2 },
  permAside: { fontFamily: FONT.face, fontSize: 13, fontWeight: "600", color: C.ink2, marginTop: 6 },
  after: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 14 },
  term: { flexDirection: "row", gap: 12, paddingVertical: 8 },
  termN: { width: 24, height: 24, borderRadius: 12, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center", marginTop: -1 },
  termNText: { fontFamily: FONT.face, fontSize: 12, fontWeight: "800", color: C.amberInk },
  termText: { flex: 1, fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2 },
  pad: { height: 56, borderBottomWidth: 1.5, borderColor: C.ruleStrong, justifyContent: "flex-end", marginTop: 10 },
  x: { position: "absolute", left: 0, bottom: 6, fontFamily: FONT.face, fontWeight: "700", color: C.ink3, fontSize: 16 },
  sig: { fontFamily: FONT.face, fontSize: 20, fontWeight: "600", color: C.signInk, marginLeft: 24, marginBottom: 6 },
  cap: { fontFamily: FONT.face, fontSize: 12, color: C.ink3, marginTop: 6 },
  signBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "stretch",
    minHeight: 52,
    justifyContent: "center",
    marginTop: 12,
    paddingHorizontal: 16,
    borderRadius: R.box,
    borderWidth: 1.5,
    borderColor: C.outline,
    backgroundColor: C.card,
  },
  signBtnOn: { backgroundColor: C.ink, borderColor: C.ink },
  box: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: C.outline, alignItems: "center", justifyContent: "center" },
  boxOn: { borderColor: C.onInk, backgroundColor: C.onInk },
  boxTick: { width: 10, height: 6, borderLeftWidth: 2.2, borderBottomWidth: 2.2, borderColor: C.ink, transform: [{ translateY: -1 }, { rotate: "-45deg" }] },
  signText: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700", color: C.ink },
  radioLine: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginBottom: 10 },
});

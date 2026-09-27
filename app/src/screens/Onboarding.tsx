import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { shorten } from "../format";
import { C, S } from "../theme";
import { FONT } from "../ui/fonts";
import { Avatar, Button, KeyTag, LinkButton, Mark, Receipt, Rule, SettledStamp, Stamp, announce, useReducedMotion } from "../ui/kit";
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
          <Pressable onPress={() => setStep(step - 1)} accessibilityRole="button" accessibilityLabel="Back" style={s.back}>
            <Text style={s.backText}>Back</Text>
          </Pressable>
        ) : (
          <View style={s.back} />
        )}
        <View style={s.progress} accessible accessibilityLabel={`Step ${step + 1} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <View key={i} style={[s.pip, i % 2 ? { transform: [{ rotate: "3deg" }] } : null, i <= step && s.pipDone]} />
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

      <View style={s.dock}>
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

function Scrawl({ text }: { text: string }) {
  return <Text style={s.scrawl}>{text}</Text>;
}

function H2({ children, hero }: { children: ReactNode; hero?: boolean }) {
  return (
    <Text style={[s.h2, hero && s.hero]} accessibilityRole="header">
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
  ["Tu", "Tunde", "gets signal"],
  ["Za", "Zanele", "is paid"],
] as const;

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
  const shown = Math.min(at, 3) + 1;
  return (
    <View>
      <View style={s.wordmark}>
        <View style={s.glyph} />
        <Text style={s.wordText}>Carrier</Text>
      </View>
      <H2 hero>
        Money that travels <Text style={s.underline}>{"by\u00a0hand"}</Text>
      </H2>
      <Text style={s.p}>
        Pay someone when nobody has signal. The payment passes from phone to phone, and the first phone to get back online settles it.
        Everyone who carried it gets a share.
      </Text>
      <View
        accessible
        accessibilityLabel="Ama signs a payment of 12.00 for Zanele with no signal. Chidi and then Mei carry it, and each handoff adds a stamp signed by both phones. When Tunde finds signal the chain settles on Solana: Zanele is paid, and Chidi, Mei and Tunde each receive a share."
        style={{ marginTop: 18 }}
      >
        <View style={s.demoSlip}>
          <View style={{ paddingHorizontal: 18, paddingTop: 10, height: 70 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={s.demoFor}>
                For <Text style={{ fontWeight: "800", color: C.slipInk }}>Zanele</Text>
              </Text>
              <Text style={s.demoFrom}>from Ama</Text>
            </View>
            <Text style={s.demoAmt}>
              12.00<Text style={s.demoUnit}> USDC</Text>
            </Text>
          </View>
          <View style={s.demoPerf} />
          <View style={s.demoStamps}>
            {["Ama", "Chidi", "Mei", "Tunde"].slice(0, shown).map((n, i) => (
              <View key={n} style={i ? { marginLeft: -7 } : null}>
                <Stamp top={n.toUpperCase()} mid={`1${i}:${i * 2}4`} bottom={i ? `HOP ${i}` : "SENT"} seed={n} size={56} />
              </View>
            ))}
          </View>
          {at >= 3 ? (
            <View style={{ position: "absolute", right: 10, bottom: 18 }}>
              <SettledStamp size={15} animate={!reduced} key={at === 3 ? "slam" : "still"} />
            </View>
          ) : null}
        </View>
        <View style={s.walk}>
          <View style={s.walkLine} />
          {WALK.map(([ab, name, role], i) => (
            <View key={name} style={s.walker}>
              <Avatar text={ab} met={i < at || (at >= 4 && i === 4)} size={36} />
              <Text style={s.walkName}>{name}</Text>
              <Text style={s.walkRole}>{role}</Text>
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

function Radio({ perm }: { perm: Perm }) {
  const state = perm === "granted" ? "ALLOWED" : perm === "denied" ? "OFF" : "NOT ASKED";
  const colour = perm === "granted" ? C.green : perm === "denied" ? C.red : C.ink3;
  return (
    <View>
      <Scrawl text="first, the radio" />
      <H2>Let Carrier find phones near you</H2>
      <Text style={s.p}>Handoffs travel over local radio, about as far as you could pass something across a room.</Text>
      <View style={s.perm}>
        {(
          [
            ["Nearby devices", "Bluetooth and Wi-Fi Direct, to see phones within about 10 metres and hand payments to them.", null],
            ["Location", "Android requires it before any app may scan for other phones.", "we never look at where you are"],
          ] as const
        ).map(([b, why, aside]) => (
          <View key={b} style={s.permRow} accessible accessibilityLabel={`${b}: ${why} ${aside ? `Carrier never reads your location.` : ""} ${state.toLowerCase()}.`}>
            <View style={{ flex: 1 }}>
              <Text style={s.permB}>{b}</Text>
              <Text style={s.permWhy}>{why}</Text>
              {aside ? <Text style={s.permAside}>{aside}</Text> : null}
            </View>
            <Mark text={state} colour={colour} rotate={perm === "granted" ? -5 : perm === "denied" ? 4 : 0} />
          </View>
        ))}
      </View>
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
      <Scrawl text="then, your key" />
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
      <Scrawl text="last thing, promise" />
      <H2>Sign for it</H2>
      <Receipt title="CARRIER · TERMS" subtitle="DEVNET BUILD · 23 SEP 2026">
        {items.map(([a, b, c2], i) => (
          <View key={i} style={s.term}>
            <Text style={s.termN}>{String(i + 1).padStart(2, "0")}</Text>
            <Text style={s.termText}>
              {a}
              <Text style={{ fontWeight: "800", color: C.receiptInk }}>{b}</Text>
              {c2}
            </Text>
          </View>
        ))}
        <Rule />
        <View style={{ flexDirection: "row", gap: 18 }}>
          <LinkButton label="Terms of use" onPress={() => onLegal("terms")} color={C.receiptInk} />
          <LinkButton label="Privacy policy" onPress={() => onLegal("privacy")} color={C.receiptInk} />
        </View>
        <View style={s.pad}>
          <Text style={s.x}>×</Text>
          {signed ? <Text style={s.sig}>signed on this phone</Text> : null}
        </View>
        <Text style={s.cap}>SIGNED ON THIS PHONE</Text>
        <Pressable
          onPress={() => setSigned(!signed)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: signed }}
          accessibilityLabel="Sign to agree"
          accessibilityHint={signed ? "Signed. Tap to undo." : "Agrees to the four points above"}
          style={[s.signBtn, signed && s.signBtnOn]}
        >
          <Text style={[s.signText, signed && { color: C.receipt }]}>{signed ? "Signed. Tap to undo" : "Sign to agree"}</Text>
        </Pressable>
      </Receipt>
    </View>
  );
}

function FirstHandoff({ c }: { c: Carrier }) {
  const pocket = c.pocket;
  return (
    <View>
      <Scrawl text="now, for real" />
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
        <View style={{ borderTopWidth: 1.5, borderColor: C.ink }}>
          {c.peers.map((key) => {
            const k = key.toBase58();
            const holding = c.holdings[k] ?? 0;
            return (
              <View key={k}>
                <PersonRow
                  person={{ key, met: pocket.hasMet(key), holding, forThem: false }}
                  selected={false}
                  target={false}
                  hint={holding ? "Takes their payment" : "They have nothing to hand you yet"}
                  onPress={() => (holding ? c.take(key) : c.say(`${shorten(key)} is not holding anything yet. Ask them to hand you something.`))}
                />
              </View>
            );
          })}
        </View>
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
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 6, minHeight: 52 },
  back: { minWidth: 64, minHeight: 48, justifyContent: "center", paddingHorizontal: 8 },
  backText: { fontFamily: FONT.face, fontSize: 15, fontWeight: "700", color: C.ink2 },
  progress: { flexDirection: "row", gap: 7 },
  pip: { width: 24, height: 12, borderRadius: 2, borderWidth: 1.5, borderStyle: "dashed", borderColor: C.ink3, transform: [{ rotate: "-4deg" }] },
  pipDone: { backgroundColor: C.slip, borderStyle: "solid", borderColor: C.slipDeep },
  count: { minWidth: 64, textAlign: "right", paddingRight: 8, fontFamily: FONT.mono, fontSize: 12, color: C.ink2 },
  body: { paddingHorizontal: S.xl, paddingTop: 18, paddingBottom: 12 },
  dock: { paddingHorizontal: S.gutter, paddingTop: 10, paddingBottom: 16, gap: 8 },
  foot: { fontFamily: FONT.face, fontSize: 13, color: C.ink3, textAlign: "center" },
  scrawl: { fontFamily: FONT.hand, fontWeight: "700", fontSize: 17, color: C.red, marginBottom: 4, transform: [{ rotate: "-2deg" }] },
  h2: { fontFamily: FONT.face, fontSize: 31, fontWeight: "800", letterSpacing: -1.2, lineHeight: 33, color: C.ink, marginBottom: 10 },
  hero: { fontSize: 44, lineHeight: 44, letterSpacing: -2, marginBottom: 14 },
  underline: { textDecorationLine: "underline", textDecorationColor: C.red },
  p: { fontFamily: FONT.face, fontSize: 16, lineHeight: 23, color: C.ink2, marginBottom: 18 },
  wordmark: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 20, marginTop: 4 },
  glyph: { width: 30, height: 19, borderRadius: 2, backgroundColor: C.slip, transform: [{ rotate: "-6deg" }] },
  wordText: { fontFamily: FONT.face, fontSize: 17, fontWeight: "800", color: C.ink },
  demoSlip: { backgroundColor: C.slip, borderRadius: 4, transform: [{ rotate: "-2deg" }], maxWidth: 330, alignSelf: "center", width: "100%" },
  demoFor: { fontFamily: FONT.face, fontSize: 14, color: C.slipInk2 },
  demoFrom: { fontFamily: FONT.mono, fontSize: 12, color: C.slipInk2 },
  demoAmt: { fontFamily: FONT.mono, fontSize: 32, fontWeight: "700", letterSpacing: -1.5, color: C.slipInk },
  demoUnit: { fontSize: 14, fontWeight: "600", color: C.slipInk2, letterSpacing: 0 },
  demoPerf: { marginHorizontal: 16, borderTopWidth: 2, borderStyle: "dashed", borderColor: C.slipInk2 },
  demoStamps: { flexDirection: "row", paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, minHeight: 88, alignItems: "center" },
  walk: { flexDirection: "row", justifyContent: "space-between", marginTop: 22 },
  walkLine: { position: "absolute", left: "10%", right: "10%", top: 17, borderTopWidth: 2, borderStyle: "dashed", borderColor: C.ruleStrong },
  walker: { alignItems: "center", gap: 3, flex: 1 },
  walkName: { fontFamily: FONT.face, fontSize: 13, fontWeight: "700", color: C.ink2 },
  walkRole: { fontFamily: FONT.face, fontSize: 12, color: C.ink3 },
  caption: { fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 14, minHeight: 44 },
  captionN: { fontFamily: FONT.mono, fontSize: 12, color: C.ink3 },
  perm: { borderTopWidth: 1.5, borderColor: C.ink, marginTop: 4 },
  permRow: { flexDirection: "row", gap: 14, paddingVertical: 14, borderBottomWidth: 1, borderColor: C.rule, alignItems: "flex-start" },
  permB: { fontFamily: FONT.face, fontSize: 16, fontWeight: "800", color: C.ink },
  permWhy: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 2 },
  permAside: { fontFamily: FONT.hand, fontSize: 16, fontWeight: "700", color: C.red, marginTop: 6, transform: [{ rotate: "-1.5deg" }] },
  after: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 14 },
  term: { flexDirection: "row", gap: 8, paddingVertical: 6 },
  termN: { fontFamily: FONT.mono, fontSize: 12, fontWeight: "700", color: C.receiptInk, paddingTop: 2, width: 22 },
  termText: { flex: 1, fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.receiptInk2 },
  pad: { height: 56, borderBottomWidth: 1.5, borderColor: C.receiptInk, justifyContent: "flex-end", marginTop: 10 },
  x: { position: "absolute", left: 0, bottom: 4, fontFamily: FONT.face, fontWeight: "700", color: C.receiptInk, fontSize: 16 },
  sig: { fontFamily: FONT.hand, fontSize: 24, color: C.signInk, marginLeft: 26, marginBottom: 4, transform: [{ rotate: "-3deg" }] },
  cap: { fontFamily: FONT.mono, fontSize: 11, color: C.receiptInk2, marginTop: 4 },
  signBtn: { alignSelf: "flex-start", minHeight: 48, justifyContent: "center", marginTop: 10, paddingHorizontal: 14, borderRadius: 6, borderWidth: 2, borderColor: C.receiptInk, backgroundColor: C.receipt },
  signBtnOn: { backgroundColor: C.receiptInk },
  signText: { fontFamily: FONT.face, fontSize: 15, fontWeight: "800", color: C.receiptInk },
  radioLine: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginBottom: 10 },
});

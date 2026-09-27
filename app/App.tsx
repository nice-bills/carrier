import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { useCarrier } from "./src/useCarrier";
import type { Services } from "./src/services/types";
import { C } from "./src/theme";
import { Button, MotionOverride, type } from "./src/ui/kit";
import { Moment, TabBar, Toast, type Tab } from "./src/ui/chrome";
import { Onboarding } from "./src/screens/Onboarding";
import { CarryScreen } from "./src/screens/Carry";
import { AroundScreen } from "./src/screens/Around";
import { YouScreen } from "./src/screens/You";
import { LegalSheet, PassSheet, PaySheet, PouchSheet, ReceiptSheet } from "./src/screens/Sheets";

/**
 * Carrier: onboarding, then three tabs (Carry, Around, You) and the sheets
 * that confirm anything that moves money.
 *
 * `services` is the device: `src/services/native.ts` on a phone, or the
 * in-memory fakes in `src/demo/` for a browser preview. `demo` opens the app
 * on a given screen or sheet so each one can be looked at directly.
 */

export interface DemoScript {
  tab?: Tab;
  onboardingStep?: number;
  sheet?: "pay" | "pass" | "receipt" | "pouch" | "terms" | "privacy";
  payStep?: "who" | "amount" | "confirm";
  payTo?: string;
  payAmount?: string;
  /** Pass/confirm: which slip (index) to which person (base58). */
  passTo?: string;
  /** Draw the slip lifted over this person, as mid-drag. */
  dragOver?: string;
  selected?: string;
  reducedMotion?: boolean;
  /** Called once the app is ready, to stage what the screen needs (a receipt, a moment). */
  stage?: (c: ReturnType<typeof useCarrier>) => void;
}

export default function App({ services, demo }: { services: Services; demo?: DemoScript }) {
  return (
    <MotionOverride.Provider value={demo?.reducedMotion ?? null}>
      <Root services={services} demo={demo} />
    </MotionOverride.Provider>
  );
}

function Root({ services, demo }: { services: Services; demo?: DemoScript }) {
  const c = useCarrier(services);
  const [tab, setTab] = useState<Tab>(demo?.tab ?? "carry");
  const [step, setStep] = useState(demo?.onboardingStep ?? 0);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string | null>(demo?.selected ?? null);
  const [passing, setPassing] = useState<{ bundle: Bundle; peer: PublicKey } | null>(null);
  const [paying, setPaying] = useState<{ to: PublicKey | null } | null>(null);
  const [pouchOpen, setPouchOpen] = useState(false);
  const [legal, setLegal] = useState<"terms" | "privacy" | null>(null);
  const [seen, setSeen] = useState({ around: 0, carry: 0 });
  const [staged, setStaged] = useState(false);

  const ready = c.boot.state === "ready";

  // Demo: once the pocket is up and the fake radio has found people, open the
  // requested sheet. Never runs on a phone (no `demo` there).
  useEffect(() => {
    if (!demo || staged || !c.pocket) return;
    if (demo.sheet === "pass" && (!c.slips.length || !c.peers.length)) return;
    setStaged(true);
    demo.stage?.(c);
    if (demo.sheet === "pass") {
      const peer = c.peers.find((p) => p.toBase58() === demo.passTo) ?? c.peers[0]!;
      setSelected(peer.toBase58());
      setPassing({ bundle: c.slips[0]!, peer });
    }
    if (demo.sheet === "pay") setPaying({ to: demo.payTo ? new PublicKey(demo.payTo) : null });
    if (demo.sheet === "pouch") setPouchOpen(true);
    if (demo.sheet === "terms" || demo.sheet === "privacy") setLegal(demo.sheet);
  }, [demo, staged, c]);

  const goTab = useCallback(
    (t: Tab) => {
      setTab(t);
      if (c.pocket) setSeen((s) => ({ ...s, [t]: c.pocket!.feed.length }));
    },
    [c.pocket],
  );

  if (c.boot.state === "loading") {
    return (
      <SafeAreaView style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={C.ink} accessibilityLabel="Opening your pocket" />
        <Text style={type.body}>Opening your pocket</Text>
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  if (c.boot.state === "failed") {
    return (
      <SafeAreaView style={[styles.screen, styles.centre]}>
        <Text style={[type.title, { textAlign: "center" }]} accessibilityRole="header">
          Carrier could not start
        </Text>
        <Text style={[type.body, { textAlign: "center" }]}>{c.boot.message}</Text>
        <Button label="Try again" hint="Reads the saved key and pocket again" onPress={c.load} />
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  const legalSheet = <LegalSheet which={legal} onClose={() => setLegal(null)} />;

  if (c.boot.state === "onboarding") {
    return (
      <SafeAreaView style={styles.screen}>
        <Onboarding c={c} step={step} setStep={setStep} onLegal={setLegal} />
        {c.toast ? <Toast key={c.toast.id} text={c.toast.text} onDone={c.dismissToast} /> : null}
        {legalSheet}
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  const feedLen = c.pocket?.feed.length ?? 0;
  const badges = {
    around: tab !== "around" && feedLen > seen.around,
    carry: tab !== "carry" && c.slips.length > 0,
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={{ flex: 1 }}>
        {tab === "carry" ? (
          <CarryScreen
            c={c}
            cursor={cursor}
            setCursor={setCursor}
            selected={selected}
            setSelected={setSelected}
            onPass={(bundle, peer) => setPassing({ bundle, peer })}
            onPay={(to) => setPaying({ to: to ?? null })}
            onSeeAll={() => goTab("around")}
            forceTarget={demo?.dragOver ?? null}
          />
        ) : tab === "around" ? (
          <AroundScreen
            c={c}
            onPick={(k) => {
              setSelected(k);
              goTab("carry");
            }}
          />
        ) : (
          <YouScreen c={c} onSetup={() => setPouchOpen(true)} onLegal={setLegal} />
        )}
        {c.moment ? <Moment key={c.moment.id} text={c.moment.text} onDone={c.dismissMoment} /> : null}
        {c.toast ? <Toast key={c.toast.id} text={c.toast.text} onDone={c.dismissToast} /> : null}
      </View>
      <TabBar tab={tab} onTab={goTab} badges={badges} />

      <PassSheet c={c} bundle={passing?.bundle ?? null} peer={passing?.peer ?? null} onClose={() => setPassing(null)} />
      {ready ? (
        <PaySheet
          c={c}
          visible={!!paying}
          initialTo={paying?.to ?? null}
          initialStep={demo?.sheet === "pay" ? demo.payStep : undefined}
          initialAmount={demo?.sheet === "pay" ? demo.payAmount : undefined}
          onClose={() => setPaying(null)}
          onSetup={() => {
            setTab("you");
            setPouchOpen(true);
          }}
        />
      ) : null}
      <ReceiptSheet c={c} receipt={c.receipt} onClose={c.closeReceipt} />
      <PouchSheet c={c} visible={pouchOpen} onClose={() => setPouchOpen(false)} />
      {legalSheet}
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.paper },
  centre: { alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 32 },
});

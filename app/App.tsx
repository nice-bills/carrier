import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { isPlayServicesAvailable } from "expo-nearby-connections";
import type { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { DeviceWallet, WalletError, shorten } from "./src/wallet";
import { NearbyTransport } from "./src/transport/nearby";
import { Pocket } from "./src/pocket";
import { noteKey } from "./src/chain";
import { formatAmount, totals } from "./src/amounts";
import { ensureRadioPermissions } from "./src/permissions";
import { rankFor } from "./src/rank";
import { C, R } from "./src/theme";

/**
 * One screen, because there is only one thing to look at: what this phone is
 * carrying and who it can hand it to. Handoffs happen on their own when two
 * phones meet; the only action is turning the radio on or off, and that is a
 * button.
 */

type Radio =
  | { state: "off" }
  | { state: "starting" }
  | { state: "on" }
  | { state: "needs-permission"; blocked: boolean }
  | { state: "unavailable"; reason: string };

type Boot =
  | { state: "loading" }
  | { state: "ready"; wallet: DeviceWallet; pocket: Pocket; restored: number; dropped: number }
  | { state: "failed"; message: string };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const [radio, setRadio] = useState<Radio>({ state: "off" });
  const [peers, setPeers] = useState<PublicKey[]>([]);
  const [carrying, setCarrying] = useState<Bundle[]>([]);
  const [met, setMet] = useState(0);
  const transport = useRef<NearbyTransport | null>(null);
  const exchanging = useRef(new Set<string>());
  // Bumped on every stop, so a start still awaiting permissions can tell it
  // was cancelled and must not bring the radio up afterwards.
  const radioGen = useRef(0);

  const load = useCallback(async () => {
    setBoot({ state: "loading" });
    try {
      const wallet = await DeviceWallet.load();
      const { pocket, report } = await Pocket.open(wallet);
      setBoot({ state: "ready", wallet, pocket, ...report });
    } catch (e) {
      const message =
        e instanceof WalletError && e.code === "corrupt-key"
          ? "This phone's saved key is damaged. Carrier will not replace it on its own, because payments signed with it would be lost."
          : e instanceof WalletError
            ? "The phone's secure storage is not answering. Nothing was changed."
            : `Carrier could not start: ${(e as Error).message}`;
      setBoot({ state: "failed", message });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pocket = boot.state === "ready" ? boot.pocket : null;
  const wallet = boot.state === "ready" ? boot.wallet : null;

  const refresh = useCallback(async () => {
    if (!pocket) return;
    await pocket.prune().catch(() => {});
    setCarrying(pocket.list());
    setMet(pocket.peopleMet);
    const t = transport.current;
    setPeers(t ? await t.peers() : []);
  }, [pocket]);

  const stopRadio = useCallback(async () => {
    radioGen.current += 1;
    const t = transport.current;
    transport.current = null;
    setRadio({ state: "off" });
    setPeers([]);
    await t?.stop().catch(() => {});
  }, []);

  const startRadio = useCallback(async () => {
    if (!pocket || !wallet || transport.current) return;
    const gen = radioGen.current;
    const cancelled = () => gen !== radioGen.current;
    setRadio({ state: "starting" });
    try {
      const perms = await ensureRadioPermissions();
      if (cancelled()) return;
      if (!perms.granted) {
        setRadio({ state: "needs-permission", blocked: perms.blocked });
        return;
      }
      const playServices = await isPlayServicesAvailable();
      if (cancelled()) return;
      if (!playServices) {
        setRadio({ state: "unavailable", reason: "This phone has no Google Play services, which the radio needs." });
        return;
      }
      const t = new NearbyTransport(wallet, pocket, {
        peerReady: (peer) => {
          const k = peer.toBase58();
          if (exchanging.current.has(k)) return;
          exchanging.current.add(k);
          pocket
            .exchange(t, peer)
            .catch(() => {})
            .finally(() => {
              exchanging.current.delete(k);
              refresh();
            });
        },
        peerGone: () => {
          refresh();
        },
        error: (where, e) => {
          if (__DEV__) console.warn(`[radio] ${where}:`, e);
        },
      });
      transport.current = t;
      await t.advertise();
      if (cancelled()) {
        // Stopped while advertising came up: this instance is already
        // detached, so shut it down rather than leave the radio running.
        await t.stop().catch(() => {});
        return;
      }
      setRadio({ state: "on" });
    } catch (e) {
      if (cancelled()) return;
      transport.current = null;
      setRadio({ state: "unavailable", reason: `The radio would not start: ${(e as Error).message}` });
    }
  }, [pocket, wallet, refresh]);

  // Start the radio once the pocket is open; stop it when the app unmounts.
  useEffect(() => {
    if (!pocket) return;
    pocket.subscribe(() => {
      setCarrying(pocket.list());
      setMet(pocket.peopleMet);
    });
    refresh();
    startRadio();
    return () => {
      stopRadio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pocket]);

  // Poll rather than subscribe to every radio event: peers come and go
  // constantly and a render per event would thrash. Once a second is faster
  // than anyone walks.
  useEffect(() => {
    if (!pocket) return;
    const id = setInterval(() => {
      refresh().catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [pocket, refresh]);

  // Totals are per token, never summed across tokens, and split by whose
  // money it is: carried for others, or paid to this phone.
  const { sums, paidToMe } = useMemo(() => {
    const mine = (b: Bundle) => pocket?.node.isForMe(noteKey(b)) ?? false;
    return {
      sums: totals(carrying.filter((b) => b.hops.length > 0 && !mine(b))),
      paidToMe: totals(carrying.filter(mine)),
    };
  }, [carrying, pocket]);
  const rank = rankFor(met);

  if (boot.state === "loading") {
    return (
      <SafeAreaView style={[styles.screen, styles.centre]}>
        <ActivityIndicator color={C.ink} accessibilityLabel="Opening your pocket" />
        <Text style={styles.muted}>Opening your pocket</Text>
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  if (boot.state === "failed") {
    return (
      <SafeAreaView style={[styles.screen, styles.centre]}>
        <Text style={styles.title} accessibilityRole="header">
          Carrier could not start
        </Text>
        <Text style={styles.body}>{boot.message}</Text>
        <Button label="Try again" hint="Reads the saved key and pocket again" onPress={load} />
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  const peopleInRange = peers.length
    ? `${peers.length} ${peers.length === 1 ? "person" : "people"} in range`
    : "Nobody in range";

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.brand} accessibilityRole="header">
          Carrier
        </Text>
        <View
          style={styles.tag}
          accessible
          accessibilityLabel={`Your device key, ${boot.wallet.label}`}
        >
          <Text style={styles.tagText}>{boot.wallet.label}</Text>
        </View>
      </View>

      <View
        style={styles.summary}
        accessible
        accessibilityLabel={
          `${carrying.length} ${carrying.length === 1 ? "payment" : "payments"} in your pocket. ` +
          [...sums.known.map((s) => `${s.text} carried for other people`), ...paidToMe.known.map((s) => `${s.text} paid to you`)].join(", ")
        }
      >
        <Text style={styles.bigNumber}>{carrying.length}</Text>
        <Text style={styles.summaryLabel}>
          {carrying.length === 1 ? "payment in your pocket" : "payments in your pocket"}
        </Text>
        {sums.known.map((s) => (
          <Text key={s.text} style={styles.muted}>
            {s.text} carried for other people
          </Text>
        ))}
        {paidToMe.known.map((s) => (
          <Text key={`me-${s.text}`} style={styles.muted}>
            {s.text} paid to you
          </Text>
        ))}
        {sums.unknown + paidToMe.unknown > 0 ? (
          <Text style={styles.muted}>
            {sums.unknown + paidToMe.unknown} in tokens this phone does not recognise
          </Text>
        ) : null}
        {boot.dropped > 0 ? (
          <Text style={styles.muted}>
            {boot.dropped} saved {boot.dropped === 1 ? "payment" : "payments"} expired or no longer
            checked out, and {boot.dropped === 1 ? "was" : "were"} removed.
          </Text>
        ) : null}
      </View>

      <View
        style={styles.rank}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Rank ${rank.current.name}. ${met} ${met === 1 ? "person" : "people"} met. ${rank.caption}`}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(rank.progress * 100) }}
      >
        <View style={styles.rankRow}>
          <Text style={[styles.rankName, { color: rank.current.colour }]}>{rank.current.name}</Text>
          <Text style={styles.muted}>{rank.caption}</Text>
        </View>
        <View style={styles.bar}>
          <View
            style={[
              styles.barFill,
              { width: `${Math.round(rank.progress * 100)}%`, backgroundColor: rank.current.colour },
            ]}
          />
        </View>
      </View>

      <View style={styles.radio}>
        <View
          style={styles.radioStatus}
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={radioLabel(radio, peopleInRange)}
        >
          <View style={[styles.dot, radio.state === "on" && peers.length ? styles.dotLive : styles.dotIdle]} />
          <Text style={styles.radioText}>{radioLabel(radio, peopleInRange)}</Text>
        </View>
        {radio.state === "on" ? (
          <Button label="Stop looking" hint="Turns the radio off. Nobody nearby can find you." onPress={stopRadio} />
        ) : radio.state === "starting" ? null : radio.state === "needs-permission" && radio.blocked ? (
          <Button label="Open settings" hint="Opens Android settings to allow Nearby devices" onPress={() => Linking.openSettings()} />
        ) : (
          <Button label="Look for people" hint="Turns the radio on so nearby phones can hand you payments" onPress={startRadio} />
        )}
      </View>

      <FlatList
        data={carrying}
        keyExtractor={noteKey}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nothing yet. When someone near you hands off a payment, it appears here and travels
            with you.
          </Text>
        }
        renderItem={({ item }) => {
          const amount = formatAmount(item);
          const hops = item.hops.length;
          const forMe = pocket?.node.isForMe(noteKey(item)) ?? false;
          const via = forMe
            ? "paid to you"
            : hops === 0
              ? "signed on this phone"
              : `from ${shorten(item.hops[hops - 1]!.prev)}`;
          return (
            <View
              style={styles.slip}
              accessible
              accessibilityLabel={`Payment of ${amount.spoken} to ${shorten(item.note.to)}, ${hops} ${hops === 1 ? "handoff" : "handoffs"}, ${via}`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.amount}>{amount.text}</Text>
                <Text style={styles.slipMuted}>to {shorten(item.note.to)}</Text>
              </View>
              <View style={styles.rowMeta}>
                <Text style={styles.stamp}>
                  {hops} {hops === 1 ? "handoff" : "handoffs"}
                </Text>
                <Text style={styles.slipMuted}>{via}</Text>
              </View>
            </View>
          );
        }}
      />

      <Text style={styles.footer}>
        No internet needed to pass these on. This app does not settle them yet; that needs a
        computer with signal.
      </Text>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function radioLabel(radio: Radio, peopleInRange: string): string {
  switch (radio.state) {
    case "on":
      return peopleInRange;
    case "starting":
      return "Turning the radio on";
    case "off":
      return "Radio off. Nobody nearby can find you.";
    case "needs-permission":
      return radio.blocked
        ? "Carrier needs Nearby devices and Location allowed in settings to find people. It never reads your location."
        : "Carrier needs Nearby devices and Location to find people. It never reads your location.";
    case "unavailable":
      return radio.reason;
  }
}

function Button({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.paper, paddingHorizontal: 20 },
  centre: { alignItems: "center", justifyContent: "center", gap: 16, paddingHorizontal: 32 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 12,
  },
  brand: { color: C.ink, fontSize: 18, fontWeight: "800" },
  tag: { backgroundColor: C.kraft, borderRadius: R.mark, paddingHorizontal: 8, paddingVertical: 4 },
  tagText: { color: C.kraftInk, fontSize: 13, fontFamily: "monospace" },
  title: { color: C.ink, fontSize: 20, fontWeight: "700", textAlign: "center" },
  body: { color: C.ink2, fontSize: 16, lineHeight: 23, textAlign: "center" },
  muted: { color: C.ink3, fontSize: 14 },
  summary: { paddingTop: 28, paddingBottom: 20, gap: 2 },
  bigNumber: { color: C.ink, fontSize: 64, fontWeight: "800", letterSpacing: -2 },
  summaryLabel: { color: C.ink, fontSize: 17, marginTop: -4, marginBottom: 6 },
  rank: { paddingBottom: 16, gap: 6 },
  rankRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  rankName: { fontSize: 16, fontWeight: "700" },
  bar: { height: 6, borderRadius: R.mark, backgroundColor: C.paper2, borderWidth: 1, borderColor: C.ruleStrong, overflow: "hidden" },
  barFill: { height: "100%" },
  radio: {
    gap: 12,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.rule,
  },
  radioStatus: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: C.ink },
  dotLive: { backgroundColor: C.green },
  dotIdle: { backgroundColor: C.paper },
  radioText: { color: C.ink2, fontSize: 15, flexShrink: 1 },
  button: {
    minHeight: 48,
    alignSelf: "flex-start",
    justifyContent: "center",
    paddingHorizontal: 18,
    borderRadius: R.box,
    backgroundColor: C.ink,
  },
  buttonPressed: { backgroundColor: C.ink2 },
  buttonText: { color: C.paper, fontSize: 16, fontWeight: "700" },
  slip: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 12,
    padding: 14,
    borderRadius: R.box,
    backgroundColor: C.slip,
    borderWidth: 1,
    borderColor: C.slipDeep,
  },
  rowMain: { gap: 2, flexShrink: 1 },
  rowMeta: { alignItems: "flex-end", gap: 2 },
  amount: { color: C.slipInk, fontSize: 19, fontWeight: "700", fontFamily: "monospace" },
  slipMuted: { color: C.slipInk2, fontSize: 14 },
  stamp: {
    color: C.stampInk,
    backgroundColor: C.receipt,
    borderColor: C.stampInk,
    borderWidth: 1,
    borderRadius: R.mark,
    paddingHorizontal: 6,
    fontSize: 14,
    fontWeight: "700",
  },
  empty: { color: C.ink3, fontSize: 15, lineHeight: 22, paddingTop: 24 },
  footer: { color: C.ink3, fontSize: 13, textAlign: "center", paddingVertical: 16 },
});

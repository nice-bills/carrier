import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { PublicKey } from "@solana/web3.js";
import { CarrierNode, type Bundle } from "@carrier/mesh";
import { DeviceWallet, shorten } from "./src/wallet";
import { NearbyTransport } from "./src/transport/nearby";

/**
 * One screen, because there is only one thing to look at: what this phone is
 * carrying and who it can hand it to. Everything else — balances, history,
 * settings — is the dashboard this deliberately is not.
 */

const NOW = () => BigInt(Math.floor(Date.now() / 1000));

export default function App() {
  const [wallet, setWallet] = useState<DeviceWallet | null>(null);
  const [peers, setPeers] = useState<PublicKey[]>([]);
  const [carrying, setCarrying] = useState<Bundle[]>([]);
  const [status, setStatus] = useState("starting");
  const node = useRef<CarrierNode | null>(null);
  const transport = useRef<NearbyTransport | null>(null);

  useEffect(() => {
    let live = true;

    (async () => {
      const w = await DeviceWallet.load();
      if (!live) return;
      setWallet(w);

      const n = new CarrierNode(w);
      node.current = n;

      const t = new NearbyTransport(w.publicKey);
      t.bind(
        () => n.digests(),
        (digest, peer) => n.prepareHandoff(digest, new PublicKey(peer), NOW()),
      );
      transport.current = t;

      await t.advertise();
      setStatus("listening");
    })().catch((e) => setStatus(`failed: ${e.message}`));

    return () => {
      live = false;
      transport.current?.stop().catch(() => {});
    };
  }, []);

  // Poll rather than subscribe: peers come and go constantly and a render per
  // radio event would thrash. Once a second is faster than anyone walks.
  useEffect(() => {
    const id = setInterval(async () => {
      const t = transport.current;
      const n = node.current;
      if (!t || !n) return;
      setPeers(await t.peers());
      setCarrying(n.digests().map((d) => n.bundle(d)!).filter(Boolean));
      n.prune(NOW());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const total = useMemo(
    () => carrying.reduce((sum, b) => sum + b.note.amount, 0n),
    [carrying],
  );

  const onlineHint = peers.length
    ? `${peers.length} ${peers.length === 1 ? "person" : "people"} in range`
    : "nobody in range";

  if (!wallet) {
    return (
      <SafeAreaView style={[styles.screen, styles.centre]}>
        <ActivityIndicator color="#E4913C" />
        <Text style={styles.muted}>{status}</Text>
        <StatusBar style="light" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.brand}>CARRIER</Text>
        <Text style={styles.muted}>{wallet.label}</Text>
      </View>

      <View style={styles.summary}>
        <Text style={styles.bigNumber}>{carrying.length}</Text>
        <Text style={styles.summaryLabel}>
          {carrying.length === 1 ? "payment in your pocket" : "payments in your pocket"}
        </Text>
        {total > 0n ? (
          <Text style={styles.muted}>
            {(Number(total) / 1e6).toFixed(2)} carried for other people
          </Text>
        ) : null}
      </View>

      <View style={styles.radio}>
        <View style={[styles.dot, peers.length ? styles.dotLive : styles.dotIdle]} />
        <Text style={styles.radioText}>{onlineHint}</Text>
      </View>

      <FlatList
        data={carrying}
        keyExtractor={(b) => b.hops.map((h) => h.seq).join("-") + b.note.slotIndex}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Nothing yet. When someone near you hands off a payment, it appears
            here and travels with you.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.amount}>
                {(Number(item.note.amount) / 1e6).toFixed(2)}
              </Text>
              <Text style={styles.muted}>to {shorten(item.note.to)}</Text>
            </View>
            <View style={styles.rowMeta}>
              <Text style={styles.hops}>
                {item.hops.length} {item.hops.length === 1 ? "hop" : "hops"}
              </Text>
              <Text style={styles.muted}>
                {item.hops.length === 0 ? "yours" : `via ${shorten(item.hops[0]!.relayer)}`}
              </Text>
            </View>
          </View>
        )}
      />

      <Text style={styles.footer}>
        No internet needed. These settle when any carrier finds signal.
      </Text>
      <StatusBar style="light" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0E1316", paddingHorizontal: 20 },
  centre: { alignItems: "center", justifyContent: "center", gap: 12 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingTop: 12,
  },
  brand: { color: "#E6EDEA", fontSize: 15, fontWeight: "800", letterSpacing: 3 },
  muted: { color: "#8DA09A", fontSize: 13 },
  summary: { paddingVertical: 32 },
  bigNumber: { color: "#E4913C", fontSize: 64, fontWeight: "800", letterSpacing: -2 },
  summaryLabel: { color: "#E6EDEA", fontSize: 17, marginTop: -4, marginBottom: 6 },
  radio: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: "#1E2A2F",
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotLive: { backgroundColor: "#3FBFA0" },
  dotIdle: { backgroundColor: "#5F736D" },
  radioText: { color: "#8DA09A", fontSize: 13 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#1E2A2F",
  },
  rowMain: { gap: 2 },
  rowMeta: { alignItems: "flex-end", gap: 2 },
  amount: { color: "#E6EDEA", fontSize: 19, fontWeight: "600" },
  hops: { color: "#3FBFA0", fontSize: 13, fontWeight: "600" },
  empty: { color: "#5F736D", fontSize: 14, lineHeight: 21, paddingTop: 28 },
  footer: { color: "#5F736D", fontSize: 12, textAlign: "center", paddingVertical: 16 },
});

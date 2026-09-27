import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { PROGRAM_ID, formatUnits } from "../amounts";
import { CLUSTER, MINT_DECIMALS, MINT_SYMBOL } from "../config";
import { ago, dayTime } from "../format";
import { epochClosesAt, outstanding } from "../ledger";
import { nowSeconds } from "../pocket";
import { RANKS, rankFor } from "../rank";
import { C, R, S, SHADOW } from "../theme";
import { FONT } from "../ui/fonts";
import { Button, Card, CountUp, Head, KeyTag, Mark, Receipt, Row, ScreenHead, type, useReducedMotion } from "../ui/kit";
import type { Carrier } from "../useCarrier";

export const money = (units: bigint | string) => `${formatUnits(BigInt(units), MINT_DECIMALS)} ${MINT_SYMBOL}`;

/** Short names under the ladder, so five fit across a phone. */
const SHORT: Record<string, string> = { Superspreader: "Super" };

/**
 * You: rank, what this phone has done, its pouch, and its key. The pouch is
 * the only part that needs signal, and says so.
 */
export function YouScreen({ c, onSetup, onLegal }: { c: Carrier; onSetup: () => void; onLegal: (which: "terms" | "privacy") => void }) {
  const pocket = c.pocket!;
  const met = pocket.peopleMet;
  const rank = rankFor(met);
  const pouch = pocket.pouch;
  const now = nowSeconds();
  const owed = pouch ? outstanding(pocket.signed, pouch.epoch, now) : [];
  const owedSum = owed.reduce((n, s) => n + BigInt(s.amount), 0n);
  const left = rank.next ? rank.next.at - met : 0;
  const checked = pouch ? ago(Date.now() - pouch.fetchedAt) : "";

  return (
    <View style={{ flex: 1 }}>
      <ScreenHead title="You" sub="Your standing, pouch and key" />
      <ScrollView contentContainerStyle={s.body}>
        <Card style={s.rankCard}>
          <View accessible accessibilityLabel={`Rank ${rank.current.name}. ${met} ${met === 1 ? "person" : "people"} met. ${rank.caption}.`}>
            <Text style={type.label}>Your rank</Text>
            <Text style={s.rankNow}>{rank.current.name}</Text>
            <Text style={s.rankCap}>
              {rank.next ? (
                <>
                  <Text style={s.rankCapB}>
                    {left} more {left === 1 ? "person" : "people"}
                  </Text>{" "}
                  and you’re a {rank.next.name}
                </>
              ) : (
                "Nothing left to reach. You are the outbreak."
              )}
            </Text>
          </View>
          <Ladder met={met} />
          <Text style={s.rule}>Rank counts people, never handoffs. Passing one payment back and forth with a friend moves nothing.</Text>
        </Card>

        <Head title="So far" />
        <View style={s.grid}>
          <Stat label="People met" value={met} />
          <Stat label="Handed on" value={pocket.handedOn} />
          <Stat label="Carrying now" value={c.slips.length} />
          <Stat label="Signed, not settled" value={owed.length} />
        </View>

        <Head
          title="Your pouch"
          aside={c.online === "online" ? "Check now" : undefined}
          onAside={c.online === "online" ? () => c.refreshOnline() : undefined}
          asideHint="Looks up your pouch on Solana again"
        />
        {pouch ? (
          <Receipt>
            <View style={s.pouchTop} accessible accessibilityLabel={`You can sign ${money(c.spendable)} with no signal. Epoch ${pouch.epoch}, checked ${checked === "now" ? "just now" : `${checked} ago`}.`}>
              <BagIcon />
              <View style={{ flex: 1 }}>
                <Text style={s.pouchAmt}>{money(c.spendable)}</Text>
                <Text style={s.pouchSub}>Free to sign with no signal</Text>
              </View>
              <View>
                <Mark text={CLUSTER.charAt(0).toUpperCase() + CLUSTER.slice(1)} tone="green" />
              </View>
            </View>
            <Text style={s.pouchMeta}>
              Epoch {pouch.epoch} · checked {checked === "now" ? "just now" : `${checked} ago`}
            </Text>
            <Row label="Committed" value={money(pouch.committed)} />
            <Row label="Available" value={money(pouch.available)} />
            <Row label="Signed, unsettled" value={money(owedSum)} />
            <Row label="You can sign" value={money(c.spendable)} tone="earned" />
            <Row label="Bond" value={money(pouch.bond)} />
            <Row label="Period closes" value={dayTime(epochClosesAt(pouch))} last />
          </Receipt>
        ) : (
          <Card>
            <View style={s.pouchTop}>
              <BagIcon />
              <Text style={[s.pouchSub, { flex: 1, marginTop: 0, color: C.ink }]}>
                {c.online === "online"
                  ? "No pouch yet. Setting one up takes a minute and needs signal once."
                  : "No pouch yet. You can carry and receive payments without one; to pay someone, set one up the next time you have signal."}
              </Text>
            </View>
            <View style={{ marginTop: 14 }}>
              {c.online === "online" ? (
                <Button label="Set up pouch" hint="Explains what it needs, then sets aside your allowance on Solana devnet" onPress={onSetup} />
              ) : (
                <Button label="Set up pouch" hint="Needs signal" disabled onPress={onSetup} />
              )}
            </View>
          </Card>
        )}
        <Text style={s.p}>
          The pouch is money set aside on Solana so people carrying your payments can trust they will be paid. You can sign payments offline up
          to what is left in it.
        </Text>
        <Text style={s.status} accessibilityLiveRegion="polite">
          {c.online === "online"
            ? `Online (${CLUSTER}). ${c.balances ? `${(Number(c.balances.sol) / 1e9).toFixed(3)} SOL for fees.` : ""}`
            : c.online === "offline"
              ? "No signal. Showing what this phone last saw."
              : "Checking for signal."}
        </Text>

        <Head title="This phone" aside="Share key" onAside={() => c.services.share(pocket.me.toBase58())} asideHint="Opens the share sheet with your public key, so someone can pay you" />
        <KeyTag keyText={pocket.me.toBase58()} />

        <Head title="The small print" />
        <Card pad={false} style={s.rows}>
          {(
            [
              ["Terms of use", "terms"],
              ["Privacy policy", "privacy"],
            ] as const
          ).map(([label, which]) => (
            <Pressable key={which} onPress={() => onLegal(which)} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [s.rowBtn, pressed && s.rowPressed]}>
              <Text style={s.rowText}>{label}</Text>
              <Text style={s.rowMeta}>23 Sep 2026</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={c.services.openSettings}
            accessibilityRole="button"
            accessibilityLabel={`Nearby access, ${c.radio.state === "on" ? "on" : "off"}`}
            accessibilityHint="Opens Android settings for Carrier"
            style={({ pressed }) => [s.rowBtn, s.rowLast, pressed && s.rowPressed]}
          >
            <Text style={s.rowText}>Nearby access</Text>
            <View>
              <Mark text={c.radio.state === "on" ? "On" : "Off"} tone={c.radio.state === "on" ? "green" : "grey"} />
            </View>
          </Pressable>
        </Card>
        <Text style={s.fine}>
          Carrier 0.1 on Solana {CLUSTER}
          {"\n"}Program {PROGRAM_ID.toBase58()}
        </Text>
      </ScrollView>
    </View>
  );
}

/** Five segments, one per rank: passed in ink, the current one filling amber. */
function Ladder({ met }: { met: number }) {
  const reduced = useReducedMotion();
  const rank = rankFor(met);
  const idx = RANKS.indexOf(rank.current);
  const fill = useRef(new Animated.Value(reduced ? rank.progress : 0)).current;
  useEffect(() => {
    if (reduced) {
      fill.setValue(rank.progress);
      return;
    }
    Animated.timing(fill, { toValue: rank.progress, duration: 900, delay: 250, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [fill, rank.progress, reduced]);
  return (
    <View>
      <View style={s.bar} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {RANKS.map((r, i) => (
          <View key={r.name} style={[s.seg, i < idx && s.segDone]}>
            {i === idx ? (
              <Animated.View style={[s.segFill, { width: fill.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
            ) : null}
          </View>
        ))}
      </View>
      <View style={s.labels} accessibilityRole="list" accessibilityLabel="Ranks">
        {RANKS.map((r, i) => {
          const now_ = i === idx;
          const done = r.at <= met;
          return (
            <View
              key={r.name}
              style={s.lab}
              accessible
              accessibilityLabel={`${r.name}, at ${r.at} ${r.at === 1 ? "person" : "people"}${now_ ? ", your rank" : done ? ", reached" : ""}`}
            >
              <Text style={[s.labText, now_ && s.labNow]} numberOfLines={1}>
                {SHORT[r.name] ?? r.name}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={s.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <CountUp value={value} format={(n) => String(Math.round(n))} style={s.statV} />
      <Text style={s.statK}>{label}</Text>
    </View>
  );
}

/** A small shopping-bag mark in an amber square. Decorative. */
function BagIcon() {
  return (
    <View style={s.ico} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={s.handle} />
      <View style={s.bag} />
    </View>
  );
}

const s = StyleSheet.create({
  body: { paddingHorizontal: S.gutter, paddingBottom: 32 },
  rankCard: { padding: 22, marginTop: 8 },
  rankNow: { fontFamily: FONT.face, fontSize: 36, fontWeight: "800", letterSpacing: -1, color: C.ink, marginTop: 2 },
  rankCap: { fontFamily: FONT.face, fontSize: 15, fontWeight: "500", color: C.ink2, marginTop: 4, lineHeight: 21 },
  rankCapB: { fontWeight: "700", color: C.ink },
  bar: { flexDirection: "row", gap: 6, marginTop: 18 },
  seg: { flex: 1, height: 8, borderRadius: R.pill, backgroundColor: C.paper2, overflow: "hidden" },
  segDone: { backgroundColor: C.ink },
  segFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: R.pill, backgroundColor: C.slip },
  labels: { flexDirection: "row", gap: 6, marginTop: 8 },
  lab: { flex: 1, alignItems: "center" },
  labText: { fontFamily: FONT.face, fontSize: 12, fontWeight: "500", color: C.ink3 },
  labNow: { color: C.ink, fontWeight: "700" },
  rule: { fontFamily: FONT.face, fontSize: 13, lineHeight: 19, color: C.ink2, marginTop: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  stat: { flexBasis: "47%", flexGrow: 1, backgroundColor: C.card, borderRadius: R.card - 4, padding: 16, ...SHADOW },
  statV: { fontFamily: FONT.face, fontSize: 28, fontWeight: "800", letterSpacing: -0.5, color: C.ink },
  statK: { fontFamily: FONT.face, fontSize: 13, fontWeight: "500", color: C.ink2, marginTop: 2 },
  pouchTop: { flexDirection: "row", alignItems: "center", gap: 14, paddingTop: 12 },
  pouchAmt: { fontFamily: FONT.face, fontSize: 22, fontWeight: "800", letterSpacing: -0.4, color: C.ink },
  pouchSub: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 2 },
  pouchMeta: { fontFamily: FONT.face, fontSize: 12, color: C.ink3, marginTop: 10, marginBottom: 2 },
  ico: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center" },
  handle: { width: 9, height: 7, marginBottom: -1, borderTopLeftRadius: 5, borderTopRightRadius: 5, borderWidth: 2, borderBottomWidth: 0, borderColor: C.amberInk },
  bag: { width: 18, height: 14, borderRadius: 3, borderWidth: 2, borderColor: C.amberInk },
  p: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 12, paddingHorizontal: 4 },
  status: { fontFamily: FONT.mono, fontSize: 12, color: C.ink2, marginTop: 8, paddingHorizontal: 4 },
  rows: { overflow: "hidden" },
  rowBtn: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 56, paddingHorizontal: 18, borderBottomWidth: 1, borderColor: C.rule },
  rowLast: { borderBottomWidth: 0 },
  rowPressed: { backgroundColor: C.paper2 },
  rowText: { fontFamily: FONT.face, fontSize: 16, fontWeight: "600", color: C.ink },
  rowMeta: { fontFamily: FONT.face, fontSize: 13, fontWeight: "500", color: C.ink3 },
  fine: { fontFamily: FONT.mono, fontSize: 11, lineHeight: 18, color: C.ink3, marginTop: 18, paddingHorizontal: 4 },
});

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { PROGRAM_ID, formatUnits } from "../amounts";
import { CLUSTER, MINT_DECIMALS, MINT_SYMBOL } from "../config";
import { ago, dayTime } from "../format";
import { epochClosesAt, outstanding } from "../ledger";
import { nowSeconds } from "../pocket";
import { RANKS, rankFor } from "../rank";
import { C, S } from "../theme";
import { FONT } from "../ui/fonts";
import { Button, Head, KeyTag, Receipt, Row } from "../ui/kit";
import type { Carrier } from "../useCarrier";

export const money = (units: bigint | string) => `${formatUnits(BigInt(units), MINT_DECIMALS)} ${MINT_SYMBOL}`;

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

  return (
    <View style={{ flex: 1 }}>
      <View style={s.bar}>
        <Text style={s.h1} accessibilityRole="header">
          You
        </Text>
        <Text style={s.sub}>Standing, your pouch, and this phone’s key</Text>
      </View>
      <ScrollView contentContainerStyle={s.body}>
        <View accessible accessibilityLabel={`Rank ${rank.current.name}. ${met} ${met === 1 ? "person" : "people"} met. ${rank.caption}.`}>
          <Text style={s.rankNow}>{rank.current.name}</Text>
          <Text style={s.rankCap}>
            {rank.next ? `${rank.next.at - met} more ${rank.next.at - met === 1 ? "person" : "people"} and you are ${rank.next.name.toLowerCase()}` : "nothing left to reach. you are the outbreak."}
          </Text>
        </View>
        <View style={s.ladder} accessibilityRole="list" accessibilityLabel="Ranks">
          {RANKS.map((r, i) => {
            const done = r.at <= met;
            const now_ = r === rank.current;
            return (
              <View
                key={r.name}
                style={s.rung}
                accessible
                accessibilityLabel={`${r.name}, at ${r.at} ${r.at === 1 ? "person" : "people"}${now_ ? ", your rank" : done ? ", reached" : ""}`}
              >
                {i > 0 ? <View style={[s.line, done && s.lineDone]} /> : null}
                <View style={[s.dot, done && s.dotDone, now_ && s.dotNow]} />
                <Text style={[s.rungName, done && { color: C.ink2 }, now_ && s.rungNow]}>{r.name}</Text>
                <Text style={s.rungAt}>
                  {r.at} {r.at === 1 ? "person" : "people"}
                </Text>
              </View>
            );
          })}
        </View>
        <Text style={s.rule}>Rank counts people, never handoffs. Passing one payment back and forth with a friend moves nothing.</Text>

        <Head title="So far" />
        <Receipt title="CARRIER · THIS PHONE" subtitle={`${CLUSTER.toUpperCase()} BUILD`}>
          <Row label="People met" value={String(met)} />
          <Row label="Handed on" value={String(pocket.handedOn)} />
          <Row label="Carrying now" value={String(c.slips.length)} />
          <Row label="Signed, not settled" value={String(owed.length)} />
        </Receipt>

        <Head
          title="Your pouch"
          aside={c.online === "online" ? "Check now" : undefined}
          onAside={c.online === "online" ? () => c.refreshOnline() : undefined}
          asideHint="Looks up your pouch on Solana again"
        />
        <Text style={s.p}>
          The pouch is money set aside on Solana so people carrying your payments can trust they will be paid. You can sign
          payments offline up to what is left in it.
        </Text>
        {pouch ? (
          <Receipt title="POUCH" subtitle={`EPOCH ${pouch.epoch} · CHECKED ${ago(Date.now() - pouch.fetchedAt).toUpperCase()}${ago(Date.now() - pouch.fetchedAt) === "now" ? "" : " AGO"}`}>
            <Row label="Committed" value={money(pouch.committed)} />
            <Row label="Available" value={money(pouch.available)} />
            <Row label="Signed, unsettled" value={money(owedSum)} />
            <Row label="You can sign" value={money(c.spendable)} tone="earned" />
            <Row label="Bond" value={money(pouch.bond)} />
            <Row label="Period closes" value={dayTime(epochClosesAt(pouch))} />
          </Receipt>
        ) : (
          <View style={s.noPouch}>
            <Text style={s.noPouchText}>
              {c.online === "online"
                ? "No pouch yet. Setting one up takes a minute and needs signal once."
                : "No pouch yet. You can carry and receive payments without one; to pay someone, set one up the next time you have signal."}
            </Text>
          </View>
        )}
        <View style={{ height: 12 }} />
        {!pouch && c.online === "online" ? (
          <Button label="Set up pouch" hint="Explains what it needs, then sets aside your allowance on Solana devnet" onPress={onSetup} />
        ) : !pouch ? (
          <Button label="Set up pouch" hint="Needs signal" disabled onPress={onSetup} />
        ) : null}
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
        <View style={s.rows}>
          {(
            [
              ["Terms of use", "terms"],
              ["Privacy policy", "privacy"],
            ] as const
          ).map(([label, which]) => (
            <Pressable key={which} onPress={() => onLegal(which)} accessibilityRole="button" accessibilityLabel={label} style={s.rowBtn}>
              <Text style={s.rowText}>{label}</Text>
              <Text style={s.rowMeta}>23 SEP 2026</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={c.services.openSettings}
            accessibilityRole="button"
            accessibilityLabel={`Nearby access, ${c.radio.state === "on" ? "on" : "off"}`}
            accessibilityHint="Opens Android settings for Carrier"
            style={s.rowBtn}
          >
            <Text style={s.rowText}>Nearby access</Text>
            <Text style={s.rowMeta}>{c.radio.state === "on" ? "ON" : "OFF"}</Text>
          </Pressable>
        </View>
        <Text style={s.fine}>
          Carrier 0.1 on Solana {CLUSTER}
          {"\n"}Program {PROGRAM_ID.toBase58()}
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { paddingHorizontal: S.gutter, paddingTop: 12, paddingBottom: 12 },
  h1: { fontFamily: FONT.face, fontSize: 30, fontWeight: "800", letterSpacing: -1.2, color: C.ink },
  sub: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginTop: 5 },
  body: { paddingHorizontal: S.gutter, paddingBottom: 32 },
  rankNow: { fontFamily: FONT.face, fontSize: 40, fontWeight: "800", letterSpacing: -1.8, color: C.ink },
  rankCap: { fontFamily: FONT.hand, fontSize: 18, fontWeight: "700", color: C.red, marginTop: 8, transform: [{ rotate: "-1.5deg" }] },
  ladder: { marginTop: 16 },
  rung: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 },
  line: { position: "absolute", left: 10, top: -18, height: 36, borderLeftWidth: 2, borderStyle: "dashed", borderColor: C.ink3 },
  lineDone: { borderStyle: "solid", borderColor: C.ink },
  dot: { width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 2, borderColor: C.ink3, backgroundColor: C.paper, transform: [{ scale: 0.5 }] },
  dotDone: { backgroundColor: C.ink, borderColor: C.ink },
  dotNow: { backgroundColor: C.slip, borderColor: C.ink, borderWidth: 3, transform: [{ scale: 0.8 }] },
  rungName: { flex: 1, fontFamily: FONT.face, fontSize: 16, color: C.ink3 },
  rungNow: { color: C.ink, fontWeight: "800" },
  rungAt: { fontFamily: FONT.mono, fontSize: 12, color: C.ink3 },
  rule: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 14 },
  p: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2, marginBottom: 12 },
  noPouch: { borderWidth: 2, borderStyle: "dashed", borderColor: C.ink3, padding: 16 },
  noPouchText: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2 },
  status: { fontFamily: FONT.mono, fontSize: 12, color: C.ink2, marginTop: 10 },
  rows: { borderTopWidth: 1.5, borderColor: C.ink },
  rowBtn: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 52, borderBottomWidth: 1, borderColor: C.rule },
  rowText: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700", color: C.ink },
  rowMeta: { fontFamily: FONT.mono, fontSize: 12, fontWeight: "600", color: C.ink2 },
  fine: { fontFamily: FONT.mono, fontSize: 11, lineHeight: 18, color: C.ink3, marginTop: 18 },
});

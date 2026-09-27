import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, S } from "../theme";
import { FONT } from "../ui/fonts";
import { Head } from "../ui/kit";
import type { Carrier } from "../useCarrier";
import { FeedRow, PeopleEmpty, PersonRow } from "./People";
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

  return (
    <View style={{ flex: 1 }}>
      <View style={s.bar}>
        <Text style={s.h1} accessibilityRole="header">
          Around you
        </Text>
        <Text style={s.sub}>People in range, and what this phone has seen</Text>
      </View>
      <ScrollView contentContainerStyle={s.body}>
        <Head title="In range" aside={c.peers.length ? String(c.peers.length) : undefined} />
        {c.peers.length ? (
          <View style={s.people}>
            {c.peers.map((key) => {
              const k = key.toBase58();
              return (
                <PersonRow
                  key={k}
                  person={{ key, met: pocket.hasMet(key), holding: c.holdings[k] ?? 0, forThem: false }}
                  selected={false}
                  target={false}
                  hint="Opens the Carry tab with them chosen, to hand over, take or pay"
                  onPress={() => onPick(k)}
                />
              );
            })}
          </View>
        ) : (
          <PeopleEmpty text={radioLine(c.radio, 0)} />
        )}

        <View style={s.seg} accessibilityRole="radiogroup" accessibilityLabel="Show">
          {(
            [
              ["all", "Everything"],
              ["mine", "Just you"],
            ] as const
          ).map(([v, label], i) => (
            <Pressable
              key={v}
              onPress={() => setFilter(v)}
              accessibilityRole="radio"
              accessibilityState={{ checked: filter === v }}
              accessibilityLabel={label}
              style={[s.segBtn, i > 0 && s.segSep, filter === v && s.segOn]}
            >
              <Text style={[s.segText, filter === v && s.segTextOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <View accessibilityLiveRegion="polite">
          {!rows.length ? (
            <View style={s.empty}>
              <Text style={s.emptyHand}>nothing yet.</Text>
              <Text style={s.emptySmall}>
                Every handoff you make, every payment that reaches you and every settlement you earn from is logged here.
              </Text>
            </View>
          ) : null}
          {recent.length ? (
            <>
              <Text style={s.group} accessibilityRole="header">
                in the last hour
              </Text>
              {recent.map((e) => (
                <FeedRow key={e.id} e={e} />
              ))}
            </>
          ) : null}
          {older.length ? (
            <>
              <Text style={s.group} accessibilityRole="header">
                earlier
              </Text>
              {older.map((e) => (
                <FeedRow key={e.id} e={e} />
              ))}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  bar: { paddingHorizontal: S.gutter, paddingTop: 12, paddingBottom: 4 },
  h1: { fontFamily: FONT.face, fontSize: 30, fontWeight: "800", letterSpacing: -1.2, color: C.ink },
  sub: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginTop: 5 },
  body: { paddingHorizontal: S.gutter, paddingBottom: 24 },
  people: { borderTopWidth: 1.5, borderColor: C.ink },
  seg: { flexDirection: "row", borderWidth: 1.5, borderColor: C.ink, borderRadius: 6, overflow: "hidden", marginTop: 24 },
  segBtn: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", backgroundColor: C.card },
  segSep: { borderLeftWidth: 1.5, borderColor: C.ink },
  segOn: { backgroundColor: C.ink },
  segText: { fontFamily: FONT.face, fontSize: 15, fontWeight: "700", color: C.ink2 },
  segTextOn: { color: C.onInk },
  group: { fontFamily: FONT.hand, fontSize: 18, fontWeight: "700", color: C.red, marginTop: 20, marginBottom: 2, transform: [{ rotate: "-1deg" }] },
  empty: { backgroundColor: C.denim, borderRadius: 6, padding: 22, marginTop: 16, alignItems: "center" },
  emptyHand: { fontFamily: FONT.hand, fontSize: 21, fontWeight: "700", color: C.chalk },
  emptySmall: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.chalk2, marginTop: 8, textAlign: "center" },
});

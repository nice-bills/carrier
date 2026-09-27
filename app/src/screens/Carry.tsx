import { useMemo, useRef, useState } from "react";
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { noteKey } from "../chain";
import { shorten } from "../format";
import { C, S } from "../theme";
import { FONT } from "../ui/fonts";
import { Button, Coach, Head, useReducedMotion } from "../ui/kit";
import type { Carrier } from "../useCarrier";
import { FeedRow, PeopleEmpty, PersonRow, type PersonInfo } from "./People";
import { SlipView, slipFacts, slipLabel } from "./Slip";
import { radioLine } from "./radioLine";

/**
 * Carry: what is in your pocket, and who is near enough to hand it to.
 *
 * The slip is picked up and dropped on a person. Every drop has a button
 * equivalent: tap the person, then the button at the bottom, or use the
 * slip's screen-reader actions ("Pass to …"). Either way the confirm sheet
 * comes next; nothing moves on a drop alone.
 */
export function CarryScreen({
  c,
  cursor,
  setCursor,
  selected,
  setSelected,
  onPass,
  onPay,
  onSeeAll,
  forceTarget,
}: {
  c: Carrier;
  cursor: number;
  setCursor: (n: number) => void;
  selected: string | null;
  setSelected: (k: string | null) => void;
  /** Open the confirm sheet for handing `bundle` to `peer`. */
  onPass: (bundle: Bundle, peer: PublicKey) => void;
  /** Open the pay sheet, optionally with a recipient. */
  onPay: (to?: PublicKey) => void;
  onSeeAll: () => void;
  /** Demo only: draw this person as the drop target, slip lifted. */
  forceTarget?: string | null;
}) {
  const reduced = useReducedMotion();
  const pocket = c.pocket!;
  const me = pocket.me;
  const slips = c.slips;
  const current: Bundle | null = slips.length ? slips[Math.min(cursor, slips.length - 1)]! : null;
  const facts = current ? slipFacts(current, me) : null;
  const passable = !!current && facts?.role !== "for-me";

  const people: PersonInfo[] = useMemo(
    () =>
      c.peers.map((key) => ({
        key,
        met: pocket.hasMet(key),
        holding: c.holdings[key.toBase58()] ?? 0,
        forThem: !!current && current.note.to.equals(key),
      })),
    [c.peers, c.holdings, current, pocket, c.version],
  );
  // A chosen person who walks out of range simply stops being chosen.
  const chosen = people.find((p) => p.key.toBase58() === selected) ?? null;

  // --- drag -------------------------------------------------------------------------
  const pan = useRef(new Animated.ValueXY()).current;
  const rows = useRef(new Map<string, View | null>());
  const rects = useRef(new Map<string, { x: number; y: number; w: number; h: number }>());
  const [lifted, setLifted] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [scrollOn, setScrollOn] = useState(true);
  const overRef = useRef<string | null>(null);
  const live = useRef({ current, people, onPass, reduced });
  live.current = { current, people, onPass, reduced };

  const reset = () => {
    setLifted(false);
    setScrollOn(true);
    setOver(null);
    overRef.current = null;
    if (live.current.reduced) pan.setValue({ x: 0, y: 0 });
    else Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false, friction: 8 }).start();
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) => Math.hypot(g.dx, g.dy) > 8,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          setLifted(true);
          setScrollOn(false);
          rects.current.clear();
          for (const [k, v] of rows.current) {
            // Page coordinates, the same frame as the gesture's moveX/moveY.
            v?.measure((_x, _y, w, h, pageX, pageY) => rects.current.set(k, { x: pageX, y: pageY, w, h }));
          }
        },
        onPanResponderMove: (_, g) => {
          pan.setValue({ x: g.dx, y: g.dy });
          let hit: string | null = null;
          for (const [k, r] of rects.current) {
            if (g.moveX >= r.x && g.moveX <= r.x + r.w && g.moveY >= r.y && g.moveY <= r.y + r.h) hit = k;
          }
          if (hit !== overRef.current) {
            overRef.current = hit;
            setOver(hit);
          }
        },
        onPanResponderRelease: () => {
          const landed = overRef.current;
          const { current: b, people: ps, onPass: pass } = live.current;
          reset();
          const p = landed ? ps.find((x) => x.key.toBase58() === landed) : null;
          if (b && p) {
            setSelected(p.key.toBase58());
            pass(b, p.key);
          }
        },
        onPanResponderTerminate: () => reset(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const rotate = pan.x.interpolate({ inputRange: [-300, 300], outputRange: ["-12deg", "6deg"], extrapolate: "clamp" });
  const showLifted = lifted || !!forceTarget;
  const liftStyle = showLifted
    ? {
        transform: [
          { translateX: forceTarget ? 30 : pan.x },
          { translateY: forceTarget ? 150 : pan.y },
          { scale: 0.92 },
          ...(reduced ? [] : [{ rotate: forceTarget ? "-3deg" : rotate }]),
        ],
      }
    : undefined;

  // --- dock -------------------------------------------------------------------------
  const radio = c.radio;
  let primary: { label: string; spoken?: string; hint: string; onPress?: () => void; disabled?: boolean };
  if (radio.state === "needs-permission") {
    primary = radio.blocked
      ? { label: "Open settings", hint: "Opens Android settings to allow Nearby devices", onPress: c.services.openSettings }
      : { label: "Allow nearby access", hint: "Asks Android for Nearby devices and Location", onPress: c.startRadio };
  } else if (radio.state === "off" || radio.state === "unavailable") {
    primary = { label: "Look for people", hint: "Turns the radio on so nearby phones can find you", onPress: c.startRadio };
  } else if (radio.state === "starting") {
    primary = { label: "Turning the radio on", hint: "", disabled: true };
  } else if (!people.length) {
    primary = { label: "Looking for people", hint: "Nobody with Carrier is in range yet", disabled: true };
  } else if (!chosen) {
    primary = { label: passable ? "Tap someone to hand it to" : "Tap someone near you", hint: "Choose a person in the list above first", disabled: true };
  } else if (passable && current) {
    const deliver = current.note.to.equals(chosen.key);
    primary = {
      label: `${deliver ? "Deliver" : "Hand"} ${facts!.value} to ${shorten(chosen.key)}`,
      spoken: `${deliver ? "Deliver" : "Hand"} ${facts!.spoken} to ${shorten(chosen.key)}`,
      hint: "Shows what happens before anything moves",
      onPress: () => onPass(current, chosen.key),
    };
  } else if (chosen.holding) {
    primary = {
      label: `Take from ${shorten(chosen.key)}`,
      hint: "Both phones sign, and their payment moves into your pocket to carry",
      onPress: () => c.take(chosen.key),
    };
  } else {
    primary = { label: `Pay ${shorten(chosen.key)}`, hint: "Choose an amount, then confirm", onPress: () => onPay(chosen.key) };
  }

  // --- coach ------------------------------------------------------------------------
  const [coachOff, setCoachOff] = useState(false);
  const coach =
    coachOff || radio.state !== "on"
      ? null
      : c.firstHandoff && !slips.length
        ? { n: 3, text: "Your share arrives when anyone further down the chain finds signal. You will see it land." }
        : passable
          ? { n: 2, text: "Now pass it on. Drag the slip out of your pocket onto anyone near you, or tap them and use the button." }
          : !slips.length && people.some((p) => p.holding)
            ? { n: 1, text: "Anyone marked as holding a payment can hand it to you. Tap them and take it. You carry it until you meet someone going its way." }
            : null;

  const sub = slips.length ? (slips.length === 1 ? "Carrying 1 payment" : `Carrying ${slips.length} payments`) : "Nothing in your pocket";

  return (
    <View style={{ flex: 1 }}>
      <View style={s.bar}>
        <Text style={s.h1} accessibilityRole="header">
          Carry
        </Text>
        <Text style={s.sub}>{sub}</Text>
      </View>
      <ScrollView scrollEnabled={scrollOn} contentContainerStyle={s.body}>
        <View style={s.radio} accessible accessibilityLiveRegion="polite" accessibilityLabel={radioLine(radio, people.length)}>
          <View style={[s.led, radio.state === "on" ? s.ledOn : s.ledOff]} />
          <Text style={[s.radioText, radio.state !== "on" && { color: C.ink }]}>{radioLine(radio, people.length)}</Text>
        </View>

        {coach ? <Coach n={coach.n} text={coach.text} onDone={() => setCoachOff(true)} /> : null}

        <View style={[s.pocket, showLifted && { zIndex: 5 }]}>
          <View style={s.stitchBox} pointerEvents="none" />
          <View style={s.stitchTop} pointerEvents="none" />
          {current ? (
            <>
              <Animated.View
                {...(passable ? responder.panHandlers : {})}
                style={[{ zIndex: 5 }, liftStyle]}
                accessible
                accessibilityLabel={slipLabel(current, me, slips.length > 1 ? `${cursor + 1} of ${slips.length}.` : undefined)}
                accessibilityHint={passable && people.length ? "Use the actions menu to pass it to someone near you" : undefined}
                accessibilityActions={
                  passable ? people.map((p) => ({ name: `pass:${p.key.toBase58()}`, label: `Pass to ${shorten(p.key)}` })) : []
                }
                onAccessibilityAction={(e) => {
                  const name = e.nativeEvent.actionName;
                  const p = people.find((x) => `pass:${x.key.toBase58()}` === name);
                  if (p && current) onPass(current, p.key);
                }}
              >
                <SlipView
                  bundle={current}
                  me={me}
                  lifted={showLifted}
                  counter={slips.length > 1 ? `${cursor + 1} of ${slips.length}` : undefined}
                />
              </Animated.View>
              <View style={s.slipControls}>
                {slips.length > 1 ? (
                  <Pressable
                    onPress={() => setCursor((cursor + 1) % slips.length)}
                    accessibilityRole="button"
                    accessibilityLabel="Show next payment"
                    accessibilityHint={`Payment ${cursor + 1} of ${slips.length} is showing`}
                    style={s.chalkBtn}
                  >
                    <Text style={s.chalkBtnText}>Next slip ›</Text>
                  </Pressable>
                ) : null}
                <SettleControl c={c} bundle={current} />
              </View>
            </>
          ) : (
            <View style={s.empty} accessible accessibilityLabel="Empty pocket. A payment you take lands here as a slip, stamped by everyone who carried it before you.">
              <Text style={s.emptyHand}>empty pocket.</Text>
              <Text style={s.emptySmall}>
                A payment you take lands here as a slip, stamped by everyone who carried it before you.
              </Text>
            </View>
          )}
        </View>

        <Head title="Near you" aside={people.length ? String(people.length) : undefined} />
        {people.length ? (
          <View style={s.people} accessibilityLabel="People near you">
            {people.map((p) => {
              const k = p.key.toBase58();
              return (
                <PersonRow
                  key={k}
                  ref={(v) => {
                    rows.current.set(k, v);
                  }}
                  person={p}
                  selected={selected === k}
                  target={over === k || forceTarget === k}
                  hint={passable ? "Selects them. Then use the button at the bottom to hand it over." : "Selects them. Then use the button at the bottom."}
                  onPress={() => setSelected(selected === k ? null : k)}
                />
              );
            })}
          </View>
        ) : (
          <PeopleEmpty
            text={
              radio.state === "on"
                ? "Nobody with Carrier open is in range yet. Handoffs reach about as far as you could pass something across a room."
                : "Carrier cannot see anyone until the radio is on. Turning it on sends nothing anywhere."
            }
          />
        )}

        <Head title="Just now" aside="See all" onAside={onSeeAll} asideHint="Opens the Around tab" />
        {pocket.feed.slice(0, 3).map((e) => (
          <FeedRow key={e.id} e={e} />
        ))}
        {!pocket.feed.length ? <Text style={s.quiet}>Nothing has happened on this phone yet.</Text> : null}
      </ScrollView>
      <View style={s.dock}>
        <Button label={primary.spoken ?? primary.label} hint={primary.hint} onPress={primary.onPress} disabled={primary.disabled}>
          {primary.label}
        </Button>
        {primary.label.startsWith("Pay ") ? null : (
          <Button label="Pay someone" hint="Sign a new payment from your pouch" variant="quiet" onPress={() => onPay()} />
        )}
      </View>
    </View>
  );
}

/** Settle button (or why not) under a slip that can be settled from this phone. */
function SettleControl({ c, bundle }: { c: Carrier; bundle: Bundle }) {
  const k = noteKey(bundle);
  const busy = !!c.settling[k];
  const error = c.settleErrors[k];
  const forMe = bundle.note.to.equals(c.pocket!.me);
  // Settling is offered for payments to you, and for ones you carry.
  if (!forMe && bundle.hops.length === 0) return null;
  return (
    <View style={{ flex: 1, gap: 6 }}>
      {c.online === "online" ? (
        <Pressable
          onPress={busy ? undefined : () => c.settle(k)}
          accessibilityRole="button"
          accessibilityLabel={forMe ? "Settle now" : "Settle it yourself now"}
          accessibilityHint="Sends it to Solana. This phone pays a small network fee."
          accessibilityState={{ busy }}
          style={[s.chalkBtn, s.settleBtn]}
        >
          <Text style={s.settleText}>{busy ? "Settling…" : forMe ? "Settle now" : "Settle it now"}</Text>
        </Pressable>
      ) : forMe ? (
        <Text style={s.chalkNote}>It settles the next time this phone has signal.</Text>
      ) : null}
      {error ? (
        <Text style={s.error} accessibilityLiveRegion="assertive">
          Not settled. {error}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { paddingHorizontal: S.gutter, paddingTop: 12, paddingBottom: 12 },
  h1: { fontFamily: FONT.face, fontSize: 30, fontWeight: "800", letterSpacing: -1.2, color: C.ink },
  sub: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginTop: 5 },
  body: { paddingHorizontal: S.gutter, paddingBottom: 24 },
  radio: { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 14, minHeight: 24 },
  led: { width: 10, height: 10, borderRadius: 5 },
  ledOn: { backgroundColor: C.green },
  ledOff: { borderWidth: 1.5, borderColor: C.ink3 },
  radioText: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, flexShrink: 1 },
  pocket: {
    backgroundColor: C.denim,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    paddingTop: 18,
    paddingHorizontal: 14,
    paddingBottom: 20,
  },
  stitchBox: {
    position: "absolute",
    top: 7,
    left: 7,
    right: 7,
    bottom: 7,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: C.thread,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  stitchTop: { position: "absolute", left: 7, right: 7, top: 12, borderTopWidth: 1.5, borderStyle: "dashed", borderColor: C.thread },
  slipControls: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "flex-start" },
  chalkBtn: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: C.chalk,
    justifyContent: "center",
    alignItems: "center",
  },
  chalkBtnText: { fontFamily: FONT.face, fontSize: 15, fontWeight: "700", color: C.chalk },
  settleBtn: { backgroundColor: C.chalk, borderColor: C.chalk },
  settleText: { fontFamily: FONT.face, fontSize: 15, fontWeight: "800", color: C.denimDark },
  chalkNote: { fontFamily: FONT.face, fontSize: 14, color: C.chalk2, paddingTop: 4 },
  error: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.receiptInk, backgroundColor: C.receipt, padding: 10, borderLeftWidth: 4, borderColor: C.red },
  empty: { paddingTop: 22, paddingBottom: 10, paddingHorizontal: 8, alignItems: "center" },
  emptyHand: { fontFamily: FONT.hand, fontWeight: "700", fontSize: 22, color: C.chalk, transform: [{ rotate: "-2deg" }] },
  emptySmall: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.chalk2, marginTop: 10, textAlign: "center" },
  people: { borderTopWidth: 1.5, borderColor: C.ink },
  quiet: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, paddingVertical: 8 },
  dock: { paddingHorizontal: S.gutter, paddingTop: 10, paddingBottom: 14, gap: 8, borderTopWidth: 1, borderColor: C.rule, backgroundColor: C.paper },
});


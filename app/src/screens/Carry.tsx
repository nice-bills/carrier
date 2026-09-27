import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { noteKey } from "../chain";
import { shorten } from "../format";
import { C, R, S, SHADOW } from "../theme";
import { FONT } from "../ui/fonts";
import { Appear, Button, Card, Coach, Head, LiveDot, PillButton, Plus, ScreenHead, buzz, spring, useReducedMotion } from "../ui/kit";
import { useDock } from "../ui/chrome";
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
  const onDock = useDock();
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
    ? [
        s.liftShadow,
        {
          transform: [
            { translateX: forceTarget ? 30 : pan.x },
            { translateY: forceTarget ? 150 : pan.y },
            ...(reduced ? [] : [{ scale: 1.03 }, { rotate: forceTarget ? "-3deg" : rotate }]),
          ],
        },
      ]
    : undefined;

  // --- motion: a slip leaving for someone, a slip arriving ---------------------------
  const rootRef = useRef<View>(null);
  const pocketRef = useRef<View>(null);
  const currentKey = current ? noteKey(current) : null;
  const keySig = slips.map(noteKey).join("|");
  const prevKeys = useRef<Set<string> | null>(null);
  const shown = useRef<Bundle | null>(null);
  const [fly, setFly] = useState<Flight | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const drop = useRef(new Animated.Value(1)).current;

  // Declared before the effect that remembers what is showing, so it still sees the old slip.
  useEffect(() => {
    const now = new Set(keySig ? keySig.split("|") : []);
    const prev = prevKeys.current;
    prevKeys.current = now;
    if (!prev) return; // first render: nothing arrived or left
    const gone = shown.current;
    if (gone && !now.has(noteKey(gone)) && !reduced) {
      const e = pocket.feed[0];
      // Only a handoff that went through flies; a failed one leaves the slip where it was.
      if (e && (e.kind === "handed" || e.kind === "delivered") && Date.now() - e.at < 3000) {
        const to = people.find((p) => shorten(p.key) === e.who) ?? people.find((p) => p.key.toBase58() === selected) ?? null;
        const row = to ? rows.current.get(to.key.toBase58()) : null;
        rootRef.current?.measure((_x, _y, _w, _h, rx, ry) => {
          pocketRef.current?.measure((_a, _b, pw, _ph, px, py) => {
            const from = { x: px - rx + 12, y: py - ry + 12, w: pw - 24 };
            if (row) row.measure((_c, _d, w, h, qx, qy) => setFly({ bundle: gone, from, to: { x: qx - rx + w / 2, y: qy - ry + h / 2 } }));
            else setFly({ bundle: gone, from, to: null });
          });
        });
      }
    }
    if (currentKey && !prev.has(currentKey)) {
      setFreshKey(currentKey);
      buzz("land");
      drop.setValue(0);
      spring(drop, 1, reduced).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig]);
  useEffect(() => {
    shown.current = current;
  }, [current]);
  useEffect(() => {
    if (!freshKey) return;
    const t = setTimeout(() => setFreshKey(null), 1600);
    return () => clearTimeout(t);
  }, [freshKey]);

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
  const coach =
    pocket.tipsOff || radio.state !== "on"
      ? null
      : c.firstHandoff && !slips.length
        ? { n: 3, text: "Your share arrives when anyone further down the chain finds signal. You will see it land." }
        : passable
          ? { n: 2, text: "Now pass it on. Drag the slip out of your pocket onto anyone near you, or tap them and use the button." }
          : !slips.length && people.some((p) => p.holding)
            ? { n: 1, text: "Anyone marked as holding a payment can hand it to you. Tap them and take it. You carry it until you meet someone going its way." }
            : null;

  const sub = slips.length
    ? slips.length === 1
      ? "You're carrying 1 payment"
      : `You're carrying ${slips.length} payments`
    : "Nothing to carry right now";
  const settlingN = Object.values(c.settling).filter(Boolean).length;

  return (
    <View style={{ flex: 1 }} ref={rootRef} collapsable={false}>
      <ScreenHead
        title="Carry"
        sub={sub}
        aside={<PillButton label="Pay" hint="Sign a new payment from your pouch" icon={<Plus />} onPress={() => onPay()} />}
      />
      <ScrollView scrollEnabled={scrollOn} contentContainerStyle={s.body}>
        <View style={s.radio} accessible accessibilityLiveRegion="polite" accessibilityLabel={radioLine(radio, people.length)}>
          <LiveDot on={radio.state === "on"} />
          <Text style={s.radioText}>{radioLine(radio, people.length)}</Text>
        </View>

        {settlingN ? (
          <Appear from={-8}>
            <View style={s.banner} accessibilityLiveRegion="polite">
              <ActivityIndicator size="small" color={C.greenInk} />
              <Text style={s.bannerText}>
                Signal found. Settling {settlingN} {settlingN === 1 ? "payment" : "payments"}…
              </Text>
            </View>
          </Appear>
        ) : null}

        {coach ? (
          <View style={{ marginTop: 14, marginBottom: -14 }}>
            <Coach
              n={coach.n}
              text={coach.text}
              onDone={() =>
                pocket.stopTips().catch(() => c.say("Couldn't save that setting. The tips may come back next time you open Carrier."))
              }
            />
          </View>
        ) : null}

        <View ref={pocketRef} collapsable={false} style={[s.pocket, showLifted && { zIndex: 5 }]}>
          {current ? (
            <>
              <Animated.View
                style={{
                  zIndex: 5,
                  transform: [
                    { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) },
                    { scale: drop.interpolate({ inputRange: [0, 1], outputRange: [1.03, 1] }) },
                  ],
                }}
              >
                <Animated.View
                  {...(passable ? responder.panHandlers : {})}
                  style={liftStyle}
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
                    key={currentKey!}
                    bundle={current}
                    me={me}
                    lifted={showLifted}
                    freshLast={freshKey === currentKey}
                    counter={slips.length > 1 ? `${cursor + 1} of ${slips.length}` : undefined}
                  />
                </Animated.View>
              </Animated.View>
              <View style={s.slipControls}>
                {slips.length > 1 ? (
                  <Pressable
                    onPress={() => setCursor((cursor + 1) % slips.length)}
                    accessibilityRole="button"
                    accessibilityLabel="Show next payment"
                    accessibilityHint={`Payment ${cursor + 1} of ${slips.length} is showing`}
                    style={({ pressed }) => [s.pocketBtn, s.nextBtn, pressed && { opacity: 0.85 }]}
                  >
                    <Text style={s.nextText}>Next slip</Text>
                  </Pressable>
                ) : null}
                <SettleControl c={c} bundle={current} />
              </View>
            </>
          ) : (
            <View
              style={s.empty}
              accessible
              accessibilityLabel="Your pocket is empty. Stay near people who are paying and you'll carry their payments too. A payment you take lands here as a slip, stamped by everyone who carried it before you."
            >
              <View style={s.emptyLine} pointerEvents="none" />
              <View style={s.emptyIcon}>
                <View style={s.emptyGlyph}>
                  <View style={s.emptyGlyphBar} />
                </View>
              </View>
              <Text style={s.emptyTitle}>Your pocket is empty</Text>
              <Text style={s.emptySmall}>Stay near people who are paying and you'll carry their payments too.</Text>
            </View>
          )}
        </View>

        <Head title="Near you" aside={people.length ? String(people.length) : undefined} />
        {people.length ? (
          <Card pad={false} style={s.list}>
            <View accessibilityLabel="People near you">
              {people.map((p, i) => {
                const k = p.key.toBase58();
                return (
                  <PersonRow
                    key={k}
                    ref={(v) => {
                      rows.current.set(k, v);
                    }}
                    first={i === 0}
                    person={p}
                    selected={selected === k}
                    target={over === k || forceTarget === k}
                    hint={passable ? "Selects them. Then use the button at the bottom to hand it over." : "Selects them. Then use the button at the bottom."}
                    onPress={() => setSelected(selected === k ? null : k)}
                  />
                );
              })}
            </View>
          </Card>
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
        <Card pad={false} style={s.list}>
          {pocket.feed.slice(0, 3).map((e, i) => (
            <FeedRow key={e.id} e={e} first={i === 0} />
          ))}
          {!pocket.feed.length ? <Text style={s.quiet}>Nothing has happened on this phone yet.</Text> : null}
        </Card>
      </ScrollView>
      <View style={s.dock} onLayout={onDock}>
        <Button label={primary.spoken ?? primary.label} hint={primary.hint} onPress={primary.onPress} disabled={primary.disabled}>
          {primary.label}
        </Button>
      </View>
      {fly ? <FlyingSlip flight={fly} me={me} onDone={() => setFly(null)} /> : null}
    </View>
  );
}

interface Flight {
  bundle: Bundle;
  /** Where the slip sat, relative to the screen. */
  from: { x: number; y: number; w: number };
  /** The centre of the person it went to, or null to fly up and away. */
  to: { x: number; y: number } | null;
}

/**
 * A copy of a slip that was just handed on, arcing from the pocket to the
 * person who took it: it shrinks, tips a little and fades as it lands.
 * Decorative; the feed and the announcement say what happened.
 */
function FlyingSlip({ flight, me, onDone }: { flight: Flight; me: PublicKey; onDone: () => void }) {
  const t = useRef(new Animated.Value(0)).current;
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    if (h == null) return;
    const a = Animated.timing(t, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.cubic), useNativeDriver: true });
    a.start(() => onDone());
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h]);
  const { from, to } = flight;
  const cx = from.x + from.w / 2;
  const cy = from.y + (h ?? 0) / 2;
  const dx = to ? to.x - cx : 0;
  const dy = to ? to.y - cy : -(from.y + (h ?? 0)) - 40;
  const steps = [0, 0.25, 0.5, 0.75, 1];
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      onLayout={(e) => h == null && setH(e.nativeEvent.layout.height)}
      style={[
        s.flyer,
        {
          left: from.x,
          top: from.y,
          width: from.w,
          opacity: h == null ? 0 : t.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
          transform: [
            { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
            { translateY: t.interpolate({ inputRange: steps, outputRange: steps.map((p) => dy * p - 70 * Math.sin(Math.PI * p)) }) },
            { scale: t.interpolate({ inputRange: [0, 0.15, 1], outputRange: [1, 1.04, 0.25] }) },
            { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "12deg"] }) },
          ],
        },
      ]}
    >
      <SlipView bundle={flight.bundle} me={me} />
    </Animated.View>
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
  if (c.online !== "online" && !forMe && !error) return null;
  return (
    <View style={{ flex: 1, gap: 6 }}>
      {c.online === "online" ? (
        <Pressable
          onPress={busy ? undefined : () => c.settle(k)}
          accessibilityRole="button"
          accessibilityLabel={forMe ? "Settle now" : "Settle it yourself now"}
          accessibilityHint="Sends it to Solana. This phone pays a small network fee."
          accessibilityState={{ busy }}
          style={({ pressed }) => [s.pocketBtn, s.settleBtn, pressed && { opacity: 0.85 }]}
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
  body: { paddingHorizontal: S.gutter, paddingBottom: 24 },
  radio: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    marginTop: 4,
    minHeight: 36,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 14,
    borderRadius: R.pill,
    backgroundColor: C.card,
    ...SHADOW,
  },
  radioText: { fontFamily: FONT.face, fontSize: 14, fontWeight: "500", color: C.ink, flexShrink: 1 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: R.box,
    backgroundColor: C.greenSoft,
  },
  bannerText: { fontFamily: FONT.face, fontSize: 14, fontWeight: "600", color: C.greenInk, flexShrink: 1 },
  pocket: { backgroundColor: C.denim, borderRadius: 28, padding: 12, marginTop: 18 },
  liftShadow: { shadowColor: C.ink, shadowOpacity: 0.22, shadowRadius: 22, shadowOffset: { width: 0, height: 14 }, elevation: 10, borderRadius: 20 },
  slipControls: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "flex-start" },
  pocketBtn: { minHeight: 52, paddingHorizontal: 14, borderRadius: 14, justifyContent: "center", alignItems: "center" },
  nextBtn: { flex: 1, backgroundColor: C.denimDeep },
  nextText: { fontFamily: FONT.face, fontSize: 16, fontWeight: "600", color: C.chalk },
  settleBtn: { backgroundColor: C.chalk },
  settleText: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700", color: C.denimDark },
  chalkNote: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.chalk2, paddingTop: 4, paddingHorizontal: 4 },
  error: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.redInk, backgroundColor: C.redSoft, borderRadius: 12, padding: 12, overflow: "hidden" },
  empty: { minHeight: 210, paddingHorizontal: 28, paddingVertical: 28, alignItems: "center", justifyContent: "center", gap: 10 },
  emptyLine: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderWidth: 2, borderStyle: "dashed", borderColor: C.chalk2, borderRadius: 20, opacity: 0.45 },
  emptyIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: C.denimDeep, alignItems: "center", justifyContent: "center" },
  emptyGlyph: { width: 22, height: 16, borderRadius: 4, borderWidth: 2, borderColor: C.chalk, justifyContent: "flex-start", paddingTop: 3 },
  emptyGlyphBar: { height: 2, backgroundColor: C.chalk },
  emptyTitle: { fontFamily: FONT.face, fontSize: 17, fontWeight: "700", color: C.chalk, textAlign: "center" },
  emptySmall: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.chalk2, textAlign: "center" },
  list: { paddingVertical: 3 },
  quiet: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, paddingVertical: 14, paddingHorizontal: 16 },
  dock: { paddingHorizontal: S.gutter, paddingTop: 10, paddingBottom: 14, backgroundColor: C.paper },
  flyer: { position: "absolute", zIndex: 50 },
});

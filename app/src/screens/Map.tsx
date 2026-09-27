import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { C, R, S, SHADOW, T, TARGET } from "../theme";
import { hhmm, shorten } from "../format";
import { FONT } from "../ui/fonts";
import { Appear, Button, Card, CountUp, Note, ScreenHead, buzz, spring, type, useReducedMotion } from "../ui/kit";
import { MapGlyph } from "../ui/chrome";
import type { Carrier } from "../useCarrier";
import { ATTRIBUTION, SpreadMap, canSaveOffline, saveArea } from "../map/SpreadMap";
import { distanceText, durationSpoken, durationText, hands, lastAt, routeMetres, settleState, settledPoint, today } from "../map/geo";
import type { Cell, Route } from "../map/types";

export type MapView = "route" | "today";

/**
 * Map: where payments went, hand to hand. "This payment" draws one of your own
 * routes with who held it and when; "Seen today" draws every route this phone
 * has seen since midnight. The map is off until the person turns it on, and
 * while it is off this phone adds no place to anything it passes on.
 *
 * The card at the bottom says in words what the map draws, so it is the
 * accessible version; the map itself carries a one-line summary.
 */
export function MapScreen({
  c,
  view,
  setView,
  focusId,
  setFocusId,
  placeName,
}: {
  c: Carrier;
  view: MapView;
  setView: (v: MapView) => void;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  /** Names a place (demo only: a phone has no names for places). */
  placeName?: (cell: Cell) => string | null;
}) {
  if (!c.mapOn) return <OptIn c={c} />;
  return <OnMap c={c} view={view} setView={setView} focusId={focusId} setFocusId={setFocusId} placeName={placeName} />;
}

// --- the map, on ---------------------------------------------------------------------

function OnMap({
  c,
  view,
  setView,
  focusId,
  setFocusId,
  placeName,
}: {
  c: Carrier;
  view: MapView;
  setView: (v: MapView) => void;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  placeName?: (cell: Cell) => string | null;
}) {
  const me = c.pocket!.me.toBase58();
  const routes: Route[] = c.routes;
  // Your own routes, newest first; the chosen one, or the newest.
  const mine = useMemo(() => routes.filter((r) => r.mine && r.points.length).sort((a, b) => lastAt(b) - lastAt(a)), [routes]);
  const focus = mine.find((r) => r.id === focusId) ?? mine[0] ?? null;
  const seen = useMemo(() => today(routes), [routes]);
  const shown = view === "route" ? mine : seen;
  const cells = useMemo(() => shown.flatMap((r) => r.points.map((p) => p.cell)).concat(c.here ? [c.here] : []), [shown, c.here]);

  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(0);
  const [locate, setLocate] = useState(0);
  const inset = useMemo(() => ({ top, bottom }), [top, bottom]);

  const label =
    view === "route"
      ? focus
        ? routeSpoken(focus, me, placeName)
        : "Map, with none of your payments on it yet."
      : seen.length
        ? `Map of payments seen today: ${seen.length} ${seen.length === 1 ? "payment" : "payments"}, drawn as lines between the places they changed hands.`
        : "Map, with no payments seen today.";

  return (
    <View style={m.fill}>
      <SpreadMap routes={shown} focus={view === "route" ? focus : null} me={me} here={c.here} mode={view} inset={inset} locate={locate} label={label} />

      <View style={m.top} onLayout={(e) => setTop(e.nativeEvent.layout.height + e.nativeEvent.layout.y)} pointerEvents="box-none">
        <View style={m.topRow} pointerEvents="box-none">
          <Switch
            value={view}
            onChange={setView}
            options={[
              ["route", "This payment"],
              ["today", "Seen today"],
            ]}
          />
          <Pressable
            onPress={() => {
              buzz("tap");
              setLocate((n) => n + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel={c.here ? "Show where I am" : "Show the whole route"}
            accessibilityHint={c.here ? "Centres the map on this phone's rounded location" : "Fits the map to what is drawn on it"}
            style={({ pressed }) => [m.round, pressed && { backgroundColor: C.paper2 }]}
          >
            <Crosshair />
          </Pressable>
        </View>
        {canSaveOffline && cells.length ? <SaveOffline cells={cells} /> : null}
      </View>

      <View style={m.bottom} onLayout={(e) => setBottom(e.nativeEvent.layout.height)} pointerEvents="box-none">
        <View style={m.chips} pointerEvents="box-none">
          <Pressable
            onPress={ATTRIBUTION.url ? () => c.services.openUrl(ATTRIBUTION.url!) : undefined}
            disabled={!ATTRIBUTION.url}
            accessibilityRole={ATTRIBUTION.url ? "link" : "text"}
            accessibilityLabel={ATTRIBUTION.text}
            accessibilityHint={ATTRIBUTION.url ? "Opens the OpenStreetMap copyright page" : undefined}
            hitSlop={12}
            style={[m.chip, { flexShrink: 1, marginRight: 8 }]}
          >
            <Text style={m.chipText} numberOfLines={1}>{ATTRIBUTION.text}</Text>
          </Pressable>
          <Pressable
            onPress={c.turnOffMap}
            accessibilityRole="button"
            accessibilityLabel="Turn off the map"
            accessibilityHint="Stops adding this phone's place to payments it passes on"
            hitSlop={12}
            style={({ pressed }) => [m.chip, pressed && { backgroundColor: C.paper2 }]}
          >
            <Text style={[m.chipText, { fontWeight: "700" }]}>Turn off map</Text>
          </Pressable>
        </View>
        <Card style={m.card}>
          <View accessibilityLiveRegion="polite">
            {view === "route" ? (
              focus ? (
                <RouteCard key={focus.id} route={focus} me={me} mine={mine} onFocus={setFocusId} placeName={placeName} />
              ) : (
                <Empty />
              )
            ) : seen.length ? (
              <TodayCard routes={seen} />
            ) : (
              <Empty />
            )}
          </View>
        </Card>
      </View>
    </View>
  );
}

/** One route in words: the map's accessible label. */
function routeSpoken(r: Route, me: string, placeName?: (cell: Cell) => string | null) {
  const who = (k: string) => (k === me ? "you" : shorten(k));
  const parts = r.points.map((p) => {
    const place = placeName?.(p.cell);
    const where = place ? ` near ${place}` : "";
    if (p.kind === "sent") return `signed by ${who(p.who)} at ${hhmm(p.at)}${where}`;
    if (p.kind === "hop") return `handed to ${who(p.who)} at ${hhmm(p.at)}${where}`;
    return `settled at ${hhmm(p.at)}${where}`;
  });
  if (r.settled && !settledPoint(r)) parts.push("settled somewhere off the map");
  return `Map of ${r.amount} to ${who(r.to)}: ${parts.join(", ")}. About ${distanceText(routeMetres(r))} in all.`;
}

/** "Ama → Fr9T → You → settled at Labs": who held it, in order. */
function pathLine(r: Route, me: string, placeName?: (cell: Cell) => string | null) {
  const names: string[] = [];
  for (const p of r.points) {
    if (p.kind === "settled") continue;
    const n = p.who === me ? "You" : p.who.slice(0, 4);
    if (names[names.length - 1] !== n) names.push(n);
  }
  const s = settledPoint(r);
  if (r.settled) {
    const place = s ? placeName?.(s.cell) : null;
    names.push(place ? `settled at ${place}` : "settled");
  }
  return names.join(" → ");
}

function RouteCard({
  route,
  me,
  mine,
  onFocus,
  placeName,
}: {
  route: Route;
  me: string;
  mine: Route[];
  onFocus: (id: string) => void;
  placeName?: (cell: Cell) => string | null;
}) {
  const n = hands(route);
  const metres = routeMetres(route);
  const settle = settleState(route);
  const i = mine.indexOf(route);
  const to = route.to === me ? "you" : shorten(route.to);
  return (
    <View>
      <View style={m.head}>
        <View style={{ flex: 1 }}>
          <Text style={m.title} accessibilityRole="header" numberOfLines={1}>
            {route.amount} to {to}
          </Text>
          <Text style={m.sub} numberOfLines={2}>
            {pathLine(route, me, placeName)}
          </Text>
        </View>
        {mine.length > 1 ? (
          <View style={m.chooser}>
            <Step dir={-1} off={i <= 0} onPress={() => onFocus(mine[i - 1]!.id)} />
            <Text style={m.count} accessibilityLabel={`Payment ${i + 1} of ${mine.length}`}>
              {i + 1}/{mine.length}
            </Text>
            <Step dir={1} off={i >= mine.length - 1} onPress={() => onFocus(mine[i + 1]!.id)} />
          </View>
        ) : null}
      </View>
      <View style={m.stats}>
        <Stat spoken={`${n} ${n === 1 ? "hand" : "hands"}`} label={n === 1 ? "hand" : "hands"}>
          <CountUp value={n} format={(x) => String(Math.round(x))} style={m.statV} />
        </Stat>
        <Stat spoken={`${distanceText(metres)} travelled`} label="travelled">
          <CountUp value={metres} format={distanceText} delay={80} style={m.statV} />
        </Stat>
        {typeof settle === "object" ? (
          <Stat spoken={`${durationSpoken(settle.ms)} to settle`} label="to settle">
            <CountUp value={settle.ms / 60_000} format={(x) => durationText(x * 60_000)} delay={160} style={m.statV} />
          </Stat>
        ) : settle === "open" ? (
          <Stat spoken="Not settled yet" label="to settle">
            <Text style={[m.statV, m.statWait]}>not yet</Text>
          </Stat>
        ) : (
          // Settled, but this phone has no time for it: say so rather than guess one.
          <Stat
            spoken={settle === "elsewhere" ? "Settled somewhere off the map" : "Settled; how long it took is not known"}
            label={settle === "elsewhere" ? "off the map" : "time unknown"}
          >
            <Text style={[m.statV, m.statWait, { color: C.greenInk }]}>settled</Text>
          </Stat>
        )}
      </View>
    </View>
  );
}

/** Previous or next of your own routes. */
function Step({ dir, off, onPress }: { dir: 1 | -1; off: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={dir < 0 ? "Newer payment" : "Older payment"}
      accessibilityState={{ disabled: off }}
      hitSlop={6}
      style={({ pressed }) => [m.step, pressed && !off && { backgroundColor: C.rule }, off && { opacity: 0.4 }]}
    >
      <View style={[m.chev, { transform: [{ rotate: dir < 0 ? "-135deg" : "45deg" }] }]} />
    </Pressable>
  );
}

function TodayCard({ routes }: { routes: Route[] }) {
  const handoffs = routes.reduce((n, r) => n + r.points.filter((p) => p.kind === "hop").length, 0);
  const people = new Set(routes.flatMap((r) => r.points.filter((p) => p.kind !== "settled").map((p) => p.who))).size;
  const settled = routes.filter((r) => r.settled).length;
  return (
    <View>
      <Text style={m.title} accessibilityRole="header">
        Around here today
      </Text>
      <Text style={m.sub}>Payments this phone has seen pass hand to hand today, and where they reached signal</Text>
      <View style={m.stats}>
        <Stat spoken={`${handoffs} ${handoffs === 1 ? "handoff" : "handoffs"}`} label={handoffs === 1 ? "handoff" : "handoffs"}>
          <CountUp value={handoffs} format={(x) => String(Math.round(x))} style={m.statV} />
        </Stat>
        <Stat spoken={`${people} ${people === 1 ? "person" : "people"}`} label={people === 1 ? "person" : "people"}>
          <CountUp value={people} format={(x) => String(Math.round(x))} delay={80} style={m.statV} />
        </Stat>
        <Stat spoken={`${settled} settled`} label="settled">
          <CountUp value={settled} format={(x) => String(Math.round(x))} delay={160} style={[m.statV, { color: C.green }]} />
        </Stat>
      </View>
      <View style={m.legend} accessible accessibilityLabel="Key: dark dots are handoffs, amber is you, green is where a payment settled.">
        <Key colour={C.ink} text="Handoff" />
        <Key colour={C.slip} text="You" />
        <Key colour={C.green} text="Settled" />
      </View>
    </View>
  );
}

function Key({ colour, text }: { colour: string; text: string }) {
  return (
    <View style={m.key}>
      <View style={[m.keyDot, { backgroundColor: colour }]} />
      <Text style={m.keyText}>{text}</Text>
    </View>
  );
}

function Stat({ label, spoken, children }: { label: string; spoken: string; children: ReactNode }) {
  return (
    <View style={m.stat} accessible accessibilityLabel={spoken}>
      {children}
      <Text style={m.statK}>{label}</Text>
    </View>
  );
}

function Empty() {
  return (
    <View>
      <Text style={m.title} accessibilityRole="header">
        No handoffs with a place yet
      </Text>
      <Text style={m.sub}>Pass a slip with the map on and its route shows here.</Text>
    </View>
  );
}

/** Keep the map tiles round what is drawn, for no signal. Phone only; needs signal while it runs. */
function SaveOffline({ cells }: { cells: Cell[] }) {
  const [save, setSave] = useState<{ state: "idle" | "saving" | "done" | "failed"; pct: number }>({ state: "idle", pct: 0 });
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const start = () => {
    buzz("tap");
    setSave({ state: "saving", pct: 0 });
    saveArea(cells, (pct) => live.current && setSave({ state: "saving", pct }))
      .then(() => live.current && setSave({ state: "done", pct: 100 }))
      .catch(() => live.current && setSave({ state: "failed", pct: 0 }));
  };
  const text =
    save.state === "saving"
      ? `Saving map… ${Math.round(save.pct)}%`
      : save.state === "done"
        ? "Saved for offline"
        : save.state === "failed"
          ? "Couldn’t save. It needs signal"
          : "Save this area for offline";
  return (
    <Pressable
      onPress={save.state === "saving" ? undefined : start}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint="Downloads the map round these places so it still draws with no signal. Needs signal while it saves."
      accessibilityState={{ busy: save.state === "saving" }}
      accessibilityLiveRegion="polite"
      style={({ pressed }) => [m.save, pressed && { backgroundColor: C.paper2 }]}
    >
      <MapGlyph colour={save.state === "failed" ? C.red : C.ink} />
      <Text style={[m.saveText, save.state === "failed" && { color: C.red }]}>{text}</Text>
    </Pressable>
  );
}

/** The two views, as a white pill with a dark thumb that slides. */
function Switch({ options, value, onChange }: { options: readonly (readonly [MapView, string])[]; value: MapView; onChange: (v: MapView) => void }) {
  const reduced = useReducedMotion();
  const [w, setW] = useState(0);
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  const x = useRef(new Animated.Value(idx)).current;
  useEffect(() => {
    spring(x, idx, reduced, 3).start();
  }, [idx, reduced, x]);
  const each = w ? (w - 8) / options.length : 0;
  return (
    <View style={sw.track} accessibilityRole="radiogroup" accessibilityLabel="Show on the map" onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {each ? <Animated.View style={[sw.thumb, { width: each, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, each] }) }] }]} /> : null}
      {options.map(([v, text]) => (
        <Pressable
          key={v}
          onPress={() => {
            buzz("tap");
            onChange(v);
          }}
          accessibilityRole="radio"
          accessibilityState={{ checked: v === value }}
          accessibilityLabel={text}
          style={sw.btn}
        >
          <Text style={[sw.text, v === value && sw.on]}>{text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const sw = StyleSheet.create({
  track: { flex: 1, flexDirection: "row", backgroundColor: C.card, borderRadius: 16, padding: 4, ...SHADOW, shadowOpacity: 0.12 },
  thumb: { position: "absolute", top: 4, bottom: 4, left: 4, borderRadius: 12, backgroundColor: C.ink },
  btn: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center" },
  text: { fontFamily: FONT.face, fontSize: 15, fontWeight: "600", color: C.ink2 },
  on: { color: C.onInk },
});

/** Locate: a ring with four ticks and a dot. */
function Crosshair() {
  const tick = { position: "absolute" as const, backgroundColor: C.ink, borderRadius: 1 };
  return (
    <View style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: 13, height: 13, borderRadius: 7, borderWidth: 1.8, borderColor: C.ink, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: C.ink }} />
      </View>
      <View style={[tick, { top: 0, width: 1.8, height: 4 }]} />
      <View style={[tick, { bottom: 0, width: 1.8, height: 4 }]} />
      <View style={[tick, { left: 0, height: 1.8, width: 4 }]} />
      <View style={[tick, { right: 0, height: 1.8, width: 4 }]} />
    </View>
  );
}

// --- the map, off ------------------------------------------------------------------

/** Off until turned on: what the map shows, what it shares, and one button. */
function OptIn({ c }: { c: Carrier }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const turnOn = async () => {
    setBusy(true);
    setRefused(false);
    const ok = await c.turnOnMap().catch(() => false);
    setBusy(false);
    if (ok) buzz("success");
    else setRefused(true);
  };
  return (
    <View style={{ flex: 1 }}>
      <ScreenHead title="Map" sub="Where payments travel, hand to hand" />
      <ScrollView contentContainerStyle={m.body}>
        <Appear>
          <Card style={m.optCard}>
            <Sketch />
            <Text style={m.optTitle} accessibilityRole="header">
              See where your payments go
            </Text>
            <Text style={m.optBody}>
              The map draws each place a payment changed hands, who held it and when, and where it finally reached signal and settled.
            </Text>
            <View style={m.points}>
              <Point text="Places are rounded to about 100 m, so they name a building, not you." />
              <Point text="A payment’s places travel with its slip to the next phones, so they can draw the route too." />
              <Point text="It’s off until you turn it on, and you can turn it off at any time." />
            </View>
            <Button label="Turn on the map" hint="Asks for your location, rounded to about 100 m" onPress={turnOn} busy={busy} style={{ marginTop: 18 }} />
            {refused ? (
              <View style={m.refused} accessibilityLiveRegion="polite">
                <Text style={m.refusedText}>The map needs Location allowed for Carrier. You can allow it in settings.</Text>
                <Pressable onPress={c.services.openSettings} accessibilityRole="button" accessibilityHint="Opens settings for Carrier" style={m.link}>
                  <Text style={[m.linkText, { color: C.ink }]}>Open settings</Text>
                </Pressable>
              </View>
            ) : null}
          </Card>
        </Appear>
        <Note>While the map is off, nothing about where you are leaves this phone, and no other phone can put a place next to your key.</Note>
      </ScrollView>
    </View>
  );
}

function Point({ text }: { text: string }) {
  return (
    <View style={m.point}>
      <View style={m.bullet} />
      <Text style={m.pointText}>{text}</Text>
    </View>
  );
}

/** A small drawing of a route: three handoffs and a settle, on a folded map. Decorative. */
function Sketch() {
  const stops: [number, number, string, number][] = [
    [34, 24, C.ink, 14],
    [96, 50, C.ink, 14],
    [158, 30, C.slip, 16],
    [206, 62, C.green, 18],
  ];
  return (
    <View style={m.sketch} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={[m.sketchRoad, { top: 40, left: -10, right: -10, transform: [{ rotate: "-6deg" }] }]} />
      <View style={[m.sketchRoad, { left: 120, top: -10, width: 12, height: 110, transform: [{ rotate: "4deg" }] }]} />
      {stops.slice(1).map(([x2, y2], i) => {
        // a segment is a thin bar centred between two stops, turned to join them
        const [x1, y1] = stops[i]!;
        const len = Math.hypot(x2 - x1, y2 - y1);
        const deg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
        return <View key={i} style={[m.sketchLine, { left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1.5, width: len, transform: [{ rotate: `${deg}deg` }] }]} />;
      })}
      {stops.map(([x, y, colour, size]) => (
        <View
          key={`${x}`}
          style={{ position: "absolute", left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: size / 2, backgroundColor: colour, borderWidth: 2.5, borderColor: C.card }}
        />
      ))}
      <View style={m.sketchGlyph}>
        <MapGlyph colour={C.ink2} />
      </View>
    </View>
  );
}

const m = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.paper2, overflow: "hidden" },
  top: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 12, paddingTop: 12 },
  topRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  round: { width: TARGET + 4, height: TARGET + 4, borderRadius: R.pill, backgroundColor: C.card, alignItems: "center", justifyContent: "center", ...SHADOW, shadowOpacity: 0.12 },
  bottom: { position: "absolute", left: 12, right: 12, bottom: 10 },
  chips: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8, marginHorizontal: 4 },
  chip: { backgroundColor: C.card, borderRadius: R.pill, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontFamily: FONT.face, fontSize: 12, color: C.ink2 },
  save: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38, marginTop: 10, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.card, ...SHADOW, shadowOpacity: 0.12 },
  saveText: { fontFamily: FONT.face, fontSize: 13, fontWeight: "700", color: C.ink },
  card: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 16, ...SHADOW, shadowOpacity: 0.12, shadowRadius: 20 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { fontFamily: FONT.face, fontSize: 18, fontWeight: "700", color: C.ink, letterSpacing: -0.2 },
  sub: { fontFamily: FONT.face, fontSize: 14, lineHeight: 19, color: C.ink2, marginTop: 3 },
  chooser: { flexDirection: "row", alignItems: "center", gap: 2, marginRight: -6 },
  step: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.paper2, alignItems: "center", justifyContent: "center" },
  chev: { width: 8, height: 8, borderTopWidth: 2, borderRightWidth: 2, borderColor: C.ink },
  count: { fontFamily: FONT.face, fontSize: 12, fontWeight: "700", color: C.ink2, minWidth: 26, textAlign: "center" },
  stats: { flexDirection: "row", gap: 8, marginTop: 14 },
  stat: { flex: 1, backgroundColor: C.paper2, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  statV: { fontFamily: FONT.face, fontSize: 20, fontWeight: "800", letterSpacing: -0.3, color: C.ink },
  statWait: { fontSize: 16, lineHeight: 26, color: C.ink2 },
  statK: { fontFamily: FONT.face, fontSize: 12, fontWeight: "500", color: C.ink2, marginTop: 1 },
  legend: { flexDirection: "row", gap: 16, marginTop: 12 },
  key: { flexDirection: "row", alignItems: "center", gap: 6 },
  keyDot: { width: 10, height: 10, borderRadius: 5 },
  keyText: { fontFamily: FONT.face, fontSize: 12, fontWeight: "500", color: C.ink2 },
  link: { minHeight: TARGET, justifyContent: "center", paddingHorizontal: 2 },
  linkText: { fontFamily: FONT.face, fontSize: T.small, fontWeight: "700", color: C.ink2 },
  // opt-in
  body: { paddingHorizontal: S.gutter, paddingBottom: 32 },
  optCard: { padding: 20, marginTop: 8 },
  optTitle: { fontFamily: FONT.face, fontSize: 22, fontWeight: "800", letterSpacing: -0.4, color: C.ink, marginTop: 16 },
  optBody: { ...type.body, marginTop: 6 } as any,
  points: { gap: 10, marginTop: 14 },
  point: { flexDirection: "row", gap: 10 },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.slipDeep, marginTop: 8 },
  pointText: { flex: 1, fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink },
  refused: { marginTop: 12 },
  refusedText: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2 },
  sketch: { height: 88, borderRadius: 18, backgroundColor: C.paper2, overflow: "hidden" },
  sketchRoad: { position: "absolute", height: 12, backgroundColor: C.card },
  sketchLine: { position: "absolute", height: 3, borderRadius: 2, backgroundColor: C.slipDeep },
  sketchGlyph: { position: "absolute", right: 12, top: 10 },
});

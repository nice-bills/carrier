import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { C, R, S, SHADOW, T, TARGET, avatar } from "../theme";
import { hashNum } from "../format";
import { FONT } from "./fonts";

/**
 * The small set of objects every screen is built from: buttons, cards,
 * receipts, stamps, the key card, avatars and the bottom sheet. Nothing here
 * knows about payments.
 */

// --- motion -------------------------------------------------------------------

/** Forced value for reduced motion (the demo sets it); null follows the phone. */
export const MotionOverride = createContext<boolean | null>(null);

/** True when the person asked the phone for reduced motion. Animations become instant. */
export function useReducedMotion(): boolean {
  const forced = useContext(MotionOverride);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => live && setReduced(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => setReduced(v));
    return () => {
      live = false;
      sub?.remove?.();
    };
  }, []);
  return forced ?? reduced;
}

/** Say something to a screen reader, without moving focus. */
export function announce(text: string) {
  try {
    AccessibilityInfo.announceForAccessibility(text);
  } catch {
    // not available (web preview without a screen reader): nothing to do
  }
}

/**
 * A short buzz for the moments you should feel: a slip landing in your pocket,
 * signing, a settlement. Haptics are not motion, so reduced motion keeps them.
 */
export function buzz(kind: "tap" | "land" | "success") {
  try {
    if (kind === "tap") Vibration.vibrate(12);
    else if (kind === "land") Vibration.vibrate([0, 18, 70, 30]);
    else Vibration.vibrate([0, 22, 90, 45]);
  } catch {
    // no vibrator (web preview): nothing to do
  }
}

/** Springs for things that land, and a quick ease for everything else. */
export const spring = (v: Animated.Value, toValue: number, reduced: boolean, bounciness = 7) =>
  reduced
    ? Animated.timing(v, { toValue, duration: 0, useNativeDriver: true })
    : Animated.spring(v, { toValue, useNativeDriver: true, speed: 14, bounciness });

export const ease = (v: Animated.Value, toValue: number, reduced: boolean, duration = 260, delay = 0) =>
  Animated.timing(v, {
    toValue,
    duration: reduced ? 0 : duration,
    delay: reduced ? 0 : delay,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  });

/** Fades and lifts its children in once, on mount. */
export function Appear({ delay = 0, from = 12, children, style }: { delay?: number; from?: number; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const p = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    ease(p, 1, reduced, 320, delay).start();
  }, [p, reduced, delay]);
  return (
    <Animated.View style={[style, { opacity: p, transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
}

/** A number that counts up to its value when it first shows. */
export function CountUp({ value, format, duration = 900, delay = 0, style }: { value: number; format: (n: number) => string; duration?: number; delay?: number; style?: StyleProp<any> }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) {
      setShown(value);
      return;
    }
    const v = new Animated.Value(0);
    const id = v.addListener(({ value: x }) => setShown(x));
    Animated.timing(v, { toValue: value, duration, delay, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    return () => v.removeListener(id);
  }, [value, reduced, duration, delay]);
  return <Text style={style}>{format(shown)}</Text>;
}

/** The green "listening" dot, with a ring that keeps rippling out while it is live. */
export function LiveDot({ on }: { on: boolean }) {
  const reduced = useReducedMotion();
  const r = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on || reduced) {
      r.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(r, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [on, reduced, r]);
  return (
    <View style={ld.box}>
      {on && !reduced ? (
        <Animated.View
          style={[
            ld.ring,
            { opacity: r.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }), transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }] },
          ]}
        />
      ) : null}
      <View style={[ld.dot, on ? ld.on : ld.off]} />
    </View>
  );
}

const ld = StyleSheet.create({
  box: { width: 10, height: 10, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: C.green },
  dot: { width: 10, height: 10, borderRadius: 5 },
  on: { backgroundColor: C.green },
  off: { borderWidth: 1.5, borderColor: C.outline },
});

// --- text ---------------------------------------------------------------------

export const type = StyleSheet.create({
  title: { fontFamily: FONT.face, fontSize: T.title, fontWeight: "800", letterSpacing: -0.8, color: C.ink, lineHeight: 38 },
  sub: { fontFamily: FONT.face, fontSize: 15, color: C.ink2, marginTop: 4 },
  body: { fontFamily: FONT.face, fontSize: T.body, lineHeight: 23, color: C.ink2 },
  strong: { fontFamily: FONT.face, fontSize: T.body, fontWeight: "700", color: C.ink },
  small: { fontFamily: FONT.face, fontSize: T.small, lineHeight: 20, color: C.ink2 },
  label: { fontFamily: FONT.face, fontSize: 12, fontWeight: "700", letterSpacing: 0.8, color: C.ink3, textTransform: "uppercase" },
  mono: { fontFamily: FONT.mono },
});

/** A screen's title and one line under it. */
export function ScreenHead({ title, sub, aside }: { title: string; sub?: string; aside?: ReactNode }) {
  return (
    <View style={hdr.bar}>
      <View style={{ flex: 1 }}>
        <Text style={type.title} accessibilityRole="header">
          {title}
        </Text>
        {sub ? <Text style={type.sub}>{sub}</Text> : null}
      </View>
      {aside}
    </View>
  );
}

const hdr = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: S.gutter, paddingTop: 14, paddingBottom: 10 },
});

// --- buttons ------------------------------------------------------------------

type Variant = "primary" | "quiet" | "danger" | "go";

/** Shrinks a touch while pressed. */
function usePress(reduced: boolean) {
  const s = useRef(new Animated.Value(1)).current;
  return {
    scale: s,
    onPressIn: () => spring(s, 0.97, reduced, 0).start(),
    onPressOut: () => spring(s, 1, reduced, 6).start(),
  };
}

export function Button({
  label,
  hint,
  onPress,
  variant = "primary",
  disabled,
  busy,
  children,
  style,
  icon,
}: {
  label: string;
  hint?: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  /** Visible content, when it differs from the spoken label. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  icon?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const press = usePress(reduced);
  const off = disabled || busy;
  const quiet = variant === "quiet";
  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, style]}>
      <Pressable
        onPress={off ? undefined : onPress}
        onPressIn={off ? undefined : press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: !!off, busy: !!busy }}
        hitSlop={4}
        style={({ pressed }) => [
          btn.base,
          quiet && btn.quiet,
          variant === "danger" && btn.danger,
          variant === "go" && btn.go,
          disabled && !busy && btn.disabled,
          pressed && !off && (quiet ? btn.quietPressed : btn.pressed),
        ]}
      >
        {busy ? (
          <ActivityIndicator color={quiet ? C.ink : C.onInk} />
        ) : (
          <View style={btn.inner}>
            {icon}
            <Text style={[btn.text, quiet && btn.quietText, disabled && btn.disabledText]} numberOfLines={2}>
              {children ?? label}
            </Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/**
 * Press and hold to confirm: for signing money away, so a stray tap cannot.
 * The fill grows while held and drains if let go early. A screen reader's
 * activate action confirms at once, since it cannot hold.
 */
export function HoldButton({
  label,
  holdingLabel = "Keep holding…",
  doneLabel = "Signed",
  hint,
  onConfirm,
  busy,
  disabled,
  children,
  ms = 900,
}: {
  label: string;
  holdingLabel?: string;
  doneLabel?: string;
  hint?: string;
  onConfirm: () => void;
  busy?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  ms?: number;
}) {
  const fill = useRef(new Animated.Value(0)).current;
  const [state, setState] = useState<"idle" | "holding" | "done">("idle");
  const [w, setW] = useState(0);
  const run = useRef<Animated.CompositeAnimation | null>(null);
  const off = disabled || busy;
  // One confirm per fill, whichever way it came (hold or screen reader).
  const fired = useRef(false);
  const confirm = () => {
    if (fired.current) return;
    fired.current = true;
    setState("done");
    buzz("success");
    onConfirm();
  };
  const start = () => {
    if (off || state === "done" || fired.current) return;
    setState("holding");
    buzz("tap");
    run.current = Animated.timing(fill, { toValue: 1, duration: ms * (1 - (fill as any)._value), easing: Easing.linear, useNativeDriver: false });
    run.current.start(({ finished }) => {
      if (finished) confirm();
    });
  };
  const stop = () => {
    if (state !== "holding") return;
    run.current?.stop();
    setState("idle");
    Animated.timing(fill, { toValue: 0, duration: 220, useNativeDriver: false }).start();
  };
  useEffect(() => {
    if (!busy && state === "done") {
      // stay filled while the parent finishes; reset if it comes back to us
      const t = setTimeout(() => {
        setState("idle");
        fill.setValue(0);
        fired.current = false;
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [busy, state, fill]);
  const text = state === "done" ? doneLabel : state === "holding" ? holdingLabel : null;
  return (
    <Pressable
      onPressIn={start}
      onPressOut={stop}
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint ?? "Press and hold to confirm"}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName !== "activate" || off || state !== "idle") return;
        fill.setValue(1);
        confirm();
      }}
      style={[btn.base, btn.hold, off && btn.disabled]}
    >
      <Animated.View style={[btn.holdFill, { width: fill.interpolate({ inputRange: [0, 1], outputRange: [0, w || 400] }) }]} />
      {busy ? (
        <ActivityIndicator color={C.onInk} />
      ) : (
        <Text style={[btn.text, off && btn.disabledText]} numberOfLines={2}>
          {text ?? children ?? label}
        </Text>
      )}
    </Pressable>
  );
}

/** A plain text action, still 48dp tall. */
export function LinkButton({ label, hint, onPress, color = C.ink2 }: { label: string; hint?: string; onPress: () => void; color?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => [btn.link, pressed && { opacity: 0.6 }]}
    >
      <Text style={[btn.linkText, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** A small round-ended button, for a screen's header ("Pay"). */
export function PillButton({ label, hint, onPress, icon }: { label: string; hint?: string; onPress: () => void; icon?: ReactNode }) {
  const reduced = useReducedMotion();
  const press = usePress(reduced);
  return (
    <Animated.View style={{ transform: [{ scale: press.scale }] }}>
      <Pressable
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={({ pressed }) => [btn.pill, pressed && btn.pressed]}
      >
        {icon}
        <Text style={btn.pillText}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

/** A plus, drawn with two bars. */
export function Plus({ colour = C.onInk }: { colour?: string }) {
  return (
    <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: 14, height: 2.2, borderRadius: 1, backgroundColor: colour }} />
      <View style={{ position: "absolute", width: 2.2, height: 14, borderRadius: 1, backgroundColor: colour }} />
    </View>
  );
}

const btn = StyleSheet.create({
  base: {
    minHeight: 54,
    paddingHorizontal: 18,
    borderRadius: R.box,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  inner: { flexDirection: "row", alignItems: "center", gap: 8 },
  pressed: { backgroundColor: C.ink2 },
  quiet: { backgroundColor: C.card, borderWidth: 1.5, borderColor: C.rule },
  quietPressed: { backgroundColor: C.paper2 },
  danger: { backgroundColor: C.red },
  go: { backgroundColor: C.green },
  disabled: { backgroundColor: C.paper2, borderWidth: 0 },
  hold: {},
  holdFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: C.green },
  text: { fontFamily: FONT.face, color: C.onInk, fontSize: 16, fontWeight: "700", textAlign: "center" },
  quietText: { color: C.ink },
  disabledText: { color: C.ink3 },
  link: { minHeight: TARGET, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { fontFamily: FONT.face, fontSize: T.small, fontWeight: "700" },
  pill: { minHeight: 44, paddingHorizontal: 16, borderRadius: R.pill, backgroundColor: C.ink, flexDirection: "row", alignItems: "center", gap: 7 },
  pillText: { fontFamily: FONT.face, color: C.onInk, fontSize: 15, fontWeight: "700" },
});

/**
 * A row of mutually exclusive choices, as pills. The dark pill slides to the
 * chosen one.
 */
export function Picks<V extends string | number>({
  options,
  value,
  onChange,
  label,
  render,
}: {
  options: readonly V[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  render: (v: V) => { text: string; small?: string; spoken: string };
}) {
  const reduced = useReducedMotion();
  const [w, setW] = useState(0);
  const idx = Math.max(0, options.indexOf(value));
  const x = useRef(new Animated.Value(idx)).current;
  useEffect(() => {
    spring(x, idx, reduced, 4).start();
  }, [idx, reduced, x]);
  const GAP = 8;
  const each = w ? (w - GAP * (options.length - 1)) / options.length : 0;
  return (
    <View style={pk.row} accessibilityRole="radiogroup" accessibilityLabel={label} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {options.map((o) => (
        <View key={`bg${String(o)}`} style={pk.well} />
      ))}
      {each ? (
        <Animated.View
          style={[pk.ind, { width: each, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, each + GAP] }) }] }]}
        />
      ) : null}
      <View style={[StyleSheet.absoluteFill, pk.row]}>
        {options.map((o) => {
          const r = render(o);
          const on = o === value;
          return (
            <Pressable
              key={String(o)}
              onPress={() => {
                buzz("tap");
                onChange(o);
              }}
              accessibilityRole="radio"
              accessibilityLabel={r.spoken}
              accessibilityState={{ checked: on }}
              style={pk.pick}
            >
              <Text style={[pk.text, on && pk.onText]}>{r.text}</Text>
              {r.small ? <Text style={[pk.small, on && pk.onText]}>{r.small}</Text> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const pk = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, minHeight: 48 },
  well: { flex: 1, minHeight: 48, borderRadius: R.pill, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.rule },
  ind: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: R.pill, backgroundColor: C.ink },
  pick: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center" },
  text: { fontFamily: FONT.face, fontWeight: "700", fontSize: 15, color: C.ink },
  small: { fontFamily: FONT.face, fontWeight: "600", fontSize: 11, color: C.ink2, letterSpacing: 0.4 },
  onText: { color: C.onInk },
});

/** Two or three views of one list, with a sliding white thumb. */
export function Segmented<V extends string>({ options, value, onChange, label }: { options: readonly (readonly [V, string])[]; value: V; onChange: (v: V) => void; label: string }) {
  const reduced = useReducedMotion();
  const [w, setW] = useState(0);
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  const x = useRef(new Animated.Value(idx)).current;
  useEffect(() => {
    spring(x, idx, reduced, 3).start();
  }, [idx, reduced, x]);
  const each = w ? (w - 8) / options.length : 0;
  return (
    <View style={sg.track} accessibilityRole="radiogroup" accessibilityLabel={label} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {each ? (
        <Animated.View style={[sg.thumb, { width: each, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, each] }) }] }]} />
      ) : null}
      {options.map(([v, text]) => (
        <Pressable
          key={v}
          onPress={() => onChange(v)}
          accessibilityRole="radio"
          accessibilityState={{ checked: v === value }}
          accessibilityLabel={text}
          style={sg.btn}
        >
          <Text style={[sg.text, v === value && sg.on]}>{text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const sg = StyleSheet.create({
  track: { flexDirection: "row", backgroundColor: C.paper2, borderRadius: 14, padding: 4 },
  thumb: { position: "absolute", top: 4, bottom: 4, left: 4, borderRadius: 11, backgroundColor: C.card, ...SHADOW, shadowOpacity: 0.08 },
  btn: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center" },
  text: { fontFamily: FONT.face, fontSize: 15, fontWeight: "600", color: C.ink2 },
  on: { color: C.ink },
});

// --- section head ---------------------------------------------------------------

export function Head({ title, aside, onAside, asideHint }: { title: string; aside?: string; onAside?: () => void; asideHint?: string }) {
  return (
    <View style={hd.row}>
      <Text style={hd.title} accessibilityRole="header">
        {title}
      </Text>
      {aside && onAside ? (
        <LinkButton label={aside} hint={asideHint} onPress={onAside} />
      ) : aside ? (
        <Text style={hd.aside}>{aside}</Text>
      ) : null}
    </View>
  );
}

const hd = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 24, marginBottom: 8, minHeight: 32, paddingHorizontal: 4 },
  title: { fontFamily: FONT.face, fontSize: T.head, fontWeight: "700", color: C.ink },
  aside: { fontFamily: FONT.face, fontSize: T.small, fontWeight: "600", color: C.ink2 },
});

// --- cards --------------------------------------------------------------------

/** A white card, lifted a little off the page. */
export function Card({ children, style, pad = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; pad?: boolean }) {
  return <View style={[cd.card, pad && cd.pad, style]}>{children}</View>;
}

const cd = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: R.card, ...SHADOW },
  pad: { padding: 18 },
});

/** A grey note with an "i": context that matters but is not the point. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <View style={nt.box}>
      <View style={nt.i}>
        <Text style={nt.iText}>i</Text>
      </View>
      <Text style={nt.text}>{children}</Text>
    </View>
  );
}

const nt = StyleSheet.create({
  box: { flexDirection: "row", gap: 10, backgroundColor: C.paper2, borderRadius: 18, padding: 14, marginTop: 12 },
  i: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: C.ink2, alignItems: "center", justifyContent: "center", marginTop: 1 },
  iText: { fontFamily: FONT.face, fontSize: 12, fontWeight: "800", color: C.ink2, lineHeight: 14 },
  text: { flex: 1, fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2 },
});

/**
 * Anything that is a record: what you signed, who was paid, the pouch. A card
 * of label and value rows.
 */
export function Receipt({ title, subtitle, children, style }: { title?: string; subtitle?: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[rc.card, style]}>
      {title ? (
        <Text style={rc.title} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {subtitle ? <Text style={rc.sub}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

export function Rule() {
  return <View style={rc.rule} />;
}

export function Row({ label, value, tone, spoken, last }: { label: string; value: string; tone?: "earned" | "error"; spoken?: string; last?: boolean }) {
  return (
    <View style={[rc.row, last && { borderBottomWidth: 0 }]} accessible accessibilityLabel={spoken ?? `${label}: ${value}`}>
      <Text style={rc.dt}>{label}</Text>
      <Text style={[rc.dd, tone === "earned" && { color: C.paidInk }, tone === "error" && { color: C.red }]}>{value}</Text>
    </View>
  );
}

const rc = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: R.card - 4, paddingHorizontal: 18, paddingTop: 6, paddingBottom: 6, ...SHADOW },
  title: { ...type.label, marginTop: 10, marginBottom: 2 } as any,
  sub: { fontFamily: FONT.face, fontSize: 12, color: C.ink3, marginBottom: 2 },
  rule: { height: 1, backgroundColor: C.rule, marginVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minHeight: 44, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.rule },
  dt: { fontFamily: FONT.face, fontSize: 15, color: C.ink2, flexShrink: 1 },
  dd: { fontFamily: FONT.face, fontSize: 15, fontWeight: "700", color: C.ink, flexShrink: 0, textAlign: "right" },
});

// --- stamps -----------------------------------------------------------------------

/**
 * One per handoff, in red rubber-stamp ink. The row of them on a slip IS the
 * co-signed hop lineage. Angle comes from the key, so the same stamp always
 * lands the same way. Decorative: the slip says the same thing in words.
 * A `fresh` stamp thuds on: big and faint, then down to size.
 */
export function Stamp({ top, mid, bottom, seed, yours, size = 58, fresh }: { top: string; mid: string; bottom: string; seed: string; yours?: boolean; size?: number; fresh?: boolean }) {
  const reduced = useReducedMotion();
  const rot = yours ? 0 : (hashNum(seed) % 20) - 10;
  const colour = yours ? C.slipInk2 : C.stampInk;
  const thud = useRef(new Animated.Value(fresh && !reduced ? 0 : 1)).current;
  useEffect(() => {
    if (!fresh || reduced) return;
    Animated.timing(thud, { toValue: 1, duration: 280, delay: 420, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
  }, [fresh, reduced, thud]);
  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        st.ring,
        { width: size, height: size, borderRadius: size / 2, borderColor: colour },
        yours && { borderStyle: "dashed", opacity: 0.6 },
        {
          opacity: fresh ? thud.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] }) : yours ? 0.6 : 1,
          transform: [{ rotate: `${rot}deg` }, { scale: thud.interpolate({ inputRange: [0, 1], outputRange: [2, 1] }) }],
        },
      ]}
    >
      <Text style={[st.top, { color: colour }]} numberOfLines={1}>
        {top}
      </Text>
      <Text style={[st.mid, { color: colour }]}>{mid}</Text>
      <Text style={[st.bottom, { color: colour }]}>{bottom}</Text>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  ring: { borderWidth: 2, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" },
  top: { fontFamily: FONT.mono, fontSize: 10, fontWeight: "700", maxWidth: 46 },
  mid: { fontFamily: FONT.mono, fontSize: 11, fontWeight: "700" },
  bottom: { fontFamily: FONT.mono, fontSize: 8, fontWeight: "700", letterSpacing: 0.6 },
});

/** SETTLED, slammed on in green. With reduced motion it is simply there. */
export function SettledStamp({ size = 20, animate = true }: { size?: number; animate?: boolean }) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(animate && !reduced ? 2.2 : 1)).current;
  const opacity = useRef(new Animated.Value(animate && !reduced ? 0 : 1)).current;
  useEffect(() => {
    if (!animate || reduced) {
      scale.setValue(1);
      opacity.setValue(1);
      return;
    }
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 170, useNativeDriver: true }),
    ]).start();
  }, [animate, reduced, scale, opacity]);
  return (
    <Animated.View accessible accessibilityLabel="Settled" style={[ss.box, { opacity, transform: [{ rotate: "-8deg" }, { scale }] }]}>
      <Text style={[ss.text, { fontSize: size }]}>SETTLED</Text>
    </Animated.View>
  );
}

const ss = StyleSheet.create({
  box: { borderWidth: 2.5, borderColor: C.paidInk, borderRadius: 10, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 3, alignSelf: "center", backgroundColor: "rgba(255,255,255,0.3)" },
  text: { fontFamily: FONT.mono, fontWeight: "700", color: C.paidInk, letterSpacing: 2 },
});

/**
 * The settle check: a green disc that pops in, a tick that draws itself and
 * two soft rings rippling out.
 */
export function CheckBurst({ size = 72 }: { size?: number }) {
  const reduced = useReducedMotion();
  const pop = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const tick = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const r1 = useRef(new Animated.Value(0)).current;
  const r2 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    Animated.sequence([
      spring(pop, 1, false, 12),
      Animated.parallel([
        Animated.timing(tick, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(r1, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(r2, { toValue: 1, duration: 900, delay: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start();
  }, [reduced, pop, tick, r1, r2]);
  const ring = (v: Animated.Value) => (
    <Animated.View
      style={[
        cb.ring,
        { width: size, height: size, borderRadius: size / 2 },
        { opacity: v.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 0.35, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }] },
      ]}
    />
  );
  const arm = size * 0.14;
  return (
    <View style={{ width: size, height: size, alignSelf: "center", alignItems: "center", justifyContent: "center" }} accessible accessibilityLabel="Settled">
      {ring(r1)}
      {ring(r2)}
      <Animated.View style={[cb.disc, { width: size, height: size, borderRadius: size / 2, transform: [{ scale: pop }] }]}>
        {/* the tick: a short and a long bar, revealed left to right */}
        <Animated.View style={{ opacity: tick, transform: [{ scale: tick.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }, { translateY: -size * 0.03 }, { rotate: "-45deg" }] }}>
          <View style={{ width: arm * 2.6, height: arm * 1.4, borderLeftWidth: size * 0.065, borderBottomWidth: size * 0.065, borderColor: C.onInk, borderBottomLeftRadius: 2 }} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const cb = StyleSheet.create({
  ring: { position: "absolute", backgroundColor: C.green },
  disc: { backgroundColor: C.green, alignItems: "center", justifyContent: "center" },
});

/** A small rounded tag: IN RANGE, FOR THEM, ALLOWED. Always words, never colour alone. */
export function Mark({ text, colour, tone }: { text: string; colour?: string; rotate?: number; tone?: "green" | "amber" | "red" | "grey" }) {
  const t =
    tone === "green"
      ? { bg: C.greenSoft, fg: C.greenInk }
      : tone === "amber"
        ? { bg: C.amberSoft, fg: C.amberInk }
        : tone === "red"
          ? { bg: C.redSoft, fg: C.redInk }
          : tone === "grey"
            ? { bg: C.paper2, fg: C.ink2 }
            : { bg: "transparent", fg: colour ?? C.ink };
  return (
    <View style={[mk.box, { backgroundColor: t.bg }, !tone && { borderWidth: 1.5, borderColor: t.fg }]}>
      <Text style={[mk.text, { color: t.fg }]}>{text}</Text>
    </View>
  );
}

const mk = StyleSheet.create({
  box: { borderRadius: R.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" },
  text: { fontFamily: FONT.face, fontWeight: "700", fontSize: 12 },
});

// --- avatar -------------------------------------------------------------------------

export function Avatar({ text, met, you, size = 44 }: { text: string; met?: boolean; you?: boolean; size?: number }) {
  const a = avatar(!!met && !you);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        av.base,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: a.backgroundColor, borderColor: a.borderColor },
        you && { backgroundColor: C.slip, borderColor: C.slip },
      ]}
    >
      <Text style={[av.text, { color: you ? C.slipInk : a.color, fontSize: size * 0.32 }]}>{text}</Text>
    </View>
  );
}

const av = StyleSheet.create({
  base: { borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  text: { fontFamily: FONT.face, fontWeight: "700" },
});

// --- key card -------------------------------------------------------------------------

/**
 * The device key, with a 7x7 identicon so two keys can be told apart at a
 * glance, and the key itself in groups of four.
 */
export function KeyTag({ keyText, making }: { keyText: string | null; making?: boolean }) {
  if (!keyText && !making) {
    return (
      <View style={kt.blank}>
        <Text style={type.small}>No key on this phone yet.</Text>
      </View>
    );
  }
  const bits: boolean[] = [];
  if (keyText) {
    let h = 2166136261;
    for (let i = 0; i < 28; i += 1) {
      h ^= keyText.charCodeAt(i % keyText.length) + i;
      h = Math.imul(h, 16777619) >>> 0;
      bits.push(((h >>> 7) & 1) === 1);
    }
  }
  const groups = keyText ? keyText.match(/.{1,4}/g) ?? [] : [];
  return (
    <View
      style={kt.card}
      accessible
      accessibilityLabel={keyText ? `This phone's key: ${keyText}. Kept in this phone's secure storage.` : "Making this phone's key"}
      accessibilityLiveRegion="polite"
    >
      <Text style={type.label}>This phone’s key</Text>
      {keyText ? (
        <Appear from={6}>
          <View style={kt.row}>
            <View style={kt.ident}>
              {Array.from({ length: 49 }, (_, i) => {
                const y = Math.floor(i / 7);
                const x = i % 7;
                const on = bits[y * 4 + (x < 4 ? x : 6 - x)];
                return <View key={i} style={[kt.cell, on && { backgroundColor: C.ink }]} />;
              })}
            </View>
            <Text style={kt.key}>{groups.join(" ")}</Text>
          </View>
        </Appear>
      ) : (
        <ActivityIndicator color={C.ink} style={{ alignSelf: "flex-start", marginVertical: 14 }} />
      )}
      <Text style={kt.where}>Kept in this phone’s secure storage</Text>
    </View>
  );
}

const kt = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: R.card, padding: 18, ...SHADOW },
  blank: { borderRadius: R.card, backgroundColor: C.paper2, padding: 20, minHeight: 96, justifyContent: "center" },
  row: { flexDirection: "row", gap: 14, alignItems: "center", marginTop: 12 },
  ident: { width: 56, height: 56, flexDirection: "row", flexWrap: "wrap", borderRadius: 12, overflow: "hidden", backgroundColor: C.identWell, padding: 4 },
  cell: { width: "14.28%", height: "14.28%", borderRadius: 1.5 },
  key: { flex: 1, fontFamily: FONT.mono, fontSize: 13, lineHeight: 20, fontWeight: "600", color: C.ink },
  where: { fontFamily: FONT.face, fontSize: 13, color: C.ink2, marginTop: 12 },
});

// --- sheet ------------------------------------------------------------------------------

/**
 * A bottom sheet on the page colour, springing up over a scrim. The scrim is
 * the one translucent thing in the app, and nothing is ever written on it.
 * Android's back button and a tap on the scrim both close it; with reduced
 * motion it appears in place.
 */
export function Sheet({
  visible,
  onClose,
  title,
  lede,
  children,
  tall,
  hero,
  center,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  tall?: boolean;
  /** Drawn above the title (the settle check). */
  hero?: ReactNode;
  center?: boolean;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(visible);
  const y = useRef(new Animated.Value(visible ? 0 : 1)).current;
  const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    if (visible) {
      setShown(true);
      y.setValue(1);
      fade.setValue(0);
      Animated.parallel([ease(fade, 1, reduced, 220), spring(y, 0, reduced, 4)]).start();
    } else if (shown) {
      Animated.parallel([ease(fade, 0, reduced, 200), ease(y, 1, reduced, 220)]).start(({ finished }) => finished && setShown(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduced]);
  return (
    <Modal visible={shown} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={sh.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fade }]}>
          <Pressable
            style={sh.scrim}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            accessibilityHint="Closes this sheet without doing anything"
          />
        </Animated.View>
        <Animated.View
          style={[sh.sheet, tall && sh.tall, { transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [0, 700] }) }] }]}
          accessibilityViewIsModal
        >
          <View style={sh.grab} />
          <ScrollView contentContainerStyle={sh.body} keyboardShouldPersistTaps="handled">
            {hero}
            <Text style={[sh.title, center && sh.center]} accessibilityRole="header">
              {title}
            </Text>
            {lede ? <Text style={[sh.lede, center && sh.center]}>{lede}</Text> : null}
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const sh = StyleSheet.create({
  fill: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.paper,
    borderTopLeftRadius: R.sheet,
    borderTopRightRadius: R.sheet,
    maxHeight: "92%",
  },
  tall: { height: "92%" },
  grab: { width: 40, height: 5, borderRadius: 3, backgroundColor: C.ruleStrong, alignSelf: "center", marginTop: 10 },
  body: { paddingHorizontal: S.gutter, paddingTop: 16, paddingBottom: 30 },
  title: { fontFamily: FONT.face, fontSize: T.sheetTitle, fontWeight: "800", letterSpacing: -0.5, color: C.ink, marginBottom: 6, lineHeight: 31 },
  lede: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2, marginBottom: 16 },
  center: { textAlign: "center" },
});

/** Stack of actions at the bottom of a screen or sheet. */
export function Dock({ children }: { children: ReactNode }) {
  return <View style={{ gap: 10, paddingTop: 16 }}>{children}</View>;
}

/** A numbered tip in a card: one at a time, dismissable. */
export function Coach({ n, text, onDone }: { n: number; text: string; onDone: () => void }) {
  return (
    <Appear>
      <View style={co.note} accessibilityRole="summary">
        <View style={co.row}>
          <View style={co.n}>
            <Text style={co.nText}>{n}</Text>
          </View>
          <Text style={co.text}>{text}</Text>
        </View>
        <View style={{ paddingLeft: 38 }}>
          <LinkButton label="Got it, stop the tips" hint="Hides these tips for good" onPress={onDone} />
        </View>
      </View>
    </Appear>
  );
}

const co = StyleSheet.create({
  note: { backgroundColor: C.card, borderRadius: R.card - 4, paddingHorizontal: 16, paddingTop: 14, marginBottom: 14, ...SHADOW },
  row: { flexDirection: "row", gap: 12 },
  n: { width: 26, height: 26, borderRadius: 13, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center" },
  nText: { fontFamily: FONT.face, fontSize: 13, fontWeight: "800", color: C.amberInk },
  text: { flex: 1, fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink },
});

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { C, R, S, T, TARGET, avatar } from "../theme";
import { hashNum } from "../format";
import { FONT } from "./fonts";

/**
 * The small set of objects every screen is built from: buttons, receipts,
 * stamps, the key tag, avatars and the bottom sheet. Nothing here knows about
 * payments; it only knows how paper, ink and stamps look.
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

// --- text ---------------------------------------------------------------------

export const type = StyleSheet.create({
  title: { fontFamily: FONT.face, fontSize: T.title, fontWeight: "800", letterSpacing: -1, color: C.ink, lineHeight: 34 },
  sub: { fontFamily: FONT.face, fontSize: T.small, color: C.ink2, marginTop: 4 },
  body: { fontFamily: FONT.face, fontSize: T.body, lineHeight: 23, color: C.ink2 },
  strong: { fontFamily: FONT.face, fontSize: T.body, fontWeight: "700", color: C.ink },
  small: { fontFamily: FONT.face, fontSize: T.small, lineHeight: 20, color: C.ink2 },
  mono: { fontFamily: FONT.mono },
  hand: { fontFamily: FONT.hand, fontWeight: "700", color: C.red, fontSize: 17 },
});

// --- buttons ------------------------------------------------------------------

type Variant = "primary" | "quiet" | "danger";

export function Button({
  label,
  hint,
  onPress,
  variant = "primary",
  disabled,
  busy,
  children,
  style,
}: {
  label: string;
  hint?: string;
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  /** Visible content, when it differs from the spoken label (an amount in mono). */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      hitSlop={4}
      style={({ pressed }) => [
        btn.base,
        variant === "quiet" && btn.quiet,
        variant === "danger" && btn.danger,
        disabled && !busy && btn.disabled,
        pressed && !off && (variant === "quiet" ? btn.quietPressed : btn.pressed),
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === "quiet" ? C.ink : C.onInk} />
      ) : (
        <Text
          style={[btn.text, variant === "quiet" && btn.quietText, disabled && btn.disabledText]}
          numberOfLines={2}
        >
          {children ?? label}
        </Text>
      )}
    </Pressable>
  );
}

/** Underlined text action, still 48dp tall. */
export function LinkButton({ label, hint, onPress, color = C.ink }: { label: string; hint?: string; onPress: () => void; color?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={({ pressed }) => [btn.link, pressed && { opacity: 0.7 }]}
    >
      <Text style={[btn.linkText, { color }]}>{label}</Text>
    </Pressable>
  );
}

const btn = StyleSheet.create({
  base: {
    minHeight: 54,
    paddingHorizontal: 18,
    borderRadius: R.box,
    borderWidth: 2,
    borderColor: C.ink,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: C.ink2, borderColor: C.ink2 },
  quiet: { backgroundColor: "transparent", borderColor: C.ink3 },
  quietPressed: { backgroundColor: C.paper2 },
  danger: { backgroundColor: C.red, borderColor: C.red },
  disabled: { backgroundColor: "transparent", borderColor: C.ink3, borderStyle: "dashed" },
  text: { fontFamily: FONT.face, color: C.onInk, fontSize: 17, fontWeight: "800", textAlign: "center" },
  quietText: { color: C.ink },
  disabledText: { color: C.ink3 },
  link: { minHeight: TARGET, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { fontFamily: FONT.face, fontSize: T.small, fontWeight: "700", textDecorationLine: "underline" },
});

/** A row of mutually exclusive choices, each a 48dp button that says whether it is chosen. */
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
  return (
    <View style={pk.row} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o, i) => {
        const r = render(o);
        const on = o === value;
        return (
          <Pressable
            key={String(o)}
            onPress={() => onChange(o)}
            accessibilityRole="radio"
            accessibilityLabel={r.spoken}
            accessibilityState={{ checked: on }}
            style={[pk.pick, on && pk.on, { transform: [{ rotate: i % 2 ? "2deg" : "-2deg" }] }]}
          >
            <Text style={[pk.text, on && pk.onText]}>{r.text}</Text>
            {r.small ? <Text style={[pk.small, on && pk.onText]}>{r.small}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const pk = StyleSheet.create({
  row: { flexDirection: "row", gap: 10 },
  pick: {
    flex: 1,
    minHeight: 54,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: C.ink3,
    borderRadius: R.mark,
    alignItems: "center",
    justifyContent: "center",
  },
  on: { backgroundColor: C.slip, borderStyle: "solid", borderColor: C.slipDeep },
  text: { fontFamily: FONT.mono, fontWeight: "700", fontSize: 16, color: C.ink2 },
  small: { fontFamily: FONT.mono, fontWeight: "700", fontSize: 11, color: C.ink2, letterSpacing: 0.8 },
  onText: { color: C.slipInk },
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
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 22, marginBottom: 6, minHeight: 32 },
  title: { fontFamily: FONT.face, fontSize: T.head, fontWeight: "800", color: C.ink, letterSpacing: -0.3 },
  aside: { fontFamily: FONT.mono, fontSize: T.small, color: C.ink2 },
});

// --- receipt ------------------------------------------------------------------

/**
 * Anything that is a record: the terms, what you signed, who was paid. White
 * thermal paper, mono type, dotted leaders, a torn bottom edge.
 */
export function Receipt({ title, subtitle, children, style }: { title?: string; subtitle?: string; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[rc.paper, style]}>
      {title ? (
        <Text style={rc.title} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {subtitle ? <Text style={rc.sub}>{subtitle}</Text> : null}
      {title || subtitle ? <Rule /> : null}
      {children}
      <View style={rc.tear} aria-hidden>
        {Array.from({ length: 24 }, (_, i) => (
          <View key={i} style={rc.tooth} />
        ))}
      </View>
    </View>
  );
}

export function Rule() {
  return <View style={rc.rule} />;
}

export function Row({ label, value, tone, spoken }: { label: string; value: string; tone?: "earned" | "error"; spoken?: string }) {
  return (
    <View style={rc.row} accessible accessibilityLabel={spoken ?? `${label}: ${value}`}>
      <Text style={rc.dt}>{label}</Text>
      <View style={rc.leader} />
      <Text style={[rc.dd, tone === "earned" && { color: C.paidInk }, tone === "error" && { color: C.red }]}>{value}</Text>
    </View>
  );
}

const rc = StyleSheet.create({
  paper: {
    backgroundColor: C.receipt,
    borderWidth: 1,
    borderColor: C.rule,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 22,
    transform: [{ rotate: "-0.5deg" }],
    overflow: "hidden",
  },
  title: { fontFamily: FONT.mono, fontWeight: "700", fontSize: 13, letterSpacing: 1.5, textAlign: "center", color: C.receiptInk },
  sub: { fontFamily: FONT.mono, fontSize: 12, textAlign: "center", color: C.receiptInk2, marginTop: 2 },
  rule: { borderTopWidth: 1.5, borderStyle: "dashed", borderColor: C.ruleStrong, marginVertical: 10 },
  row: { flexDirection: "row", alignItems: "flex-end", paddingVertical: 4, gap: 6 },
  dt: { fontFamily: FONT.mono, fontSize: 14, color: C.receiptInk2 },
  leader: { flex: 1, borderBottomWidth: 1.5, borderStyle: "dotted", borderColor: C.ruleStrong, marginBottom: 5 },
  dd: { fontFamily: FONT.mono, fontSize: 14, fontWeight: "700", color: C.receiptInk, flexShrink: 1, textAlign: "right" },
  tear: { position: "absolute", left: 0, right: 0, bottom: -6, flexDirection: "row", justifyContent: "space-between" },
  tooth: { width: 11, height: 11, backgroundColor: C.paper, transform: [{ rotate: "45deg" }] },
});

// --- stamps -----------------------------------------------------------------------

/**
 * One per handoff, in red rubber-stamp ink. The row of them on a slip IS the
 * co-signed hop lineage. Angle comes from the key, so the same stamp always
 * lands the same way. Decorative: the slip says the same thing in words.
 */
export function Stamp({ top, mid, bottom, seed, yours, size = 60 }: { top: string; mid: string; bottom: string; seed: string; yours?: boolean; size?: number }) {
  const rot = yours ? 6 : (hashNum(seed) % 26) - 13;
  const colour = yours ? C.slipInk2 : C.stampInk;
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        st.ring,
        { width: size, height: size, borderRadius: size / 2, borderColor: colour, transform: [{ rotate: `${rot}deg` }] },
        yours && { borderStyle: "dashed" },
      ]}
    >
      {!yours ? <View style={[st.inner, { borderRadius: size / 2 - 4, borderColor: colour }]} /> : null}
      <Text style={[st.top, { color: colour }]} numberOfLines={1}>
        {top}
      </Text>
      <Text style={[st.mid, { color: colour }]}>{mid}</Text>
      <Text style={[st.bottom, { color: colour }]}>{bottom}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  ring: { borderWidth: 2.5, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  inner: { position: "absolute", top: 3, left: 3, right: 3, bottom: 3, borderWidth: 1 },
  top: { fontFamily: FONT.mono, fontSize: 10, fontWeight: "700", maxWidth: 48 },
  mid: { fontFamily: FONT.mono, fontSize: 12, fontWeight: "700" },
  bottom: { fontFamily: FONT.mono, fontSize: 8, fontWeight: "700", letterSpacing: 0.8 },
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
    <Animated.View
      accessible
      accessibilityLabel="Settled"
      style={[ss.box, { opacity, transform: [{ rotate: "-9deg" }, { scale }] }]}
    >
      <View style={ss.inner}>
        <Text style={[ss.text, { fontSize: size }]}>SETTLED</Text>
      </View>
    </Animated.View>
  );
}

const ss = StyleSheet.create({
  box: { borderWidth: 1.5, borderColor: C.paidInk, padding: 2, borderRadius: 5, alignSelf: "center" },
  inner: { borderWidth: 3, borderColor: C.paidInk, borderRadius: 4, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 3 },
  text: { fontFamily: FONT.mono, fontWeight: "700", color: C.paidInk, letterSpacing: 2 },
});

/** A small inked mark: PAID, FOR THEM, ALLOWED. Always words, never colour alone. */
export function Mark({ text, colour, rotate = -5 }: { text: string; colour: string; rotate?: number }) {
  return (
    <View style={[mk.box, { borderColor: colour, transform: [{ rotate: `${rotate}deg` }] }]}>
      <Text style={[mk.text, { color: colour }]}>{text}</Text>
    </View>
  );
}

const mk = StyleSheet.create({
  box: { borderWidth: 2, borderRadius: 3, paddingHorizontal: 5, paddingTop: 1, alignSelf: "flex-start" },
  text: { fontFamily: FONT.mono, fontWeight: "700", fontSize: 11, letterSpacing: 0.8 },
});

// --- avatar -------------------------------------------------------------------------

export function Avatar({ text, met, you, size = 40 }: { text: string; met?: boolean; you?: boolean; size?: number }) {
  const a = avatar(!!met && !you);
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        av.base,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: a.backgroundColor, borderColor: a.borderColor },
        you && { backgroundColor: C.card, borderColor: C.ink, borderWidth: 2 },
      ]}
    >
      <Text style={[av.text, { color: you ? C.ink : a.color, fontSize: size * 0.34 }]}>{text}</Text>
    </View>
  );
}

const av = StyleSheet.create({
  base: { borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  text: { fontFamily: FONT.mono, fontWeight: "700" },
});

// --- key tag --------------------------------------------------------------------------

/**
 * The device key on a kraft luggage tag, with a 7x7 identicon so two keys can
 * be told apart at a glance, and the key itself in groups of four.
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
      style={kt.tag}
      accessible
      accessibilityLabel={keyText ? `This phone's key: ${keyText}. Kept in this phone's secure storage.` : "Making this phone's key"}
      accessibilityLiveRegion="polite"
    >
      <View style={kt.hole} />
      <Text style={kt.kh}>THIS PHONE’S KEY</Text>
      {keyText ? (
        <View style={kt.row}>
          <View style={kt.ident}>
            {Array.from({ length: 49 }, (_, i) => {
              const y = Math.floor(i / 7);
              const x = i % 7;
              const on = bits[y * 4 + (x < 4 ? x : 6 - x)];
              return <View key={i} style={[kt.cell, on && { backgroundColor: C.kraftInk }]} />;
            })}
          </View>
          <Text style={kt.key}>{groups.join(" ")}</Text>
        </View>
      ) : (
        <ActivityIndicator color={C.kraftInk} style={{ alignSelf: "flex-start", marginVertical: 14 }} />
      )}
      <Text style={kt.where}>kept in this phone’s secure storage</Text>
    </View>
  );
}

const kt = StyleSheet.create({
  tag: {
    backgroundColor: C.kraft,
    paddingTop: 16,
    paddingBottom: 14,
    paddingLeft: 44,
    paddingRight: 16,
    borderTopLeftRadius: 22,
    borderBottomLeftRadius: 22,
    transform: [{ rotate: "-1.5deg" }],
    marginLeft: 8,
  },
  hole: {
    position: "absolute",
    left: 13,
    top: "50%",
    width: 14,
    height: 14,
    marginTop: -7,
    borderRadius: 7,
    backgroundColor: C.paper,
    borderWidth: 3,
    borderColor: C.kraftRing,
  },
  blank: { borderWidth: 2, borderStyle: "dashed", borderColor: C.ink3, padding: 20, minHeight: 96, justifyContent: "center" },
  kh: { fontFamily: FONT.mono, fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: C.kraftInk, marginBottom: 8 },
  row: { flexDirection: "row", gap: 12, alignItems: "center" },
  ident: { width: 52, height: 52, flexDirection: "row", flexWrap: "wrap", borderWidth: 1.5, borderColor: C.kraftInk, backgroundColor: C.identWell },
  cell: { width: "14.28%", height: "14.28%" },
  key: { flex: 1, fontFamily: FONT.mono, fontSize: 13, lineHeight: 20, fontWeight: "600", color: C.kraftInk },
  where: { fontFamily: FONT.hand, fontSize: 15, fontWeight: "700", color: C.kraftInk, marginTop: 8 },
});

// --- sheet ------------------------------------------------------------------------------

/**
 * A bottom sheet on opaque paper. The scrim behind it is the one translucent
 * thing in the app, and nothing is ever written on it. Android's back button
 * and a tap on the scrim both close it; with reduced motion it appears in place.
 */
export function Sheet({
  visible,
  onClose,
  title,
  lede,
  children,
  tall,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  lede?: string;
  children: ReactNode;
  tall?: boolean;
}) {
  const reduced = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType={reduced ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <View style={sh.fill}>
        <Pressable
          style={sh.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityHint="Closes this sheet without doing anything"
        />
        <View style={[sh.sheet, tall && sh.tall]} accessibilityViewIsModal>
          <View style={sh.grab} />
          <ScrollView contentContainerStyle={sh.body} keyboardShouldPersistTaps="handled">
            <Text style={sh.title} accessibilityRole="header">
              {title}
            </Text>
            {lede ? <Text style={sh.lede}>{lede}</Text> : null}
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const sh = StyleSheet.create({
  fill: { flex: 1, justifyContent: "flex-end" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: C.scrim },
  sheet: {
    backgroundColor: C.paper,
    borderTopWidth: 1.5,
    borderColor: C.ink,
    borderTopLeftRadius: R.sheet,
    borderTopRightRadius: R.sheet,
    maxHeight: "92%",
  },
  tall: { height: "92%" },
  grab: { width: 38, height: 4, borderRadius: 2, backgroundColor: C.ruleStrong, alignSelf: "center", marginTop: 10 },
  body: { paddingHorizontal: S.gutter, paddingTop: 16, paddingBottom: 28, gap: 0 },
  title: { fontFamily: FONT.face, fontSize: T.sheetTitle, fontWeight: "800", letterSpacing: -0.8, color: C.ink, marginBottom: 8, lineHeight: 29 },
  lede: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2, marginBottom: 16 },
});

/** Stack of actions at the bottom of a screen or sheet. */
export function Dock({ children }: { children: ReactNode }) {
  return <View style={{ gap: 8, paddingTop: 12 }}>{children}</View>;
}

/** A dashed-outline "coach" note taped to the page: one tip at a time, dismissable. */
export function Coach({ n, text, onDone }: { n: number; text: string; onDone: () => void }) {
  return (
    <View style={co.note} accessibilityRole="summary">
      <View style={co.tape} />
      <Text style={co.text}>
        <Text style={co.n}>{n}. </Text>
        {text}
      </Text>
      <LinkButton label="Got it, stop the tips" hint="Hides these tips for good" onPress={onDone} color={C.ink2} />
    </View>
  );
}

const co = StyleSheet.create({
  note: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.rule,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 4,
    marginTop: 6,
    marginBottom: 16,
    marginHorizontal: 4,
    transform: [{ rotate: "-0.8deg" }],
  },
  // Masking tape. Opaque, because nothing sits on translucency.
  tape: { position: "absolute", top: -9, alignSelf: "center", width: 84, height: 20, backgroundColor: C.tape, transform: [{ rotate: "-3deg" }] },
  text: { fontFamily: FONT.hand, fontSize: 17, lineHeight: 23, color: C.ink },
  n: { fontWeight: "700", color: C.red },
});

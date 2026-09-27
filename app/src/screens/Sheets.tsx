import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PublicKey } from "@solana/web3.js";
import type { Bundle } from "@carrier/mesh";
import { noteKey } from "../chain";
import { formatUnits, mintOf } from "../amounts";
import {
  ALLOWANCE_CHOICES,
  BOND_BPS,
  DEFAULT_FEE_BPS,
  FEE_CHOICES_BPS,
  MINT_DECIMALS,
  MINT_SYMBOL,
  TOKEN_FAUCET_URL,
} from "../config";
import { dayTime, percent, shorten, spokenKey } from "../format";
import { noteExpiry, parseAmount, splitPayout } from "../ledger";
import { nowSeconds, type SettlementReceipt } from "../pocket";
import { C, R, SHADOW } from "../theme";
import { FONT } from "../ui/fonts";
import {
  Appear,
  Avatar,
  Button,
  Card,
  CheckBurst,
  CountUp,
  Dock,
  HoldButton,
  Note,
  Picks,
  Receipt,
  Row,
  Sheet,
  announce,
  buzz,
  useReducedMotion,
} from "../ui/kit";
import type { Carrier } from "../useCarrier";
import { MapGlyph } from "../ui/chrome";
import { slipFacts } from "./Slip";
import { money } from "./You";
import { LOCATION_POLICY, PASSES_WITH } from "../platform";

/** One sentence about the public record, said where it matters. */
const PUBLIC_RECORD = "When it settles, the keys of everyone who carried it, and the time of each handoff, go on a public record that cannot be deleted.";

// --- small local pieces ----------------------------------------------------------------

/** A red line on its soft fill: errors and the over-the-limit warning. */
export function ErrorLine({ children, live = "assertive" }: { children: ReactNode; live?: "polite" | "assertive" }) {
  return (
    <View style={ps.errBox}>
      <View style={ps.errI} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={ps.errIText}>!</Text>
      </View>
      <Text style={ps.errText} accessibilityLiveRegion={live}>
        {children}
      </Text>
    </View>
  );
}

/** The two-letter face for a key, as the avatars show it. */
const initials = (key: { toBase58(): string } | string) => (typeof key === "string" ? key : key.toBase58()).slice(0, 2);

/** A section label with an optional caption on the right. */
function Label({ text, aside, id }: { text: string; aside?: string; id?: string }) {
  return (
    <View style={ps.labelRow}>
      <Text style={ps.label} nativeID={id}>
        {text}
      </Text>
      {aside ? <Text style={ps.aside}>{aside}</Text> : null}
    </View>
  );
}

// --- confirm a pass -----------------------------------------------------------------

export function PassSheet({
  c,
  bundle,
  peer,
  onClose,
}: {
  c: Carrier;
  bundle: Bundle | null;
  peer: PublicKey | null;
  onClose: () => void;
}) {
  if (!bundle || !peer) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
  const me = c.pocket!.me;
  const f = slipFacts(bundle, me);
  const delivering = bundle.note.to.equals(peer);
  const own = f.role === "own";
  const m = mintOf(bundle);
  const fmt = (n: bigint) => `${m ? formatUnits(n, m.decimals) : n.toString()} ${f.unit}`;
  const split = splitPayout(bundle.note.amount, bundle.note.relayFeeBps, bundle.hops.length + (delivering ? 0 : 1));
  const name = shorten(peer);
  const share =
    own ? (
      <Row label={delivering ? "They receive" : "They receive at least"} value={fmt(split.toRecipient)} last />
    ) : f.role === "carrying" && !delivering ? (
      <Row label="Your share, if it settles next" value={fmt(split.perRelayer)} tone="earned" last />
    ) : f.role === "carrying" ? (
      <Row label="Your share" value={f.share ?? `0 ${f.unit}`} tone="earned" last />
    ) : null;
  return (
    <Sheet
      visible
      onClose={onClose}
      title={`${delivering ? "Deliver to" : "Hand to"} ${name}?`}
      lede={
        delivering
          ? `${name} is who this is for. It settles the next time either of your phones finds signal.`
          : `${name} carries it on toward ${shorten(bundle.note.to)}. Both phones sign, your stamp goes on the slip, and it cannot be taken back.`
      }
    >
      <View style={[ps.who, { marginTop: 0, marginBottom: 12 }]}>
        <Avatar text={initials(peer)} met={c.pocket!.hasMet(peer)} size={44} />
        <View style={{ flex: 1 }}>
          <Text style={ps.key}>{name}</Text>
          <Text style={ps.meta}>{delivering ? "Who it's for" : `Carrying it on to ${shorten(bundle.note.to)}`}</Text>
        </View>
      </View>
      <Receipt>
        <Row label="Amount" value={`${f.value} ${f.unit}`} spoken={`Amount: ${f.spoken}`} />
        <Row label="Stamps once handed" value={String(bundle.hops.length + (delivering ? 0 : 1))} last={!share} />
        {share}
      </Receipt>
      {delivering ? null : <Note>{PUBLIC_RECORD}</Note>}
      <Dock>
        <Button
          label={`${delivering ? "Deliver" : "Hand over"} ${f.spoken} to ${name}`}
          hint="Sends it to their phone now. Keep the phones close."
          onPress={() => {
            onClose();
            c.pass(noteKey(bundle), peer);
          }}
        >
          {`${delivering ? "Deliver" : "Hand over"} ${f.value} ${f.unit}`}
        </Button>
        <Button label="Keep it" hint="Closes this without handing anything over" variant="quiet" onPress={onClose} />
      </Dock>
    </Sheet>
  );
}

// --- pay: the amount pad -------------------------------------------------------------------

/** Most digits before the point: plenty for any pouch. */
const MAX_WHOLE = 7;

/** One key on the pad applied to what is typed so far. */
export function typeKey(prev: string, k: string): string {
  if (k === "del") return prev.slice(0, -1);
  if (k === ".") {
    if ((MINT_DECIMALS as number) === 0 || prev.includes(".")) return prev;
    return prev === "" ? "0." : `${prev}.`;
  }
  const [whole, frac] = prev.split(".");
  if (frac !== undefined) return frac.length >= MINT_DECIMALS ? prev : prev + k;
  if (prev === "0") return k;
  if (whole.length >= MAX_WHOLE) return prev;
  return prev + k;
}

/** A typed character that pops in the first time it shows. */
function PopChar({ ch, style, fresh }: { ch: string; style: any; fresh: boolean }) {
  const reduced = useReducedMotion();
  const p = useRef(new Animated.Value(fresh && !reduced ? 0 : 1)).current;
  useEffect(() => {
    if (!fresh || reduced) {
      p.setValue(1);
      return;
    }
    Animated.spring(p, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 10 }).start();
  }, [p, fresh, reduced]);
  return (
    <Animated.Text
      style={[
        style,
        {
          opacity: p.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
          transform: [{ translateY: p.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }, { scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
        },
      ]}
    >
      {ch}
    </Animated.Text>
  );
}

function BigAmount({ text, over }: { text: string; over: boolean }) {
  // characters already on screen when this mounted do not pop
  const first = useRef(text.length).current;
  const size = text.length > 8 ? 42 : text.length > 6 ? 52 : 64;
  const digit = [ps.big, { fontSize: size, lineHeight: size * 1.1 }, over && { color: C.red }];
  return (
    <View
      style={ps.bigRow}
      accessible
      accessibilityLabel={text ? `Amount: ${text} ${MINT_SYMBOL}` : `Amount: none yet`}
      accessibilityLiveRegion="polite"
    >
      {text ? (
        text.split("").map((ch, i) => <PopChar key={`${i}${ch}`} ch={ch} style={digit} fresh={i >= first} />)
      ) : (
        <Text style={[ps.big, { color: C.ink3 }]}>0</Text>
      )}
      <Text style={ps.bigUnit}>{MINT_SYMBOL}</Text>
    </View>
  );
}

/** The backspace mark, drawn: a box with a pointed left end. */
function DelGlyph() {
  return (
    <View style={{ width: 26, height: 18, flexDirection: "row", alignItems: "center" }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={{ width: 13, height: 13, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: C.ink, borderBottomLeftRadius: 2, transform: [{ rotate: "45deg" }], marginRight: -9, marginLeft: 3 }} />
      <View style={{ flex: 1, height: 18, borderTopWidth: 2, borderRightWidth: 2, borderBottomWidth: 2, borderColor: C.ink, borderTopRightRadius: 4, borderBottomRightRadius: 4, alignItems: "center", justifyContent: "center" }}>
        <View style={{ position: "absolute", width: 8, height: 2, backgroundColor: C.ink, transform: [{ rotate: "45deg" }] }} />
        <View style={{ position: "absolute", width: 8, height: 2, backgroundColor: C.ink, transform: [{ rotate: "-45deg" }] }} />
      </View>
    </View>
  );
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"] as const;

function Keypad({ onKey }: { onKey: (k: string) => void }) {
  return (
    <View style={ps.pad}>
      {KEYS.map((k) => {
        const flat = k === "." || k === "del";
        return (
          <Pressable
            key={k}
            onPress={() => {
              buzz("tap");
              onKey(k);
            }}
            accessibilityRole="button"
            accessibilityLabel={k === "del" ? "Delete" : k === "." ? "Decimal point" : k}
            style={({ pressed }) => [ps.padKey, flat && ps.padFlat, pressed && { backgroundColor: C.paper2 }]}
          >
            {k === "del" ? <DelGlyph /> : <Text style={ps.padText}>{k}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

// --- pay -----------------------------------------------------------------------------

type PayStep = "who" | "amount" | "confirm";

export function PaySheet({
  c,
  visible,
  initialTo,
  initialAmount,
  initialStep,
  onClose,
  onSetup,
}: {
  c: Carrier;
  visible: boolean;
  initialTo?: PublicKey | null;
  initialAmount?: string;
  initialStep?: PayStep;
  onClose: () => void;
  onSetup: () => void;
}) {
  const pocket = c.pocket!;
  const [step, setStep] = useState<PayStep>("who");
  const [to, setTo] = useState<PublicKey | null>(null);
  const [keyText, setKeyText] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [fee, setFee] = useState<number>(DEFAULT_FEE_BPS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setTo(initialTo ?? null);
    setStep(initialStep ?? (initialTo ? "amount" : "who"));
    setKeyText("");
    setKeyError(null);
    setAmountText(initialAmount ?? "");
    setAmountError(null);
    setFee(DEFAULT_FEE_BPS);
    setError(null);
    setBusy(false);
  }, [visible, initialTo, initialAmount, initialStep]);

  const cache = pocket.pouch;
  const left = c.spendable;
  const amount = parseAmount(amountText, MINT_DECIMALS);
  const nearby = to ? c.peers.some((p) => p.equals(to)) : false;

  if (!cache) {
    return (
      <Sheet
        visible={visible}
        onClose={onClose}
        title="Set up your pouch first"
        lede="To pay someone, this phone needs money set aside on Solana that carriers can check is really there. Setting it up needs signal once; after that you can pay with none."
      >
        <Dock>
          <Button
            label="Set up pouch"
            hint={c.online === "online" ? "Explains what it needs" : "Needs signal"}
            disabled={c.online !== "online"}
            onPress={() => {
              onClose();
              onSetup();
            }}
          />
          <Button label="Not now" variant="quiet" onPress={onClose} />
        </Dock>
      </Sheet>
    );
  }

  const chooseKey = () => {
    try {
      const k = new PublicKey(keyText.trim());
      if (k.equals(pocket.me)) {
        setKeyError("That is this phone's own key.");
        return;
      }
      setTo(k);
      setStep("amount");
    } catch {
      setKeyError("That is not a Carrier key. It is 32 to 44 letters and numbers.");
    }
  };

  const toAmountNext = () => {
    if (amount === null) return setAmountError(`Enter an amount, like 5 or 2.50.`);
    if (amount > left) return setAmountError(`That is more than you can sign right now. The most is ${money(left)}.`);
    setAmountError(null);
    setStep("confirm");
  };

  const sign = async () => {
    if (!to || amount === null) return;
    setBusy(true);
    setError(null);
    const r = await c.pay(to, amount, fee);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      announce(`Not signed. ${r.message}`);
      return;
    }
    announce(nearby ? `Signed. Handing it to ${shorten(to)}.` : "Signed. It is in your pocket; hand it to anyone heading their way.");
    onClose();
  };

  if (step === "who") {
    return (
      <Sheet visible={visible} onClose={onClose} title="Who are you paying?" lede="Pick someone in range, or paste the key of someone who is not here." tall>
        {c.peers.length ? (
          <Card pad={false} style={ps.list}>
            {c.peers.map((p, i) => (
              <Pressable
                key={p.toBase58()}
                onPress={() => {
                  setTo(p);
                  setStep("amount");
                }}
                accessibilityRole="button"
                accessibilityLabel={`Pay ${spokenKey(p)}`}
                style={({ pressed }) => [ps.person, i === c.peers.length - 1 && { borderBottomWidth: 0 }, pressed && { backgroundColor: C.paper2 }]}
              >
                <Avatar text={initials(p)} met={pocket.hasMet(p)} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={ps.key}>{shorten(p)}</Text>
                  <Text style={ps.meta}>in range{pocket.hasMet(p) ? " · met" : ""}</Text>
                </View>
                <Chevron />
              </Pressable>
            ))}
          </Card>
        ) : (
          <Note>Nobody is in range. You can still sign a payment to a key and hand it to anyone heading their way.</Note>
        )}
        <View style={{ height: 18 }} />
        <Label text="Their key" id="payKeyLabel" />
        <TextInput
          value={keyText}
          onChangeText={(t) => {
            setKeyText(t);
            setKeyError(null);
          }}
          accessibilityLabel="Their key"
          accessibilityLabelledBy="payKeyLabel"
          accessibilityHint="Paste the public key they shared with you"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste a key"
          placeholderTextColor={C.ink3}
          style={ps.input}
        />
        {keyError ? <ErrorLine>{keyError}</ErrorLine> : null}
        <Dock>
          <Button label="Use this key" disabled={!keyText.trim()} onPress={chooseKey} />
          <Button label="Cancel" variant="quiet" onPress={onClose} />
        </Dock>
      </Sheet>
    );
  }

  if (step === "amount" && to) {
    const over = amount !== null && amount > left;
    return (
      <Sheet visible={visible} onClose={onClose} title="Pay someone">
        <View style={ps.who}>
          <Avatar text={initials(to)} met={pocket.hasMet(to)} size={44} />
          <View style={{ flex: 1 }} accessible accessibilityLabel={`Paying ${spokenKey(to)}, ${nearby ? "in range now" : "not in range"}`}>
            <Text style={ps.key}>{shorten(to)}</Text>
            <Text style={ps.meta}>{nearby ? "In range now" : "Not in range"}</Text>
          </View>
          <Pressable
            onPress={() => setStep("who")}
            accessibilityRole="button"
            accessibilityLabel="Change who you are paying"
            hitSlop={8}
            style={({ pressed }) => [ps.changePill, pressed && { backgroundColor: C.rule }]}
          >
            <Text style={ps.changeText}>Change</Text>
          </Pressable>
        </View>
        <BigAmount text={amountText} over={over} />
        {over ? (
          <ErrorLine live="polite">{`That's more than you can sign offline. You have ${money(left)} left.`}</ErrorLine>
        ) : (
          <Text style={ps.avail}>You can sign up to {money(left)} with no signal</Text>
        )}
        {amountError && !over ? <ErrorLine>{amountError}</ErrorLine> : null}
        <View style={{ height: 18 }} />
        <Label text="Carriers’ share" aside="split by whoever carries it" />
        <Picks
          label="Carriers' share"
          options={FEE_CHOICES_BPS}
          value={fee as (typeof FEE_CHOICES_BPS)[number]}
          onChange={(v) => setFee(v)}
          render={(v) => ({ text: percent(v), spoken: v === 0 ? "No share for carriers" : `${percent(v)} for carriers` })}
        />
        <Keypad
          onKey={(k) => {
            setAmountText((t) => typeKey(t, k));
            setAmountError(null);
          }}
        />
        <Dock>
          <Button
            label={over ? "Lower the amount to continue" : "Next"}
            hint={over ? undefined : "Shows exactly what you are signing"}
            disabled={over}
            onPress={toAmountNext}
          />
          <Button label="Back" variant="quiet" onPress={() => setStep("who")} />
        </Dock>
      </Sheet>
    );
  }

  if (step === "confirm" && to && amount !== null) {
    const expiry = noteExpiry(nowSeconds(), BigInt(cache.epochStartedAt));
    const split = splitPayout(amount, fee, 1);
    const value = formatUnits(amount, MINT_DECIMALS);
    return (
      <Sheet
        visible={visible}
        onClose={onClose}
        title="Check, then sign"
        lede={`You're paying ${shorten(to)} ${value} ${MINT_SYMBOL}. ${fee ? `Whoever carries it earns up to ${percent(fee)}.` : "Nobody earns anything for carrying it."}`}
      >
        <Receipt>
          <Row label="To" value={shorten(to)} spoken={`To ${spokenKey(to)}`} />
          <Row label="Amount" value={`${value} ${MINT_SYMBOL}`} />
          <Row label="Carriers’ share, up to" value={money(split.relayFee)} />
          <Row label="They receive, at least" value={money(split.toRecipient)} />
          <Row label="Good until" value={expiry ? dayTime(expiry) : "period closed"} />
          <Row label="Left to sign after" value={money(left - amount)} last />
        </Receipt>
        <Note>
          {nearby
            ? "It goes straight to their phone. "
            : "They are not in range, so it stays in your pocket; hand it to anyone heading their way. "}
          {PUBLIC_RECORD}
        </Note>
        {error ? <ErrorLine>{error}</ErrorLine> : null}
        <Dock>
          <HoldButton
            label={nearby ? `Sign and hand over ${value} ${MINT_SYMBOL}` : `Sign ${value} ${MINT_SYMBOL}`}
            hint="Press and hold to sign with this phone's key. It cannot be taken back once handed over."
            holdingLabel="Keep holding…"
            doneLabel="Signed"
            busy={busy}
            onConfirm={sign}
          >
            {`Hold to sign ${value} ${MINT_SYMBOL}`}
          </HoldButton>
          <Button label="Change" variant="quiet" onPress={() => setStep("amount")} />
        </Dock>
      </Sheet>
    );
  }
  return null;
}

function Chevron() {
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: 9, height: 9, borderTopWidth: 2, borderRightWidth: 2, borderColor: C.ink3, transform: [{ rotate: "45deg" }], marginRight: 4 }}
    />
  );
}

// --- a settlement landed ---------------------------------------------------------------

type PathNode = { key: string; face: string; name: string; you: boolean; end: boolean };

/** Who it passed through, lighting up one hand at a time. */
function PathCard({ nodes }: { nodes: PathNode[] }) {
  const reduced = useReducedMotion();
  const lit = useRef(nodes.map(() => new Animated.Value(reduced ? 1 : 0))).current;
  const run = useRef(nodes.map(() => new Animated.Value(reduced ? 1 : 0))).current;
  useEffect(() => {
    if (reduced) {
      lit.forEach((v) => v.setValue(1));
      run.forEach((v) => v.setValue(1));
      return;
    }
    const START = 450;
    const STEP = 250;
    const anims = nodes.flatMap((_, i) => [
      Animated.timing(lit[i], { toValue: 1, duration: 220, delay: START + i * STEP * 2, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ...(i < nodes.length - 1
        ? [Animated.timing(run[i], { toValue: 1, duration: STEP, delay: START + i * STEP * 2 + 160, easing: Easing.inOut(Easing.quad), useNativeDriver: false })]
        : []),
    ]);
    const all = Animated.parallel(anims);
    all.start();
    return () => all.stop();
    // runs once per receipt (the card is keyed by it); a re-render must not restart it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);
  const spoken = `Path: from ${nodes[0].you ? "you" : spokenKey(nodes[0].key)}${
    nodes.length > 2 ? `, carried by ${nodes.slice(1, -1).map((n) => (n.you ? "you" : spokenKey(n.key))).join(", ")}` : ""
  }, to ${nodes[nodes.length - 1].you ? "you" : spokenKey(nodes[nodes.length - 1].key)}.`;
  return (
    <Card style={ps.path}>
      <View style={ps.pathRow} accessible accessibilityLabel={spoken}>
        {nodes.flatMap((n, i) => {
          const green = n.end && n.you;
          const node = (
            <View key={`n${i}`} style={ps.pathNode}>
              <View style={ps.pathAv}>
                <Text style={ps.pathAvText}>{n.face}</Text>
                <Animated.View style={[StyleSheet.absoluteFill, ps.pathAvLit, green && { backgroundColor: C.green }, { opacity: lit[i] }]}>
                  <Text style={[ps.pathAvText, { color: C.onInk }]}>{n.face}</Text>
                </Animated.View>
              </View>
              <Text style={ps.pathName} numberOfLines={1}>
                {n.name}
              </Text>
            </View>
          );
          if (i === nodes.length - 1) return [node];
          return [
            node,
            <View key={`l${i}`} style={ps.pathLine}>
              <Animated.View style={[ps.pathFill, { width: run[i].interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
            </View>,
          ];
        })}
      </View>
    </Card>
  );
}

export function ReceiptSheet({
  c,
  receipt,
  onClose,
  onSeeRoute,
}: {
  c: Carrier;
  receipt: SettlementReceipt | null;
  onClose: () => void;
  /** Closes the sheet and opens the Map on this payment's route; absent when there is no route to show. */
  onSeeRoute?: () => void;
}) {
  useEffect(() => {
    if (receipt) buzz("success");
  }, [receipt]);
  if (!receipt) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
  const me = c.pocket!.me.toBase58();
  const m = mintOf(receipt.bundle);
  const unit = m ? m.symbol : "units";
  const fmt = (n: bigint) => `${m ? formatUnits(n, m.decimals) : n.toString()} ${unit}`;
  const finalText = m ? formatUnits(receipt.toRecipient, m.decimals) : receipt.toRecipient.toString();
  const places = finalText.split(".")[1]?.length ?? 0;
  const toNumber = m ? Number(receipt.toRecipient) / 10 ** m.decimals : Number(receipt.toRecipient);
  const hands = receipt.carriers.length + 1;
  const toYou = receipt.to === me;
  const owner = receipt.bundle.owner.toBase58();
  const nodes: PathNode[] = [
    { key: owner, face: owner === me ? "You" : owner.slice(0, 2), name: owner === me ? "You" : owner.slice(0, 4), you: owner === me, end: false },
    ...receipt.carriers.map((k) => ({ key: k.key, face: k.you ? "You" : k.key.slice(0, 2), name: k.you ? "You" : k.key.slice(0, 4), you: k.you, end: false })),
    { key: receipt.to, face: toYou ? "You" : receipt.to.slice(0, 2), name: toYou ? "You" : receipt.to.slice(0, 4), you: toYou, end: true },
  ];
  type RowSpec = { k: string; label: string; value: string; tone?: "earned"; spoken?: string };
  const rows: RowSpec[] = [
    { k: "to", label: toYou ? "Paid to you" : `Paid to ${shorten(receipt.to)}`, value: fmt(receipt.toRecipient), tone: toYou ? "earned" : undefined },
    ...receipt.carriers.map((k, i) => ({
      k: `${k.key}${i}`,
      label: k.you ? "Carrier (you)" : `Carrier ${shorten(k.key)}`,
      value: fmt(k.amount),
      tone: k.you ? ("earned" as const) : undefined,
    })),
    ...(receipt.kept > 0n ? [{ k: "kept", label: "Back to the sender’s pouch", value: fmt(receipt.kept) }] : []),
    ...(receipt.signatures[0]
      ? [{ k: "tx", label: "Transaction", value: `${receipt.signatures[0].slice(0, 8)}…`, spoken: `Transaction starting ${receipt.signatures[0].slice(0, 8)}` }]
      : []),
  ];
  return (
    <Sheet
      visible
      onClose={onClose}
      hero={
        <View style={{ marginTop: 8, marginBottom: 18 }}>
          <CheckBurst />
        </View>
      }
      center
      title="It settled"
      lede={
        <>
          <CountUp key={receipt.hash} value={toNumber} format={(n) => `${n.toFixed(places)} ${unit}`} delay={250} />
          {` reached ${toYou ? "you" : shorten(receipt.to)} after ${hands} ${hands > 1 ? "hands" : "hand"}. Everyone below has been paid.`}
        </>
      }
    >
      <PathCard key={receipt.hash} nodes={nodes} />
      <Receipt style={{ marginTop: 10 }}>
        {rows.map((r, i) => (
          <Appear key={r.k} delay={700 + i * 120} from={8}>
            <Row label={r.label} value={r.value} tone={r.tone} spoken={r.spoken} last={i === rows.length - 1} />
          </Appear>
        ))}
      </Receipt>
      <Dock>
        {onSeeRoute ? (
          <Button label="See where it went" hint="Opens the map on this payment's route" variant="quiet" onPress={onSeeRoute} icon={<MapGlyph colour={C.ink} />} />
        ) : null}
        <Button label="Done" onPress={onClose} />
      </Dock>
    </Sheet>
  );
}

// --- a handoff did not finish ----------------------------------------------------------------

/** Nearby waves: a dot between two pairs of arcs. */
function RadioGlyph() {
  const arc = (s: number) => ({
    position: "absolute" as const,
    width: s,
    height: s,
    borderRadius: s / 2,
    borderWidth: 2.5,
    borderColor: C.amberInk,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
  });
  return (
    <View style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center" }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={arc(34)} />
      <View style={arc(20)} />
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.amberInk }} />
    </View>
  );
}

export function HandFailedSheet({ c, onRetry, onPickElse }: { c: Carrier; onRetry: () => void; onPickElse: () => void }) {
  const f = c.handFailed;
  // keep the last one on screen while the sheet slides away
  const last = useRef(f);
  if (f) last.current = f;
  const shown = f ?? last.current;
  const close = () => c.clearHandFailed();
  if (!shown || !c.pocket) return <Sheet visible={false} onClose={close} title="">{null}</Sheet>;
  const bundle = c.pocket.node.bundle(shown.noteHash);
  const facts = bundle ? slipFacts(bundle, c.pocket.me) : null;
  const here = c.peers.some((p) => p.equals(shown.peer));
  const name = shorten(shown.peer);
  return (
    <Sheet
      visible={!!f}
      onClose={close}
      hero={
        <View style={ps.bigIco}>
          <RadioGlyph />
        </View>
      }
      title="That didn't go through"
      lede={`${shown.reason} The slip didn't move, and it's still in your pocket.`}
    >
      {bundle && facts ? (
        <Card style={ps.mini}>
          <View style={ps.slipChip} />
          <View style={{ flex: 1 }} accessible accessibilityLabel={`${facts.spoken} for ${bundle.note.to.equals(c.pocket.me) ? "you" : spokenKey(bundle.note.to)}. Still with you, ${facts.stamps.length} stamps.`}>
            <Text style={ps.miniTitle}>
              {facts.value} {facts.unit} for {bundle.note.to.equals(c.pocket.me) ? "you" : shorten(bundle.note.to)}
            </Text>
            <Text style={ps.meta}>
              Still with you · {facts.stamps.length} {facts.stamps.length === 1 ? "stamp" : "stamps"}
            </Text>
          </View>
        </Card>
      ) : null}
      <Dock>
        {here ? (
          <Button
            label={`Try again with ${name}`}
            hint="Hands it over again. Keep the phones close."
            onPress={() => {
              onRetry();
              close();
            }}
          />
        ) : null}
        <Button
          label="Pick someone else"
          variant="quiet"
          onPress={() => {
            onPickElse();
            close();
          }}
        />
      </Dock>
    </Sheet>
  );
}

// --- set up a pouch ------------------------------------------------------------------------

export function PouchSheet({ c, visible, onClose }: { c: Carrier; visible: boolean; onClose: () => void }) {
  const [pick, setPick] = useState<(typeof ALLOWANCE_CHOICES)[number]>(25);
  const amount = BigInt(pick) * 10n ** BigInt(MINT_DECIMALS);
  const bond = (amount * BigInt(BOND_BPS)) / 10_000n;
  const b = c.balances;
  const lowSol = !b || b.sol < 5_000_000n;
  const lowToken = !b || b.token === null || b.token < amount + bond;
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Set up your pouch"
      lede={`This sets aside ${MINT_SYMBOL} on Solana ${c.services.chain.cluster}, so anyone carrying your payments can check the money is there. It needs a little SOL for network fees, and the ${MINT_SYMBOL} you commit. Devnet tokens are test tokens and are worth nothing.`}
      tall
    >
      <Receipt title="This phone holds">
        <Row label="SOL, for fees" value={b ? (Number(b.sol) / 1e9).toFixed(3) : "unknown"} tone={b && !lowSol ? "earned" : "error"} />
        <Row label={`${MINT_SYMBOL}, to commit`} value={b && b.token !== null ? money(b.token) : "unknown"} tone={b && !lowToken ? "earned" : "error"} last />
      </Receipt>
      <View style={{ height: 22 }} />
      <Label text="Offline allowance" />
      <Text style={ps.help}>The most you can have out in payments nobody has settled yet.</Text>
      <Picks
        label={`Offline allowance in ${MINT_SYMBOL}`}
        options={ALLOWANCE_CHOICES}
        value={pick}
        onChange={setPick}
        render={(v) => ({ text: String(v), small: MINT_SYMBOL, spoken: `${v} ${MINT_SYMBOL}` })}
      />
      <Note>
        Plus a bond of {money(bond)}. It is only taken if this phone ever signs two payments against the same slot, and then it pays
        whoever was cheated.
      </Note>
      {c.pouchBusy ? (
        <Text style={ps.status} accessibilityLiveRegion="polite">
          {c.pouchBusy}…
        </Text>
      ) : null}
      {c.pouchError ? <ErrorLine>{c.pouchError}</ErrorLine> : null}
      <Dock>
        {lowSol ? (
          <Button label="Get test SOL" hint="Asks devnet for free test SOL to pay fees" variant="quiet" busy={!!c.pouchBusy} onPress={c.airdrop} />
        ) : null}
        {lowToken ? (
          <Button
            label={`Get test ${MINT_SYMBOL}`}
            hint="Opens Circle's faucet in the browser. Choose Solana devnet and give it this phone's key, from Share key on the You tab."
            variant="quiet"
            onPress={() => c.services.openUrl(TOKEN_FAUCET_URL)}
          />
        ) : null}
        <Button
          label={`Set aside ${pick} ${MINT_SYMBOL}`}
          hint="Signs one transaction with this phone's key"
          busy={!!c.pouchBusy}
          disabled={c.online !== "online"}
          onPress={async () => {
            if (await c.setupPouch(amount)) onClose();
          }}
        />
        <Button label="Not now" variant="quiet" onPress={onClose} />
      </Dock>
    </Sheet>
  );
}

// --- the small print -------------------------------------------------------------------------

const LEGAL: Record<"terms" | "privacy", { title: string; parts: [string, string][] }> = {
  terms: {
    title: "Terms of use",
    parts: [
      ["What Carrier is", "Carrier is experimental software for passing signed payments between phones over local radio and settling them on the Solana blockchain. This build runs on devnet. Tokens on devnet have no monetary value and cannot be exchanged for money."],
      ["Your key", "Your key is created on your phone and stored in its secure storage. We never receive a copy and cannot recover it. If you lose the phone or reset the app, anything the key controls is gone."],
      ["Carrying payments", "When you accept a payment from someone, your phone holds it until you hand it on or until it is settled. Carriers receive a share of the payment when it settles. A payment that never settles pays nobody, including you."],
      ["Your offline allowance", "The allowance you choose is locked on Solana as a deposit. It limits how much you can have out in unsettled payments at once. If you sign two payments against the same slot, the protocol takes the amount from your bond and pays it to the person who could not settle."],
      ["No warranty", `Carrier is provided as it is, without warranty of any kind. The radio layer has not been tested across devices, and passes only to ${PASSES_WITH}. Do not use this build to move anything you cannot afford to lose.`],
    ],
  },
  privacy: {
    title: "Privacy policy",
    parts: [
      ["What stays on your phone", "Your key, the payments you are carrying, and the list of people you have met. None of it is sent to us. We do not run a server that could receive it."],
      ["What other phones see", "Phones within radio range see a random identifier while Carrier is open. When you hand a payment over, the other phone learns your public key."],
      ["What becomes public", "When a payment settles, the public key of each person who carried it, the time of each handoff, the amount, the sender and the recipient are written to Solana, which anyone can read and nobody can delete. Public keys are not names, but someone who knows your key can infer where you were near another carrier."],
      ["Location", LOCATION_POLICY],
      ["What we do not collect", "No name, email, phone number, contacts, location, advertising identifier or analytics."],
    ],
  },
};


export function LegalSheet({ which, onClose }: { which: "terms" | "privacy" | null; onClose: () => void }) {
  if (!which) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
  const doc = LEGAL[which];
  return (
    <Sheet visible onClose={onClose} title={doc.title} lede="Last updated 23 September 2026" tall>
      <Card>
        {doc.parts.map(([h, p], i) => (
          <View key={h} style={[ps.legalPart, i === doc.parts.length - 1 && { borderBottomWidth: 0, marginBottom: 0, paddingBottom: 0 }]}>
            <Text style={ps.h4} accessibilityRole="header">
              {h}
            </Text>
            <Text style={ps.p}>{p}</Text>
          </View>
        ))}
      </Card>
      <Dock>
        <Button label="Close" variant="quiet" onPress={onClose} />
      </Dock>
    </Sheet>
  );
}

export const LEGAL_TEXT = LEGAL;

const ps = StyleSheet.create({
  // people and keys
  list: { overflow: "hidden" },
  person: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: C.rule, backgroundColor: C.card },
  key: { fontFamily: FONT.mono, fontSize: 15, fontWeight: "600", letterSpacing: -0.4, color: C.ink },
  meta: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginTop: 2 },
  who: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.card, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 12, marginTop: 6, ...SHADOW },
  changePill: { minHeight: 32, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: C.paper2, justifyContent: "center" },
  changeText: { fontFamily: FONT.face, fontSize: 13, fontWeight: "600", color: C.ink2 },

  // labels and text
  labelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, gap: 8 },
  label: { fontFamily: FONT.face, fontSize: 15, fontWeight: "700", color: C.ink },
  aside: { fontFamily: FONT.face, fontSize: 14, color: C.ink2, flexShrink: 1, textAlign: "right" },
  help: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: -4, marginBottom: 12 },
  input: {
    minHeight: 54,
    borderWidth: 1.5,
    borderColor: C.rule,
    borderRadius: R.box,
    paddingHorizontal: 16,
    fontFamily: FONT.mono,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.card,
  },
  status: { fontFamily: FONT.mono, fontSize: 13, color: C.ink2, marginTop: 10 },
  p: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2 },
  h4: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700", color: C.ink, marginBottom: 4 },
  legalPart: { paddingBottom: 14, marginBottom: 14, borderBottomWidth: 1, borderColor: C.rule },

  // errors
  errBox: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.redSoft, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10 },
  errI: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: C.redInk, alignItems: "center", justifyContent: "center" },
  errIText: { fontFamily: FONT.face, fontSize: 11, fontWeight: "800", color: C.redInk, lineHeight: 13 },
  errText: { flex: 1, fontFamily: FONT.face, fontSize: 14, lineHeight: 20, fontWeight: "500", color: C.redInk },

  // the amount
  bigRow: { flexDirection: "row", justifyContent: "center", alignItems: "baseline", marginTop: 24, marginBottom: 6, minHeight: 72 },
  big: { fontFamily: FONT.face, fontSize: 64, lineHeight: 70, fontWeight: "800", letterSpacing: -2.5, color: C.ink },
  bigUnit: { fontFamily: FONT.face, fontSize: 22, fontWeight: "600", color: C.ink3, marginLeft: 8 },
  avail: { fontFamily: FONT.face, fontSize: 14, fontWeight: "500", color: C.ink2, textAlign: "center" },
  pad: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8, marginTop: 18 },
  padKey: { width: "31.8%", minHeight: 52, borderRadius: 14, backgroundColor: C.card, alignItems: "center", justifyContent: "center" },
  padFlat: { backgroundColor: "transparent" },
  padText: { fontFamily: FONT.face, fontSize: 22, fontWeight: "600", color: C.ink },

  // settlement path
  path: { paddingHorizontal: 14, paddingVertical: 18, marginTop: 4 },
  pathRow: { flexDirection: "row", alignItems: "flex-start" },
  pathNode: { width: 48, alignItems: "center", gap: 6 },
  pathAv: { width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: C.outline, backgroundColor: C.card, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  pathAvLit: { backgroundColor: C.ink, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  pathAvText: { fontFamily: FONT.face, fontSize: 13, fontWeight: "700", color: C.ink },
  pathName: { fontFamily: FONT.face, fontSize: 12, fontWeight: "600", color: C.ink2 },
  pathLine: { flex: 1, height: 2, borderRadius: 1, backgroundColor: C.rule, marginTop: 19, marginHorizontal: -4, overflow: "hidden" },
  pathFill: { height: 2, backgroundColor: C.green },

  // hand failed
  bigIco: { width: 64, height: 64, borderRadius: 20, backgroundColor: C.amberSoft, alignItems: "center", justifyContent: "center", marginTop: 8, marginBottom: 16 },
  mini: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 20, marginTop: 4 },
  slipChip: { width: 44, height: 30, borderRadius: 8, backgroundColor: C.slip },
  miniTitle: { fontFamily: FONT.face, fontSize: 16, fontWeight: "700", color: C.ink },
});

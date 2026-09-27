import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
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
import { C } from "../theme";
import { FONT } from "../ui/fonts";
import { Button, Dock, Picks, Receipt, Row, Rule, SettledStamp, Sheet, announce } from "../ui/kit";
import type { Carrier } from "../useCarrier";
import { slipFacts } from "./Slip";
import { money } from "./You";

/** One sentence about the public record, said where it matters. */
const PUBLIC_RECORD = "When it settles, the keys of everyone who carried it, and the time of each handoff, go on a public record that cannot be deleted.";

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
  return (
    <Sheet
      visible
      onClose={onClose}
      title={`${delivering ? "Deliver to" : "Hand to"} ${name}?`}
      lede={
        delivering
          ? `${name} is who this is for. It settles the next time either of your phones finds signal.`
          : `${name} carries it on toward ${shorten(bundle.note.to)}. Both phones sign, your stamp goes on the slip, and it cannot be taken back. ${PUBLIC_RECORD}`
      }
    >
      <Receipt>
        <Row label="Amount" value={`${f.value} ${f.unit}`} spoken={`Amount: ${f.spoken}`} />
        <Row label="Stamps on it" value={String(bundle.hops.length + (delivering ? 1 : 2))} />
        {own ? (
          <Row label={delivering ? "They receive" : "They receive at least"} value={fmt(split.toRecipient)} />
        ) : f.role === "carrying" && !delivering ? (
          <Row label="Your share, if it settles next" value={fmt(split.perRelayer)} tone="earned" />
        ) : f.role === "carrying" ? (
          <Row label="Your share" value={f.share ?? `0 ${f.unit}`} tone="earned" />
        ) : null}
      </Receipt>
      <Dock>
        <Button
          label={`${delivering ? "Deliver" : "Hand over"} ${f.spoken} to ${name}`}
          hint="Sends it to their phone now. Keep the phones close."
          onPress={() => {
            onClose();
            c.pass(noteKey(bundle), peer);
          }}
        >
          {delivering ? "Deliver " : "Hand over "}
          <Text style={{ fontFamily: FONT.mono }}>{f.value}</Text>
          {` ${f.unit}`}
        </Button>
        <Button label="Keep it" hint="Closes this without handing anything over" variant="quiet" onPress={onClose} />
      </Dock>
    </Sheet>
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
          <View style={ps.list}>
            {c.peers.map((p) => (
              <Pressable
                key={p.toBase58()}
                onPress={() => {
                  setTo(p);
                  setStep("amount");
                }}
                accessibilityRole="button"
                accessibilityLabel={`Pay ${spokenKey(p)}`}
                style={({ pressed }) => [ps.person, pressed && { backgroundColor: C.paper2 }]}
              >
                <Text style={ps.personKey}>{shorten(p)}</Text>
                <Text style={ps.personMeta}>in range{pocket.hasMet(p) ? " · met" : ""}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={ps.p}>Nobody is in range. You can still sign a payment to a key and hand it to anyone heading their way.</Text>
        )}
        <Text style={ps.label} nativeID="payKeyLabel">
          Their key
        </Text>
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
        {keyError ? (
          <Text style={ps.error} accessibilityLiveRegion="assertive">
            {keyError}
          </Text>
        ) : null}
        <Dock>
          <Button label="Use this key" disabled={!keyText.trim()} onPress={chooseKey} />
          <Button label="Cancel" variant="quiet" onPress={onClose} />
        </Dock>
      </Sheet>
    );
  }

  if (step === "amount" && to) {
    return (
      <Sheet visible={visible} onClose={onClose} title={`How much for ${shorten(to)}?`} lede={`You can sign up to ${money(left)} with no signal.`}>
        <Text style={ps.label} nativeID="payAmountLabel">
          Amount in {MINT_SYMBOL}
        </Text>
        <TextInput
          value={amountText}
          onChangeText={(t) => {
            setAmountText(t);
            setAmountError(null);
          }}
          keyboardType="decimal-pad"
          accessibilityLabel={`Amount in ${MINT_SYMBOL}`}
          accessibilityLabelledBy="payAmountLabel"
          placeholder="0.00"
          placeholderTextColor={C.ink3}
          style={[ps.input, ps.amount]}
        />
        {amountError ? (
          <Text style={ps.error} accessibilityLiveRegion="assertive">
            {amountError}
          </Text>
        ) : null}
        <Text style={[ps.label, { marginTop: 20 }]}>Carriers’ share</Text>
        <Text style={ps.help}>
          Whoever carries it splits this when it settles. More carriers means smaller pieces, never a bigger total.
        </Text>
        <Picks
          label="Carriers' share"
          options={FEE_CHOICES_BPS}
          value={fee as (typeof FEE_CHOICES_BPS)[number]}
          onChange={(v) => setFee(v)}
          render={(v) => ({ text: percent(v), spoken: v === 0 ? "No share for carriers" : `${percent(v)} for carriers` })}
        />
        <Dock>
          <Button label="Next" hint="Shows exactly what you are signing" onPress={toAmountNext} />
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
        <Receipt title="YOU ARE SIGNING">
          <Row label="To" value={shorten(to)} spoken={`To ${spokenKey(to)}`} />
          <Row label="Amount" value={`${value} ${MINT_SYMBOL}`} />
          <Row label="Carriers’ share, up to" value={money(split.relayFee)} />
          <Row label="They receive, at least" value={money(split.toRecipient)} />
          <Row label="Good until" value={expiry ? dayTime(expiry) : "period closed"} />
          <Rule />
          <Row label="Left to sign after" value={money(left - amount)} />
        </Receipt>
        <Text style={ps.small}>
          {nearby
            ? "It goes straight to their phone. "
            : "They are not in range, so it stays in your pocket; hand it to anyone heading their way. "}
          {PUBLIC_RECORD}
        </Text>
        {error ? (
          <Text style={ps.error} accessibilityLiveRegion="assertive">
            {error}
          </Text>
        ) : null}
        <Dock>
          <Button
            label={nearby ? `Sign and hand over ${value} ${MINT_SYMBOL}` : `Sign ${value} ${MINT_SYMBOL}`}
            hint="Signs with this phone's key. It cannot be taken back once handed over."
            busy={busy}
            onPress={sign}
          >
            {nearby ? "Sign and hand over " : "Sign "}
            <Text style={{ fontFamily: FONT.mono }}>{value}</Text>
            {` ${MINT_SYMBOL}`}
          </Button>
          <Button label="Change" variant="quiet" onPress={() => setStep("amount")} />
        </Dock>
      </Sheet>
    );
  }
  return null;
}

// --- a settlement landed ---------------------------------------------------------------

export function ReceiptSheet({ c, receipt, onClose }: { c: Carrier; receipt: SettlementReceipt | null; onClose: () => void }) {
  if (!receipt) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
  const me = c.pocket!.me.toBase58();
  const m = mintOf(receipt.bundle);
  const fmt = (n: bigint) => `${m ? formatUnits(n, m.decimals) : n.toString()} ${m ? m.symbol : "units"}`;
  return (
    <Sheet visible onClose={onClose} title="It settled" lede={`${fmt(receipt.toRecipient)} reached ${receipt.to === me ? "you" : shorten(receipt.to)} after ${receipt.carriers.length + 1} ${receipt.carriers.length ? "hands" : "hand"}. Everyone below has been paid.`}>
      <Receipt title="CARRIER · SETTLEMENT" subtitle={receipt.signatures[0] ? `TX ${receipt.signatures[0].slice(0, 8)}…` : undefined}>
        <View style={{ alignItems: "center", marginVertical: 8 }}>
          <SettledStamp />
        </View>
        <Row
          label={receipt.to === me ? "Paid to you" : `Paid to ${shorten(receipt.to)}`}
          value={fmt(receipt.toRecipient)}
          tone={receipt.to === me ? "earned" : undefined}
        />
        {receipt.carriers.map((k, i) => (
          <Row
            key={`${k.key}${i}`}
            label={k.you ? "Carrier (you)" : `Carrier ${shorten(k.key)}`}
            value={fmt(k.amount)}
            tone={k.you ? "earned" : undefined}
          />
        ))}
        {receipt.kept > 0n ? <Row label="Back to the sender’s pouch" value={fmt(receipt.kept)} /> : null}
      </Receipt>
      <Dock>
        <Button label="Done" onPress={onClose} />
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
      <Receipt title="THIS PHONE HOLDS">
        <Row label="SOL, for fees" value={b ? (Number(b.sol) / 1e9).toFixed(3) : "unknown"} tone={b && !lowSol ? "earned" : "error"} />
        <Row label={`${MINT_SYMBOL}, to commit`} value={b && b.token !== null ? money(b.token) : "unknown"} tone={b && !lowToken ? "earned" : "error"} />
      </Receipt>
      <Text style={[ps.label, { marginTop: 18 }]}>Offline allowance</Text>
      <Text style={ps.help}>The most you can have out in payments nobody has settled yet.</Text>
      <Picks
        label={`Offline allowance in ${MINT_SYMBOL}`}
        options={ALLOWANCE_CHOICES}
        value={pick}
        onChange={setPick}
        render={(v) => ({ text: String(v), small: MINT_SYMBOL, spoken: `${v} ${MINT_SYMBOL}` })}
      />
      <Text style={ps.small}>
        Plus a bond of {money(bond)}. It is only taken if this phone ever signs two payments against the same slot, and then it pays
        whoever was cheated.
      </Text>
      {c.pouchBusy ? (
        <Text style={ps.status} accessibilityLiveRegion="polite">
          {c.pouchBusy}…
        </Text>
      ) : null}
      {c.pouchError ? (
        <Text style={ps.error} accessibilityLiveRegion="assertive">
          {c.pouchError}
        </Text>
      ) : null}
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
      ["No warranty", "Carrier is provided as it is, without warranty of any kind. The radio layer has not been tested across Android devices. Do not use this build to move anything you cannot afford to lose."],
    ],
  },
  privacy: {
    title: "Privacy policy",
    parts: [
      ["What stays on your phone", "Your key, the payments you are carrying, and the list of people you have met. None of it is sent to us. We do not run a server that could receive it."],
      ["What other phones see", "Phones within radio range see a random identifier while Carrier is open. When you hand a payment over, the other phone learns your public key."],
      ["What becomes public", "When a payment settles, the public key of each person who carried it, the time of each handoff, the amount, the sender and the recipient are written to Solana, which anyone can read and nobody can delete. Public keys are not names, but someone who knows your key can infer where you were near another carrier."],
      ["Location", "Android requires location permission before an app can scan for nearby devices. Carrier asks for it for that reason alone and never reads your location."],
      ["What we do not collect", "No name, email, phone number, contacts, location, advertising identifier or analytics."],
    ],
  },
};

export function LegalSheet({ which, onClose }: { which: "terms" | "privacy" | null; onClose: () => void }) {
  if (!which) return <Sheet visible={false} onClose={onClose} title="">{null}</Sheet>;
  const doc = LEGAL[which];
  return (
    <Sheet visible onClose={onClose} title={doc.title} lede="Last updated 23 September 2026" tall>
      {doc.parts.map(([h, p]) => (
        <View key={h} style={{ marginBottom: 14 }}>
          <Text style={ps.h4} accessibilityRole="header">
            {h}
          </Text>
          <Text style={ps.p}>{p}</Text>
        </View>
      ))}
      <Dock>
        <Button label="Close" variant="quiet" onPress={onClose} />
      </Dock>
    </Sheet>
  );
}

export const LEGAL_TEXT = LEGAL;

const ps = StyleSheet.create({
  list: { borderTopWidth: 1.5, borderColor: C.ink, marginBottom: 18 },
  person: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderColor: C.rule, paddingHorizontal: 4 },
  personKey: { fontFamily: FONT.mono, fontSize: 16, fontWeight: "700", color: C.ink },
  personMeta: { fontFamily: FONT.face, fontSize: 14, color: C.ink2 },
  label: { fontFamily: FONT.face, fontSize: 16, fontWeight: "800", color: C.ink, marginBottom: 6 },
  help: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginBottom: 12 },
  input: {
    minHeight: 52,
    borderWidth: 2,
    borderColor: C.ink,
    borderRadius: 6,
    paddingHorizontal: 14,
    fontFamily: FONT.mono,
    fontSize: 16,
    color: C.ink,
    backgroundColor: C.card,
  },
  amount: { fontSize: 32, fontWeight: "700", minHeight: 64 },
  error: { fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.red, marginTop: 8, fontWeight: "700" },
  status: { fontFamily: FONT.mono, fontSize: 13, color: C.ink2, marginTop: 10 },
  small: { fontFamily: FONT.face, fontSize: 14, lineHeight: 20, color: C.ink2, marginTop: 14 },
  p: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2 },
  h4: { fontFamily: FONT.face, fontSize: 16, fontWeight: "800", color: C.ink, marginBottom: 4 },
});


import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { PublicKey } from "@solana/web3.js";
import { MeshError, type Bundle } from "@carrier/mesh";
import { noteKey } from "../chain";
import { shorten } from "../format";
import { QrError, SlipReader, keyCode, readKey, readReceipt, receiptCode, slipCodes } from "../qr/codec";
import { C, R } from "../theme";
import { FONT } from "../ui/fonts";
import { QrCode } from "../ui/QrCode";
import { Scanner } from "../ui/Scanner";
import { Button, CheckBurst, Dock, Sheet, announce, buzz } from "../ui/kit";
import type { Carrier } from "../useCarrier";
import { ErrorLine } from "./Sheets";

/**
 * Handing a payment over by QR code, for when the radio can't: an iPhone and
 * an Android, or radios off. Face to face, three codes:
 *
 *   receiver  shows its key             ("Show them your code")
 *   giver     scans it, shows the slip  signed over to that key only
 *   receiver  scans the slip, checks every signature, shows a receipt
 *   giver     scans the receipt (optional) and lets the payment go
 */
export type QrStart = { kind: "receive" } | { kind: "give"; bundle: Bundle };

type Step =
  | { kind: "receive"; step: "code" | "scan" }
  | { kind: "receive"; step: "taken"; bundle: Bundle; receipt: string }
  | { kind: "give"; step: "scan-key"; bundle: Bundle }
  | { kind: "give"; step: "show"; bundle: Bundle; to: PublicKey; codes: string[] }
  | { kind: "give"; step: "scan-receipt"; bundle: Bundle; to: PublicKey; codes: string[] };

const FLIP_MS = 900;

export function QrHandoff({ c, start, onClose }: { c: Carrier; start: QrStart | null; onClose: () => void }) {
  const pocket = c.pocket!;
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ got: number; total: number } | null>(null);
  const reader = useRef(new SlipReader());

  useEffect(() => {
    setError(null);
    setProgress(null);
    reader.current = new SlipReader();
    setStep(start ? (start.kind === "receive" ? { kind: "receive", step: "code" } : { kind: "give", step: "scan-key", bundle: start.bundle }) : null);
  }, [start]);

  const go = (s: Step) => {
    setError(null);
    setProgress(null);
    setStep(s);
  };
  // From the camera to a sheet: iOS won't present one modal while another is
  // still sliding away, so let the scanner go first.
  const goFromCamera = (s: Step) => setTimeout(() => go(s), 450);
  const close = () => {
    setStep(null);
    onClose();
  };
  const why = (e: unknown) => (e instanceof QrError || e instanceof MeshError || e instanceof Error ? e.message : String(e));

  // --- receiving ------------------------------------------------------------------

  const onSlipCode = async (text: string) => {
    if (readKey(text)) return setError("That's their code, not a payment. Ask them to tap Show as QR on the slip, then scan that.");
    let got;
    try {
      got = reader.current.add(text);
    } catch (e) {
      return setError(`That code didn't read as a payment: ${why(e)}.`);
    }
    if (!got) return setError("That isn't a Carrier code.");
    setError(null);
    if (got.kind === "progress") {
      setProgress(got);
      announce(`Got part ${got.got} of ${got.total}.`);
      return;
    }
    try {
      const { bundle, receipt } = await pocket.qrTake(got.offer, got.giver);
      buzz("land");
      goFromCamera({ kind: "receive", step: "taken", bundle, receipt: receiptCode(noteKey(bundle), pocket.me, receipt) });
    } catch (e) {
      setError(`Not taken: ${why(e)}. Nothing moved.`);
    }
  };

  // --- giving -----------------------------------------------------------------------

  const onKeyCode = (bundle: Bundle) => (text: string) => {
    const to = readKey(text);
    if (!to) {
      return setError(
        text.startsWith("CS1/") || text.startsWith("CR1/")
          ? "That's a payment code. Ask them to tap Scan, then scan the code their phone shows."
          : "That isn't a Carrier code. Ask them to tap Scan, then scan the code their phone shows.",
      );
    }
    try {
      const codes = slipCodes(pocket.me, pocket.qrOffer(noteKey(bundle), to));
      buzz("tap");
      goFromCamera({ kind: "give", step: "show", bundle, to, codes });
    } catch (e) {
      setError(`Can't hand it to ${shorten(to)}: ${why(e)}.`);
    }
  };

  const onReceiptCode = (s: Extract<Step, { step: "scan-receipt" }>) => (text: string) => {
    const r = readReceipt(text);
    if (!r) return setError("That isn't their receipt. It's the small code on their phone after they scan your slip.");
    if (r.noteHash !== noteKey(s.bundle) || !r.peer.equals(s.to)) return setError("That receipt is for a different payment.");
    if (!pocket.acknowledged(r.peer, r.noteHash, r.signature)) {
      return setError("That receipt doesn't check out, or it's too old. The payment is still with you.");
    }
    buzz("success");
    c.say(`Handed over. ${shorten(s.to)} is carrying it now.`);
    close();
  };

  if (!step) return null;

  return (
    <>
      <Sheet
        visible={step.kind === "receive" && step.step === "code"}
        onClose={close}
        title="Show them your code"
        lede="They scan this, and sign the payment over to you. It works between iPhone and Android, with no radio."
        center
      >
        <View style={q.qrCard}>
          <QrCode value={keyCode(pocket.me)} size={210} label="Your Carrier code" />
        </View>
        <Text style={q.key}>{shorten(pocket.me)}</Text>
        <Dock>
          <Button label="Next: scan their slip" onPress={() => go({ kind: "receive", step: "scan" })} />
          <Button label="Cancel" variant="quiet" onPress={close} />
        </Dock>
      </Sheet>

      <Scanner
        visible={step.kind === "receive" && step.step === "scan"}
        title="Scan their slip"
        onCode={onSlipCode}
        onClose={close}
        feed={c.services.scanFeed ? () => c.services.scanFeed!("slip") : undefined}
      >
        <Progress
          title={progress ? `Got part ${progress.got} of ${progress.total}` : "Point it at their code"}
          sub={progress ? "Keep it in the frame. The next part is coming." : "Their payment shows as a code that flips on its own."}
          progress={progress}
          error={error}
        />
      </Scanner>

      <Sheet
        visible={step.kind === "receive" && step.step === "taken"}
        onClose={close}
        hero={<View style={{ alignItems: "center", marginTop: 8, marginBottom: 12 }}><CheckBurst /></View>}
        title={
          step.kind === "receive" && step.step === "taken"
            ? step.bundle.note.to.equals(pocket.me)
              ? `${c.amountText(step.bundle)} is yours`
              : `You're carrying ${c.amountText(step.bundle)}`
            : ""
        }
        lede="Every signature on it checked out. Now let them scan your receipt, so their phone knows it's handed over."
        center
      >
        {step.kind === "receive" && step.step === "taken" ? (
          <View style={[q.qrCard, { padding: 14 }]}>
            <QrCode value={step.receipt} size={164} label="Your receipt code" />
          </View>
        ) : null}
        <Dock>
          <Button label="Done" onPress={close} />
        </Dock>
        <Text style={q.small}>Skipped the receipt? It still settles. Their phone just shows it as handed, not confirmed.</Text>
      </Sheet>

      <Scanner
        visible={step.kind === "give" && step.step === "scan-key"}
        title="Scan their code"
        onCode={step.kind === "give" ? onKeyCode(step.bundle) : () => {}}
        onClose={close}
        feed={c.services.scanFeed ? () => c.services.scanFeed!("key") : undefined}
      >
        <Progress title="Scan their code" sub="Ask them to tap Scan in Carrier. Their phone shows a code with their key." error={error} />
      </Scanner>

      {step.kind === "give" && step.step === "show" ? (
        <ShowSlip
          c={c}
          bundle={step.bundle}
          to={step.to}
          codes={step.codes}
          onReceipt={() => go({ ...step, step: "scan-receipt" })}
          onClose={close}
        />
      ) : null}

      <Scanner
        visible={step.kind === "give" && step.step === "scan-receipt"}
        title="Scan their receipt"
        onCode={step.kind === "give" && step.step === "scan-receipt" ? onReceiptCode(step) : () => {}}
        onClose={() => (step.kind === "give" && step.step === "scan-receipt" ? go({ ...step, step: "show" }) : close())}
        feed={
          c.services.scanFeed && step.kind === "give" && step.step === "scan-receipt"
            ? () => c.services.scanFeed!("receipt", step.codes)
            : undefined
        }
      >
        <Progress title="Scan their receipt" sub="Once they've scanned your slip, their phone shows a small code. Scan it and you're done." error={error} />
      </Scanner>
    </>
  );
}

/** The slip as a code that flips through its parts, for the other phone to read. */
function ShowSlip({
  c,
  bundle,
  to,
  codes,
  onReceipt,
  onClose,
}: {
  c: Carrier;
  bundle: Bundle;
  to: PublicKey;
  codes: string[];
  onReceipt: () => void;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (codes.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % codes.length), FLIP_MS);
    return () => clearInterval(t);
  }, [codes]);
  return (
    <Sheet visible onClose={onClose} title="Let them scan this" lede={`Signed over to ${shorten(to)}. Only their phone can take it.`}>
      <View style={[q.qrCard, { padding: 18 }]}>
        <QrCode value={codes[i]!} size={264} label={`Payment code, part ${i + 1} of ${codes.length}`} />
      </View>
      {codes.length > 1 ? (
        <>
          <View style={q.parts} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            {codes.map((_, k) => (
              <View key={k} style={[q.part, k === i && q.partOn]} />
            ))}
          </View>
          <Text style={q.partText}>
            Part {i + 1} of {codes.length} · it flips on its own
          </Text>
        </>
      ) : null}
      <View style={q.mini}>
        <Text style={q.miniAmt}>{c.amountText(bundle)}</Text>
        <Text style={q.miniFor}>for {shorten(bundle.note.to)}</Text>
      </View>
      <Dock>
        <Button label="Scan their receipt" onPress={onReceipt} />
        <Button label="Done for now" variant="quiet" onPress={onClose} />
      </Dock>
    </Sheet>
  );
}

function Progress({
  title,
  sub,
  progress,
  error,
}: {
  title: string;
  sub: string;
  progress?: { got: number; total: number } | null;
  error: string | null;
}) {
  return (
    <View accessibilityLiveRegion="polite">
      <Text style={q.cardTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={q.cardSub}>{sub}</Text>
      {progress ? (
        <View style={q.bar}>
          <View style={[q.barFill, { width: `${Math.round((progress.got / progress.total) * 100)}%` }]} />
        </View>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
    </View>
  );
}

const q = StyleSheet.create({
  qrCard: { alignSelf: "center", backgroundColor: C.card, borderRadius: R.card + 4, padding: 20, marginTop: 6 },
  key: { textAlign: "center", fontFamily: FONT.mono, fontSize: 15, fontWeight: "600", color: C.ink, marginTop: 14 },
  small: { textAlign: "center", fontFamily: FONT.face, fontSize: 13, lineHeight: 19, color: C.ink2, marginTop: 12 },
  parts: { flexDirection: "row", gap: 6, justifyContent: "center", marginTop: 14 },
  part: { width: 28, height: 6, borderRadius: 3, backgroundColor: C.paper2 },
  partOn: { backgroundColor: C.slipDeep },
  partText: { textAlign: "center", fontFamily: FONT.face, fontSize: 14, color: C.ink2, marginTop: 8 },
  mini: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: C.slip, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, marginTop: 16 },
  miniAmt: { fontFamily: FONT.face, fontSize: 22, fontWeight: "800", letterSpacing: -0.5, color: C.slipInk },
  miniFor: { flex: 1, fontFamily: FONT.face, fontSize: 14, color: C.slipInk2 },
  cardTitle: { fontFamily: FONT.face, fontSize: 22, fontWeight: "800", letterSpacing: -0.4, color: C.ink },
  cardSub: { fontFamily: FONT.face, fontSize: 15, lineHeight: 21, color: C.ink2, marginTop: 4 },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.paper2, marginTop: 14, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 4, backgroundColor: C.slipDeep },
});

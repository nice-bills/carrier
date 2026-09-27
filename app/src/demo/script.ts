import { splitPayout } from "../ledger";
import { formatAmount } from "../amounts";
import { noteKey } from "../chain";
import { shorten } from "../format";
import type { DemoScript } from "../../App";
import { cast, type DemoOptions } from "./services";
import { demoPlace } from "../map/demoCampus";
import { lastAt } from "../map/geo";

/**
 * Which screen the browser preview opens on, from its query string:
 *
 *   ?screen=onboarding&step=0..4   first run, at a step
 *   ?screen=carry                  Carry tab: two slips, three people in range
 *   ?screen=around                 Around tab: people and the logbook
 *   ?screen=you                    You tab: rank, pouch, key
 *   ?screen=pay&step=who|amount|confirm   the pay sheet
 *   ?screen=confirm                confirm sheet for handing the slip to Zanele
 *   ?screen=pass                   Carry, slip lifted over Zanele mid-drag
 *   ?screen=settle                 the settlement receipt for the slip paid to you
 *   ?screen=pouch                  You tab with the pouch setup sheet
 *   ?screen=terms | privacy        the small print
 *   ?screen=rankup                 the new-rank screen, as if you just became a Carrier
 *   ?screen=failed                 the sheet for a handoff that did not finish
 *   ?screen=map                    Map tab, "This payment", on your route that settled
 *   ?screen=map&view=today         Map tab, "Seen today": every route this phone has seen
 *   ?screen=map&off=1              Map tab with the map still off: the opt-in card
 *
 * Add `&reduced=1` for reduced motion, `&offline=1` for no signal,
 * `&nopouch=1` for a phone with no pouch, `&alone=1` for nobody in range.
 */
export function demoFromQuery(query: string): { options: DemoOptions; script: DemoScript } {
  const q = new URLSearchParams(query);
  const screen = q.get("screen") ?? "carry";
  const flag = (k: string) => q.get(k) === "1" || q.get(k) === "true";
  const options: DemoOptions = { offline: flag("offline"), noPouch: flag("nopouch"), alone: flag("alone") };
  // The preview's campus has names for its places; a phone never does.
  const script: DemoScript = { reducedMotion: flag("reduced") ? true : undefined, placeName: demoPlace };
  const zanele = cast.zanele.publicKey.toBase58();

  switch (screen) {
    case "onboarding": {
      const step = Math.max(0, Math.min(4, Number(q.get("step") ?? 0) || 0));
      if (step < 3) options.noKey = true;
      else options.notOnboarded = true;
      script.onboardingStep = step;
      if (step === 4) script.stage = (c) => c.startRadio();
      break;
    }
    case "around":
      script.tab = "around";
      break;
    case "you":
      script.tab = "you";
      break;
    case "pay": {
      script.sheet = "pay";
      const step = (q.get("step") ?? "confirm") as DemoScript["payStep"];
      script.payStep = step;
      if (step !== "who") script.payTo = zanele;
      if (step === "confirm") script.payAmount = q.get("amount") ?? "5";
      break;
    }
    case "confirm":
      script.sheet = "pass";
      script.passTo = zanele;
      break;
    case "pass":
      script.dragOver = zanele;
      script.selected = zanele;
      break;
    case "settle":
      script.stage = (c) => {
        const b = c.slips.find((x) => x.note.to.equals(cast.me.publicKey));
        if (!b) return;
        const split = splitPayout(b.note.amount, b.note.relayFeeBps, b.hops.length);
        c.showReceipt({
          hash: noteKey(b),
          amount: formatAmount(b).text,
          to: b.note.to.toBase58(),
          toRecipient: split.toRecipient,
          carriers: b.hops.map((h) => ({ key: h.relayer.toBase58(), amount: split.perRelayer, you: false })),
          kept: split.kept,
          signatures: ["5DemoSettLeMentSigNatureXyZ"],
          bundle: b,
        });
      };
      break;
    case "pouch":
      script.tab = "you";
      script.sheet = "pouch";
      options.noPouch = true;
      break;
    case "map":
      script.tab = "map";
      script.mapView = q.get("view") === "today" ? "today" : "route";
      script.mapFocus = (routes) =>
        routes.filter((r) => r.mine && r.settled).sort((a, b) => lastAt(b) - lastAt(a))[0]?.id ?? null;
      if (flag("off")) options.mapOff = true;
      break;
    case "rankup":
      script.rankUp = q.get("rank") ?? "Carrier";
      break;
    case "failed":
      script.stage = (c) => {
        const b = c.slips.find((x) => !x.note.to.equals(cast.me.publicKey)) ?? c.slips[0];
        if (b) c.showHandFailed({ peer: cast.zanele.publicKey, noteHash: noteKey(b), reason: `${shorten(cast.zanele.publicKey)} walked out of range.` });
      };
      break;
    case "terms":
    case "privacy":
      script.tab = "you";
      script.sheet = screen;
      break;
    default:
      script.tab = "carry";
  }
  return { options, script };
}

import { describe, expect, it } from "vitest";
import { noteKey } from "../chain";
import { cast, demoServices } from "./services";
import { demoFromQuery } from "./script";

/** The browser preview's fake device, driven the way the app drives it. */
describe("demo device", () => {
  it("boots with two real slips, a pouch, and three people in range", async () => {
    const s = demoServices();
    const w = (await s.existingWallet())!;
    const { pocket } = await s.openPocket(w);
    expect(pocket.onboarded).toBe(true);
    expect(pocket.list()).toHaveLength(2);
    expect(pocket.spendable()).toBe(22_000_000n);
    const ready: string[] = [];
    const radio = s.createRadio(w, pocket, { peerReady: (p) => ready.push(p.toBase58()) });
    await radio.advertise(w.publicKey);
    await new Promise((r) => setTimeout(r, 900));
    expect(ready).toHaveLength(3);
    // Mei has something to hand over.
    expect(await radio.digests(cast.mei.publicKey)).toHaveLength(1);
  });

  it("delivers the carried slip to Zanele when handed over", async () => {
    const s = demoServices();
    const w = (await s.existingWallet())!;
    const { pocket } = await s.openPocket(w);
    const radio = s.createRadio(w, pocket, {});
    await radio.advertise(w.publicKey);
    const slip = pocket.list().find((b) => b.note.to.equals(cast.zanele.publicKey))!;
    const hash = noteKey(slip);
    pocket.handTo(hash, cast.zanele.publicKey);
    await radio.hand(cast.zanele.publicKey, [hash]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(pocket.node.holds(hash)).toBe(false);
    expect(pocket.feed[0]!.kind).toBe("delivered");
  });

  it("pays someone and settles what was paid to this phone", async () => {
    const s = demoServices();
    const w = (await s.existingWallet())!;
    const { pocket } = await s.openPocket(w);
    const b = await pocket.pay({ to: cast.kofi.publicKey, amount: 2_000_000n, relayFeeBps: 200, pickSlot: s.chain.nextFreeSlot });
    expect(b.note.slotIndex).toBe(2); // 0, 1, 3 settled in the fixture
    const mine = pocket.list().find((x) => x.note.to.equals(w.publicKey))!;
    const { signatures } = await s.chain.settle(w, mine);
    const r = pocket.settledHere(mine, signatures);
    expect(r.carriers).toHaveLength(1);
    expect(r.toRecipient + r.carriers[0]!.amount + r.kept).toBe(mine.note.amount);
  });

  it("maps every preview screen", () => {
    for (const q of ["?screen=onboarding&step=4", "?screen=carry", "?screen=around", "?screen=you", "?screen=pay&step=confirm", "?screen=confirm", "?screen=pass", "?screen=settle", "?screen=pouch"]) {
      expect(demoFromQuery(q).script).toBeTruthy();
    }
    expect(demoFromQuery("?screen=onboarding&step=1").options.noKey).toBe(true);
  });
});

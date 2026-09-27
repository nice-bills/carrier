import { describe, expect, it } from "vitest";
import { noteKey } from "../chain";
import { DEMO_CENTRE } from "../map/demoCampus";
import { cast, demoServices } from "./services";
import { places } from "./places";
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

  it("starts with the map on and believable routes around the demo campus", async () => {
    const s = demoServices();
    const w = (await s.existingWallet())!;
    const { pocket } = await s.openPocket(w);
    expect(pocket.mapOn).toBe(true);
    const routes = pocket.routes();
    // Two slips in the pocket, plus six seeded: sent, carried and settled, seen in passing.
    expect(routes).toHaveLength(8);
    expect(routes.filter((r) => r.mine)).toHaveLength(4);
    expect(routes.some((r) => r.mine && r.settled && r.points.filter((p) => p.kind === "hop").length >= 3)).toBe(true);
    for (const p of routes.flatMap((r) => r.points)) {
      expect(Math.abs(p.cell.lat - DEMO_CENTRE.lat)).toBeLessThan(0.004);
      expect(Math.abs(p.cell.lon - DEMO_CENTRE.lon)).toBeLessThan(0.004);
    }
    expect(await s.location.fix(1500)).toEqual(places.me);
    // This phone added its own point as it took each seeded slip.
    const me = w.publicKey.toBase58();
    expect(routes.filter((r) => r.points.some((p) => p.who === me && p.kind === "hop"))).not.toHaveLength(0);
    // Handing the carried slip on: Zanele's point is hers to add, so this phone keeps none naming her.
    pocket.setLocator(() => places.me);
    const radio = s.createRadio(w, pocket, {});
    await radio.advertise(w.publicKey);
    const slip = pocket.list().find((b) => b.note.to.equals(cast.zanele.publicKey))!;
    const hash = noteKey(slip);
    pocket.handTo(hash, cast.zanele.publicKey);
    await radio.hand(cast.zanele.publicKey, [hash]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(pocket.node.holds(hash)).toBe(false);
    expect(pocket.trailFor(hash).map((p) => `${p.kind}${p.seq}`)).toEqual(["sent0", "hop0", "hop1"]);
    expect(pocket.trailFor(hash).some((p) => p.who === cast.zanele.publicKey.toBase58())).toBe(false);
  });

  it("can start with the map off", async () => {
    const s = demoServices({ mapOff: true });
    const { pocket } = await s.openPocket((await s.existingWallet())!);
    expect(pocket.mapOn).toBe(false);
  });

  it("maps every preview screen", () => {
    for (const q of ["?screen=onboarding&step=4", "?screen=carry", "?screen=around", "?screen=you", "?screen=pay&step=confirm", "?screen=confirm", "?screen=pass", "?screen=settle", "?screen=pouch"]) {
      expect(demoFromQuery(q).script).toBeTruthy();
    }
    expect(demoFromQuery("?screen=onboarding&step=1").options.noKey).toBe(true);
  });
});

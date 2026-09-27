// Walk the whole first-run journey on an emulated Pixel 7 (touch, Android
// browser, phone viewport) against the running preview, with a real touch drag
// of a slip onto a person. Saves a screenshot per step and a video to OUT.
//   npm run preview          (in another terminal)
//   node preview/phone-run.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { chromium, devices } from "playwright-core";
const OUT = process.argv[2] ?? "phone-run";
mkdirSync(OUT, { recursive: true });
const dev = devices["Pixel 7"];
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ ...dev, recordVideo: { dir: `${OUT}/video`, size: dev.viewport } });
const p = await ctx.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
p.on("response", (r) => { if (r.status() >= 400) errs.push("HTTP " + r.status() + " " + r.url()); });
p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message.slice(0, 200)));
let n = 0;
const snap = async (name) => p.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png` });
const step = async (name, fn, wait = 1300) => {
  try { await fn(); console.log("ok", name); } catch (e) { console.log("FAIL", name, e.message.split("\n")[0]); }
  await p.waitForTimeout(wait); await snap(name);
};
const tapText = (t, o = {}) => p.getByText(t, o).last().tap();
await p.goto((process.env.PREVIEW_URL ?? "http://localhost:5199/") + "?screen=onboarding&step=0", { waitUntil: "networkidle", timeout: 120000 });
await p.waitForTimeout(2500); await snap("welcome");
await step("set up", () => tapText("Set up this phone", { exact: true }), 6000);
await step("allow nearby", () => tapText("Allow nearby access", { exact: true }));
await step("continue", () => tapText("Continue", { exact: true }));
await step("make key", () => tapText("Make my key", { exact: true }), 2000);
await step("continue2", () => tapText("Continue", { exact: true }));
await step("sign terms", () => p.getByLabel("Sign to agree").tap());
await step("start carrying", () => tapText("Start carrying", { exact: true }), 6000);
await step("tap holder", () => p.getByText("holding 1 payment", { exact: false }).last().tap(), 2500);
await step("take it", async () => { const t = await p.getByRole("button").allInnerTexts(); console.log("after tap:", t.map(x=>x.replace(/\s+/g," ").trim()).join(" | ")); }, 300);
await step("open pocket", () => tapText("Open my pocket", { exact: true }), 2500);
await step("stop tips", () => tapText("Got it, stop the tips", { exact: true }));
// Real touch drag of the slip onto the first person, via CDP touch events.
await step("drag slip", async () => {
  const cdp = await ctx.newCDPSession(p);
  const slip = await p.getByText("drag me onto someone").boundingBox();
  const who = await p.getByText("Fr9T…d7Pp").last().boundingBox();
  const pt = (x, y) => [{ x, y, id: 1 }];
  const sx = slip.x + slip.width / 2, sy = slip.y - 60, tx = who.x + 40, ty = who.y + who.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(sx, sy) });
  for (let i = 1; i <= 25; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(sx + (tx - sx) * i / 25, sy + (ty - sy) * i / 25) }); await p.waitForTimeout(30); }
  await p.waitForTimeout(400); await snap("drag-over");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}, 1500);
const texts = async (l) => console.log(l, (await p.getByRole("button").allInnerTexts()).map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean).join(" | "));
await texts("after drag:");
await step("confirm hand", () => p.getByText(/^Hand (it )?over|^Sign and hand/).last().tap(), 2500);
await texts("after hand:");
await step("pick", () => p.getByText("8Etn…DHKs").first().tap());
await step("pay", () => p.getByText(/^Pay 8Etn/).last().tap());
await step("amount", async () => { await p.getByPlaceholder("0.00").tap(); await p.keyboard.type("5"); });
await step("next", () => tapText("Next", { exact: true }));
await step("sign pay", () => p.getByText(/Sign and hand over/).last().tap(), 2500);
await texts("after pay:");
await step("around", () => tapText("Around", { exact: true }), 1500);
await step("you", () => tapText("You", { exact: true }), 1500);
await step("carry", () => tapText("Carry", { exact: true }), 1500);
console.log("tips visible after tab switch:", await p.getByText("Got it, stop the tips").count());
const btns = await p.getByRole("button").allInnerTexts();
console.log("buttons:", btns.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 25).join(" | "));
console.log("errors:", errs.length, errs.slice(0, 5));
await ctx.close(); await b.close();

// Both sides of a QR handoff on an emulated phone, against the running preview.
// The pretend camera plays the other phone (Mei). Screenshots and a video go to OUT.
//   npm run preview          (in another terminal)
//   DEVICE="iPhone 15" node preview/qr-run.mjs [out-dir]
import { mkdirSync } from "node:fs";
import { chromium, devices } from "playwright-core";
const OUT = process.argv[2] ?? "qr-run";
mkdirSync(OUT, { recursive: true });
const DEVICE = process.env.DEVICE ?? "iPhone 15";
const dev = devices[DEVICE];
const os = /iphone/i.test(DEVICE) ? "&os=ios" : "";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await b.newContext({ ...dev, recordVideo: { dir: `${OUT}/video`, size: dev.viewport } });
const p = await ctx.newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
p.on("pageerror", (e) => errs.push("PAGEERROR " + e.message.slice(0, 200)));
let n = 0;
const failed = [];
const snap = async (name) => p.screenshot({ path: `${OUT}/${String(++n).padStart(2, "0")}-${name}.png` });
const step = async (name, fn, wait = 1300) => {
  try { await fn(); console.log("ok", name); } catch (e) { failed.push(name); console.log("FAIL", name, e.message.split("\n")[0]); }
  await p.waitForTimeout(wait); await snap(name);
};
const tap = (t) => p.getByText(t, { exact: true }).last().tap();
const waitText = (t, timeout = 20000) => p.getByText(t, { exact: false }).last().waitFor({ timeout });

await p.goto((process.env.PREVIEW_URL ?? "http://localhost:5199/") + "?screen=carry" + os, { waitUntil: "networkidle", timeout: 120000 });
await p.waitForTimeout(3000);
await tap("Got it, stop the tips").catch(() => {});
await p.waitForTimeout(800); await snap("carry");

// Giving: show the slip as QR codes.
await step("show as qr", () => p.getByLabel("Show as QR code").tap(), 1500);
await step("their key scanned", () => waitText("Let them scan this"), 1200);
await step("slip part 2", () => p.waitForTimeout(900), 200);
await step("scan receipt", () => tap("Scan their receipt"), 1800);
await step("handed over", () => waitText("Handed over"), 800);

// Taking: show your code, scan theirs, show the receipt.
await step("scan button", () => p.getByLabel("Take a payment by QR code").tap(), 1500);
await step("scan their slip", () => tap("Next: scan their slip"), 1500);
await step("taken", () => waitText("Done", 25000), 1500);
await step("done", () => tap("Done"), 1500);

await ctx.close(); await b.close();
console.log(failed.length ? "FAILED: " + failed.join(", ") : "all steps ok");
console.log(errs.length ? "errors:\n" + [...new Set(errs)].join("\n") : "no console errors");

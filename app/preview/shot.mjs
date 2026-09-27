// Screenshot one preview screen: node preview/shot.mjs "?screen=carry" carry.png
// Needs the preview running (npm run preview -w app) and a Chromium; set
// CHROMIUM_PATH if Playwright has none of its own.
import { chromium } from "playwright-core";
const [,, query, out] = process.argv;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errs = [];
p.on("pageerror", e => errs.push(e.message));
p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
await p.goto((process.env.PREVIEW_URL ?? "http://localhost:5199/") + query, { waitUntil: "networkidle", timeout: 120000 });
await p.waitForTimeout(2000);
await p.screenshot({ path: out });
console.log(out, errs.slice(0, 5).join(" | "));
await b.close();

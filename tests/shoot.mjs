/** Screenshot the preview page so the UI can be reviewed. */
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:5199/demo/preview.html";
const out = process.argv[3] ?? "/tmp/voidshot-preview.png";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("console", (m) => {
  if (m.type() === "error") console.error("[page error]", m.text());
});
page.on("pageerror", (e) => console.error("[page exception]", e.message));

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__ready === true, { timeout: 15000 }).catch(() => {
  console.error("preview never signalled ready");
});
await page.waitForTimeout(600);
await page.screenshot({ path: out });
console.log("wrote", out);

await browser.close();

// Run on the browser runner: node test/e2e/streaming-lab.mjs <lab.html> <output>.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const [file, output] = process.argv.slice(2);
if (!file || !output) throw new Error("Usage: streaming-lab.mjs <lab.html> <output>");
await mkdir(output, { recursive: true });
const preview = path.join(output, "preview.html");
await copyFile(file, preview);
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1024, height: 1000 }, colorScheme: "dark", recordVideo: { dir: output } });
const page = await context.newPage();
const errors = [];
const measurements = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
try {
  for (const rate of [20, 60, 110]) for (const bursty of [false, true]) {
    await page.goto(pathToFileURL(path.resolve(preview)).href);
    await page.getByLabel("Replay speed", { exact: true }).focus();
    await page.keyboard.press("End");
    await page.getByLabel("Token rate", { exact: true }).selectOption(String(rate));
    await page.getByLabel("Bursty delivery", { exact: true }).setChecked(bursty);
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await page.waitForFunction(() => Number(/(\d+) received/.exec(document.querySelector(".lab-status")?.textContent ?? "")?.[1]) > 1500, undefined, { timeout: 20_000 });
    const status = await page.locator(".lab-status").textContent();
    const body = await page.locator(".md").textContent();
    if (!body) throw new Error("The paced reply is still invisible after 1,500 characters arrived");
    await page.screenshot({ path: path.join(output, `${rate}-${bursty ? "bursty" : "continuous"}.png`), fullPage: true });
    measurements.push({ rate, bursty, status, chars: body.length });
  }
  await page.getByRole("status").filter({ hasText: /^Finished/ }).waitFor({ timeout: 20_000 });
  if (!(await page.locator(".md").textContent()).includes("without an extra blank line")) throw new Error("The final text was truncated");
  await page.screenshot({ path: path.join(output, "finished.png"), fullPage: true });
  await page.getByRole("button", { name: "Replay", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^Thinking/ }).waitFor();
  await page.screenshot({ path: path.join(output, "replay.png"), fullPage: true });
  if (await page.getByLabel("Reveal", { exact: true }).count()) throw new Error("Obsolete reveal options remain");
  if (errors.length) throw new Error(JSON.stringify(errors));
} finally {
  await writeFile(path.join(output, "lab-results.json"), JSON.stringify({ errors, measurements }, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify({ cases: measurements.length, errors }));

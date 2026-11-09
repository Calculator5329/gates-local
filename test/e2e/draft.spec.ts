import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { getState, setState, editDraft } from "../../apps/web/src/store.ts";
import type { watchDraft } from "../../apps/web/src/draft-persistence.ts";
import { install, measure, type Observation } from "../perf/probe.ts";
import { quantile } from "../perf/stats.ts";
import { WEB_ORIGIN } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

declare global {
  interface Window {
    draftHarness: { watchDraft: typeof watchDraft; getState: typeof getState; setState: typeof setState; editDraft: typeof editDraft };
    draftWrites: { puts: number; stringBytes: number; putMs: number[]; active: number; maximum: number };
  }
}

function metadata(target: Page) {
  return target.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.addEventListener("success", () => {
      const db = opening.result;
      const key = new URL(new URL(location.href).searchParams.get("server")!).host;
      const request = db.transaction("drafts").objectStore("drafts").get(key);
      request.addEventListener("success", () => { db.close(); resolve(request.result); }, { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    }, { once: true });
    opening.addEventListener("error", () => reject(opening.error), { once: true });
  }));
}
const saved = (target: Page, draft: string) => expect.poll(() => metadata(target)).toMatchObject({ draft });

test("legacy image drafts migrate and recover after a completed metadata write", async ({ page, open }) => {
  await open(); await waitReady(page);
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  await page.evaluate(dataUrl => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open("gates-local.composer", 1);
    opening.addEventListener("success", () => {
      const db = opening.result;
      const key = new URL(new URL(location.href).searchParams.get("server")!).host;
      const transaction = db.transaction("drafts", "readwrite");
      transaction.objectStore("drafts").put({ draft: "legacy draft", images: [dataUrl], queued: [], editing: null }, key);
      transaction.addEventListener("complete", () => { db.close(); resolve(); }, { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    }, { once: true });
    opening.addEventListener("error", () => reject(opening.error), { once: true });
  }), image);
  await page.reload(); await waitReady(page);
  await expect(page.locator("#ta")).toHaveValue("legacy draft");
  await expect(page.locator(".att img")).toHaveCount(1);
  await page.locator("#ta").fill("migrated draft");
  await expect.poll(() => metadata(page)).toMatchObject({ format: 2, draft: "migrated draft" });
  await page.reload(); await waitReady(page);
  await expect(page.locator("#ta")).toHaveValue("migrated draft");
  await expect(page.locator(".att img")).toHaveAttribute("src", image);
});

test("two tabs keep the last writer's complete draft after another tab replaces or clears images", async ({ page, context, open }, info) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";
  const addImages = async (target: Page, count: number) => {
    await target.locator("#ta").focus();
    await target.evaluate(({ image, amount }) => {
      const data = new DataTransfer();
      for (let i = 0; i < amount; i++) data.items.add(new File([Uint8Array.from(atob(image), c => c.charCodeAt(0))], `image-${i}.png`, { type: "image/png" }));
      document.querySelector("#ta")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { image: png, amount: count });
    await expect(target.locator(".att img")).toHaveCount(count);
  };
  await open(); await waitReady(page);
  await addImages(page, 2);
  await page.locator("#ta").fill("A words"); await saved(page, "A words");
  const other = await context.newPage();
  try {
    await other.goto(page.url()); await waitReady(other);
    await expect(other.locator(".att img")).toHaveCount(2);
    for (let i = 0; i < 2; i++) await other.getByRole("button", { name: "Remove image 1", exact: true }).click();
    await addImages(other, 1);
    await other.locator("#ta").fill("B words"); await saved(other, "B words");
    await page.locator("#ta").fill("A final words"); await saved(page, "A final words");
    await page.reload(); await waitReady(page);
    await expect(page.locator("#ta")).toHaveValue("A final words");
    await expect(page.locator(".att img")).toHaveCount(2);
    await other.getByRole("button", { name: "Remove image 1", exact: true }).click();
    await other.locator("#ta").fill("B cleared"); await saved(other, "B cleared");
    await page.locator("#ta").fill("A words after B cleared"); await saved(page, "A words after B cleared");
    await page.reload(); await waitReady(page);
    await expect(page.locator("#ta")).toHaveValue("A words after B cleared");
    await expect(page.locator(".att img")).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("shared-draft.png") });
  } finally { await other.close(); }
});

// Opt-in diagnostic: bundles are prepared locally from the reviewed baseline
// and candidate. This runs inside the selected functional job, not a timing gate.
const inputs = process.env["GL_DRAFT_REVIEW_INPUTS"];
if (inputs) test("attachment-heavy typing uses bounded, small persistence writes", async ({ browser }, info) => {
  test.setTimeout(120_000);
  info.annotations.push({ type: "budget", description: "Compare ten edits with 80 MiB of draft images and 10 MiB of queued images in two isolated real-watcher harnesses." });
  const results: { arm: string; counters: Window["draftWrites"]; elapsed: number; frameP95: number; frameMax: number; inputDelayP95: number; longTasks: number; longTaskMs: number }[] = [];
  for (const arm of ["baseline", "candidate"]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await install(page);
      await page.addInitScript(() => {
        const counters = { puts: 0, stringBytes: 0, putMs: [] as number[], active: 0, maximum: 0 };
        window.draftWrites = counters;
        // All fixture strings are ASCII. Count payload strings without encoding
        // or serializing the large attachments a second time for this observer.
        const bytes = (value: unknown): number => {
          if (typeof value === "string") return value.length;
          if (Array.isArray(value)) return value.reduce<number>((n, item) => n + bytes(item), 0);
          if (value && typeof value === "object") return Object.entries(value).reduce((n, [key, item]) => n + key.length + bytes(item), 0);
          return 0;
        };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
          counters.puts++; counters.stringBytes += bytes(value);
          const at = performance.now();
          try { return key === undefined ? put.call(this, value) : put.call(this, value, key); }
          finally { counters.putMs.push(performance.now() - at); }
        };
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(...args: Parameters<typeof transaction>) {
          const tx = transaction.apply(this, args);
          if (args[1] === "readwrite") {
            counters.active++; counters.maximum = Math.max(counters.maximum, counters.active);
            let ended = false;
            const end = () => { if (!ended) { ended = true; counters.active--; } };
            tx.addEventListener("complete", end); tx.addEventListener("abort", end);
          }
          return tx;
        };
      });
      await page.route("**/draft-review/**", route => {
        if (route.request().url().endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: readFileSync(path.resolve(inputs, `${arm}.js`)) });
        return route.fulfill({ contentType: "text/html", body: '<textarea id="ta" aria-label="Message"></textarea><script type="module" src="/draft-review/watcher.js"></script>' });
      });
      await page.goto(`${WEB_ORIGIN}/draft-review/harness`);
      await page.waitForFunction(() => window.draftHarness !== undefined);
      await page.evaluate(async () => {
        await window.draftHarness.watchDraft("attachment-typing");
        const images = Array.from({ length: 8 }, (_, i) => "data:image/png;base64," + String(i).repeat(10 * 1024 * 1024));
        window.draftHarness.setState({ draftImages: images, queued: [{ id: "q", threadId: "t", text: "queued", images: ["data:image/png;base64," + "a".repeat(10 * 1024 * 1024)], at: 1, waitFor: "reply" }] });
        document.querySelector<HTMLTextAreaElement>("#ta")!.addEventListener("input", event => window.draftHarness.editDraft((event.target as HTMLTextAreaElement).value));
      });
      await expect.poll(() => page.evaluate(() => window.draftWrites.active), { timeout: 30_000 }).toBe(0);
      await page.evaluate(() => Object.assign(window.draftWrites, { puts: 0, stringBytes: 0, putMs: [], maximum: 0 }));
      const observations: Observation[] = [];
      const ta = page.locator("#ta"); await ta.focus();
      let text = "";
      for (const key of "abcdefghij") {
        text += key;
        observations.push(await measure(page, () => ta.press(key), "keydown", "#ta", text, "usable-value"));
      }
      await expect.poll(() => page.evaluate(() => window.draftWrites.active), { timeout: 30_000 }).toBe(0);
      const counters = await page.evaluate(() => window.draftWrites);
      results.push({ arm, counters, elapsed: quantile(observations.map(o => o.elapsed), .5), frameP95: quantile(observations.flatMap(o => o.frames), .95), frameMax: Math.max(...observations.flatMap(o => o.frames)), inputDelayP95: quantile(observations.flatMap(o => o.inputDelays), .95), longTasks: observations.reduce((n, o) => n + o.longTasks.length, 0), longTaskMs: observations.flatMap(o => o.longTasks).reduce((n, ms) => n + ms, 0) });
      await expect(ta).toHaveValue("abcdefghij");
      if (arm === "candidate") { expect(counters.maximum).toBe(1); expect(counters.stringBytes).toBeLessThan(64 * 1024); }
      else { expect(counters.puts).toBe(10); expect(counters.stringBytes).toBeGreaterThanOrEqual(900 * 1024 * 1024); }
    } finally { await context.close(); }
  }
  writeFileSync(info.outputPath("attachment-typing.json"), JSON.stringify(results, null, 2));
  console.log("ATTACHMENT_TYPING", JSON.stringify(results));
});

/// <reference lib="dom" />
// A reload in the middle of a model download: the new window reads the download where the server
// has it, and the bar never steps backwards, neither within one window nor from the old window's
// last frame to the new window's first. Every frame of both windows is sampled for the bar's value.
// Before the models kind was numbered, an answer to the new window's first read could land after a
// newer progress push and draw the bar a step back.
import type { Page } from "@playwright/test";
import { expect, modelRow, openModels, stack, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design", comfyUrl: "http://127.0.0.1:1" });

const MODEL = "qwen3.5:4b";
const BAR = `.mp-row[data-pull="${MODEL}"] [role="progressbar"]`;

interface Sample { readonly t: number; readonly pct: number }

/** Sample the row's bar every frame from the page's first script on, into window.barSamples. */
async function sampleEveryFrame(page: Page): Promise<void> {
  await page.addInitScript((selector: string) => {
    const samples: Sample[] = [];
    (window as unknown as { barSamples: Sample[] }).barSamples = samples;
    const tick = () => {
      const bar = document.querySelector(selector);
      const now = bar?.getAttribute("aria-valuenow");
      if (now !== null && now !== undefined) samples.push({ t: performance.now(), pct: Number(now) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, BAR);
}

const samplesOf = (page: Page) => page.evaluate(() => (window as unknown as { barSamples: Sample[] }).barSamples.slice());

/** The steps back in one window's samples, as "from → to" at each place it fell. */
const stepsBack = (samples: readonly Sample[]) =>
  samples.slice(1).flatMap((s, i) => (s.pct < (samples[i]?.pct ?? 0) ? [`${samples[i]?.pct} → ${s.pct}`] : []));

test("a reload during a model download picks the bar up where it was, and it never steps back", async ({ page, open }, info) => {
  test.setTimeout(60_000);
  info.annotations.push({ type: "budget", description: "One model download slowed to about 15 s, a reload in its middle, the rest of it sampled." });
  await sampleEveryFrame(page);
  await open();
  await waitReady(page);
  await stack.scenario("models", { pullTickMs: 300, pullChunkBytes: 128 * 1024 * 1024 });
  await openModels(page);
  const row = modelRow(page, MODEL);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.getByTestId("models.offered.download").click();
  await expect(row.getByTestId("models.downloading.cancel")).toBeVisible();
  // a few percents in, so the reload lands in the download's middle
  await expect.poll(async () => Number(await row.getByRole("progressbar").getAttribute("aria-valuenow")), { timeout: 15_000 }).toBeGreaterThanOrEqual(10);
  const before = await samplesOf(page);
  const last = before.at(-1)?.pct ?? 0;

  await page.reload();
  await waitReady(page);
  await openModels(page);
  await expect(row.getByRole("progressbar")).toBeVisible();
  await expect(row).toHaveAttribute("data-dm", MODEL, { timeout: 30_000 });
  const after = await samplesOf(page);

  info.attachments.push({ name: "bar.json", contentType: "application/json", body: Buffer.from(JSON.stringify({ before, after })) });
  expect(before.length, "frames sampled before the reload").toBeGreaterThan(10);
  expect(after.length, "frames sampled after the reload").toBeGreaterThan(10);
  expect(stepsBack(before), "steps back before the reload").toEqual([]);
  expect(stepsBack(after), "steps back after the reload").toEqual([]);
  expect(after[0]?.pct, "the new window's first bar against the old window's last").toBeGreaterThanOrEqual(last);
});

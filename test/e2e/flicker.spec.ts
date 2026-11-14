/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { burst, delayedMemory, memoryMetrics } from "./flicker-probe.ts";
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

/** The server's word on settings (its answer and its push) reaches the page `ms` late, in order; everything else on time. */
async function holdSettings(page: Page, ms: number): Promise<void> {
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    let last = 0;
    server.onMessage((message) => {
      if (ms === 0 || !String(message).includes('"defaultNumCtx"')) return ws.send(message);
      const at = Math.max(Date.now() + ms, last);
      last = at;
      setTimeout(() => ws.send(message), at - Date.now());
    });
  });
}

for (const delay of [0, 150, 600]) {
  // Guards the owner's ruling on GPU memory (R38): a context pick keeps its verdict and details, no flicker.
  test(`GPU memory context pick keeps its verdict and details at ${delay} ms`, async ({ page, open }) => {
    await delayedMemory(page, delay);
    await open();
    await waitReady(page);
    const gpu = await openGpuMemory(page);
    await expect(gpu.locator(".fp-v:visible")).toBeVisible();
    await gpu.locator("summary").click();
    await expect(gpu.locator('[data-ctx="32768"]')).toHaveAttribute("data-tip", /^(Runs on the GPU|Runs in system memory|Slower|Won't fit)/);
    const frames = await burst(page, `gpu-context-${delay}`, "#gpuMemory", () => gpu.locator('[data-ctx="32768"]').click());
    const metrics = memoryMetrics(frames);
    console.log(`FLICKER gpu-context-${delay} ${JSON.stringify(metrics)}`);
    expect(metrics.transients, "settled GPU memory must not disappear or return to a skeleton after a pick").toBe(0);
    expect(metrics.shiftPx, "context selection must not collapse the expanded details").toBeLessThanOrEqual(0.5);
    await expect(gpu.locator('[data-ctx="32768"]')).toHaveAttribute("aria-pressed", "true");
    // the pressed size says 32k; the verdict under it does not say it again
    await expect(gpu.locator(".fp-v:visible")).toHaveText(/\S/);
    await expect(gpu.locator(".fp-v:visible")).not.toContainText("32k");
  });

  // Settings row 30, found through a flaky release test: until the server saved the default, the
  // old size stayed pressed and the verdict said "at 32k", then lost it. The click shows the pick at once.
  test(`a Default context click shows the picked size at once and the verdict never says it, saved after ${delay} ms`, async ({ page, open }) => {
    await holdSettings(page, delay);
    await open();
    await waitReady(page);
    const gpu = await openGpuMemory(page);
    await expect(gpu.locator(".fp-v:visible")).toBeVisible();
    const size32 = gpu.locator('[data-ctx="32768"]');
    await expect(size32).toHaveAttribute("aria-pressed", "false");
    const frames = await burst(page, `gpu-context-save-${delay}`, "#gpuMemory", async () => {
      await size32.click();
      // pressed before the server's answer can arrive
      await expect(size32).toHaveAttribute("aria-pressed", "true", { timeout: delay > 0 ? delay / 2 : 5000 });
    });
    const said = frames.flatMap((f) => f.verdicts).filter((v) => v.includes("32k"));
    expect(said, "the verdict never names the size the control already shows").toEqual([]);
    await expect(size32).toHaveAttribute("aria-pressed", "true");
    await expect(gpu.locator('[data-ctx="16384"]')).toHaveAttribute("aria-pressed", "false");
  });

  // Guards a shipped bug fix: loading a model dropped the picker's earlier memory verdicts.
  test(`reopening the picker after loading keeps checked verdicts at ${delay} ms`, async ({ page, open }) => {
    await delayedMemory(page, delay);
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    const loading = page.locator("#picker .fit-skel, #picker .pk-cost.skel");
    await expect(loading).toHaveCount(0);
    // The context column follows the highlight. Check Gemma's contexts before
    // asking whether those same answers survive closing and loading it.
    const gemma = page.locator('#picker .pk-r[data-m="gemma4:12b"]');
    await gemma.hover();
    await expect(page.locator("#picker").getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
    await expect(loading).toHaveCount(0);
    await expect(page.locator("#picker")).not.toContainText("Checking…");
    await gemma.click();
    await expect(page.locator("#modelBtn")).not.toHaveAttribute("aria-busy", "true");
    const frames = await burst(page, `picker-reopen-${delay}`, "#picker", () => page.locator("#modelBtn").click());
    const visible = frames.filter((f) => Object.keys(f.boxes).length > 0);
    const checking = visible.filter((f) => f.checking);
    console.log(`FLICKER picker-reopen-${delay} ${JSON.stringify({ frames: visible.length, transients: new Set(checking.map((f) => f.text)).size, checkingFrames: checking.length })}`);
    expect(checking, "a model load must not erase verdicts already checked in the picker").toHaveLength(0);
  });
}

// Settings row 30: a size the server refuses to save goes back to the saved one, with the reason.
test("a Default context the server refuses to save goes back to the saved size and says why", async ({ page, open }) => {
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const req = JSON.parse(String(message)) as { id?: string; method?: string };
      if (req.method !== "settings.update") return server.send(message);
      setTimeout(() => ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "The settings file is read-only." } })), 300);
    });
    server.onMessage((message) => ws.send(message));
  });
  await open();
  await waitReady(page);
  const gpu = await openGpuMemory(page);
  const size32 = gpu.locator('[data-ctx="32768"]'), size16 = gpu.locator('[data-ctx="16384"]');
  await expect(size16).toHaveAttribute("aria-pressed", "true");
  await size32.click();
  await expect(size32, "the pick shows while the server answers").toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(size16).toHaveAttribute("aria-pressed", "true");
  await expect(size32).toHaveAttribute("aria-pressed", "false");
});

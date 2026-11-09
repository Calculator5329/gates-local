/// <reference lib="dom" />
import { burst, delayedMemory, memoryMetrics } from "./flicker-probe.ts";
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test.use({ video: "on" });

for (const delay of [0, 150, 600]) {
  test(`GPU memory context pick keeps its verdict and details at ${delay} ms`, async ({ page, open }) => {
    await delayedMemory(page, delay);
    await open();
    await waitReady(page);
    const gpu = await openGpuMemory(page);
    await expect(gpu.locator(".fp-v")).toBeVisible();
    await gpu.locator("summary").click();
    await expect(gpu.locator('[data-ctx="32768"]')).toHaveAttribute("data-tip", /.+/);
    const frames = await burst(page, `gpu-context-${delay}`, "#gpuMemory", () => gpu.locator('[data-ctx="32768"]').click());
    const metrics = memoryMetrics(frames);
    console.log(`FLICKER gpu-context-${delay} ${JSON.stringify(metrics)}`);
    expect(metrics.transients, "settled GPU memory must not disappear or return to Checking after a pick").toBe(0);
    expect(metrics.shiftPx, "context selection must not collapse the expanded details").toBeLessThanOrEqual(0.5);
    await expect(gpu.locator('[data-ctx="32768"]')).toHaveAttribute("aria-pressed", "true");
    await expect(gpu.locator(".fp-v")).toContainText("32k");
  });

  test(`reopening the picker after loading keeps checked verdicts at ${delay} ms`, async ({ page, open }) => {
    await delayedMemory(page, delay);
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await expect(page.locator("#picker")).not.toContainText("Checking…");
    await page.locator('#picker .pk-r[data-m="gemma4:12b"]').click();
    await expect(page.locator("#modelBtn")).not.toHaveAttribute("aria-busy", "true");
    const frames = await burst(page, `picker-reopen-${delay}`, "#picker", () => page.locator("#modelBtn").click());
    const visible = frames.filter((f) => Object.keys(f.boxes).length > 0);
    const checking = visible.filter((f) => f.checking);
    console.log(`FLICKER picker-reopen-${delay} ${JSON.stringify({ frames: visible.length, transients: new Set(checking.map((f) => f.text)).size, checkingFrames: checking.length })}`);
    expect(checking, "a model load must not erase verdicts already checked in the picker").toHaveLength(0);
  });
}

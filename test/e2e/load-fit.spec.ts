/// <reference lib="dom" />
// A load can temporarily count its own allocation twice. All advice surfaces
// should retain their earlier fit, while a later real refusal still appears.
import type { FitReport, GpuStatus } from "@gates-local/contracts";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ video: "on" });
for (const width of [1440, 390]) test.describe(`${width}px load advice`, () => {
  test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });
  for (const surface of ["picker", "panel"] as const) test(`${surface} holds fit through a load-time refusal`, async ({ page, open }, info) => {
    const model = "qwen3.5:9b", numCtx = 16384;
    let gpu: GpuStatus | undefined, refuse = false, replies = 0;
    let push: (channel: string, payload: unknown) => void = () => { throw new Error(`No ${surface} socket`); };
    await page.routeWebSocket(/.*/, ws => {
      const server = ws.connectToServer(), methods = new Map<string, string>();
      push = (channel, payload) => ws.send(JSON.stringify({ type: "push", channel, payload }));
      ws.onMessage(message => {
        const req = JSON.parse(String(message)) as { id: string; method: string };
        methods.set(req.id, req.method); server.send(message);
      });
      server.onMessage(message => {
        const res = JSON.parse(String(message)) as { type: string; id?: string; channel?: string; result?: unknown; payload?: unknown };
        if (res.type === "push" && res.channel === "gpu.changed" && refuse) return;
        if (res.id && methods.get(res.id) === "gpu.status") gpu = res.result as GpuStatus;
        if (res.id && methods.get(res.id) === "fit.check" && refuse) {
          const report = res.result as FitReport;
          if (report.model === model && report.numCtx === numCtx) {
            res.result = { ...report, verdict: "refuse", shortfallBytes: 1024 ** 3 };
            replies++; ws.send(JSON.stringify(res)); return;
          }
        }
        ws.send(message);
      });
    });
    await open(); await waitReady(page);
    if (surface === "picker") {
      await page.locator("#modelBtn").click();
      if (width < 1024) await page.locator(`#picker [data-m="${model}"] .pk-select`).click();
    } else {
      await page.keyboard.press("Control+Comma");
      if (width < 1024) await page.getByRole("button", { name: "Back to Settings", exact: true }).click();
      await page.locator(".snav, .set-list").getByRole("button", { name: /^Advanced/ }).filter({ visible: true }).click();
    }
    const advice = page.locator(surface === "picker" ? '#picker [data-ctx="16384"] .pk-cost' : "#gpuMemory .fp-v");
    await expect(advice).toContainText(surface === "picker" ? "Fits" : "Should run well");
    await page.screenshot({ path: info.outputPath("before-load.png") });
    expect(gpu).toBeDefined();
    if (!gpu) throw new Error("No GPU reading");
    push("models.load", { model, numCtx, state: "loading" });
    refuse = true;
    push("gpu.changed", { ...gpu, freeBytes: Math.max(0, (gpu.freeBytes ?? 0) - 1024 ** 3), measuredAt: gpu.measuredAt + 1 });
    await expect.poll(() => replies).toBeGreaterThan(0);
    // Give the real session's RPC continuation and React commit a frame to settle.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: info.outputPath("during-load.png") });
    await expect.soft(advice).toContainText(surface === "picker" ? "Fits" : "Should run well");
    // The ready event requests a distinct post-load check. Its refusal must count.
    push("models.load", { model, numCtx, state: "ready" });
    push("gpu.changed", { ...gpu, freeBytes: Math.max(0, (gpu.freeBytes ?? 0) - 2 * 1024 ** 3), measuredAt: gpu.measuredAt + 2 });
    await expect(advice).toContainText(surface === "picker" ? "Too big" : "Needs");
    await page.screenshot({ path: info.outputPath("after-real-refusal.png") });
  });
});

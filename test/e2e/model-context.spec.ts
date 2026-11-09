// Journey: switch model in the picker and the context size in GPU memory
// (Settings › Advanced); the verdict follows each change.
import type { GpuStatus } from "@gates-local/contracts";
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test("switching model and context updates the fit verdict and the panel", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const modelBtn = page.locator("#modelBtn");
  await expect(modelBtn).toContainText("Qwen 3.5 9B");

  // the picker orders by verdict; the 27B cannot load at 16k. Its Context control says 16k runs on the GPU.
  await modelBtn.click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  const ctx = picker.getByRole("radiogroup", { name: "Context" });
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("aria-checked", "true");
  await expect(ctx.getByRole("radio", { name: "16k" }).locator(".pk-cost.gpu")).toHaveCount(1);
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("data-tip", /fits on the GPU/);
  await expect(picker.locator('.pk-r[data-m="qwen3.8-abliterated:27b"]')).toHaveAttribute("aria-disabled", "true");
  await picker.locator("#pkSearch").fill("gemma");
  await picker.locator('.pk-r[data-m="gemma4:12b"]').click();
  await expect(picker).toBeHidden();
  await expect(modelBtn).toContainText("Gemma 4 12B");

  // GPU memory lives in Settings › Advanced and changes context; 32k spills for the 12B
  const panel = await openGpuMemory(page);
  await expect(panel).toContainText("Gemma 4 12B");
  await panel.getByRole("button", { name: "32k" }).click();
  await expect(panel).toContainText("Should run slower");

  // the per-app breakdown reads gpu.status (the fake nvidia-smi)
  await expect(panel).toContainText("Where the memory goes");
  await expect(panel).not.toContainText("not available in this build");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await modelBtn.click();
  await expect(ctx.getByRole("radio", { name: "32k" })).toHaveAttribute("aria-checked", "true");
  await expect(ctx.getByRole("radio", { name: "32k" }).locator(".pk-cost.spill")).toHaveCount(1);
  await expect(ctx.getByRole("radio", { name: "32k" })).toHaveAttribute("data-tip", /system memory/);
});

test("memory no process claims is called Other in the panel, in words and in its tooltip", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const panel = await openGpuMemory(page);
  await panel.locator("summary", { hasText: "Details" }).click();
  const other = panel.locator(".lg-r").filter({ hasText: /^Other/ });
  await expect(other).toHaveCount(1);
  await expect(panel).not.toContainText("Not attributed");
  await other.hover();
  await expect(page.locator("#tip")).toContainText("can't name");
  await expect(page.locator("#tip")).not.toContainText("Not attributed");
});

test("unrelated context answers keep the Other and Whisper tooltips open", async ({ page, open }) => {
  let refresh: (() => void) | undefined;
  const held = new Map<number, () => void>();
  await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
    const server = ws.connectToServer();
    const requests = new Map<string, number>();
    let gpu: GpuStatus | undefined, holding = false;
    refresh = () => {
      if (!gpu) throw new Error("No GPU reading received");
      holding = true;
      ws.send(JSON.stringify({ type: "push", channel: "gpu.changed", payload: { ...gpu, freeBytes: (gpu.freeBytes ?? 0) - 1, measuredAt: gpu.measuredAt + 1 } }));
    };
    ws.onMessage(message => {
      const req = JSON.parse(String(message)) as { id: string; method?: string; params?: { numCtx?: number } };
      if (req.method === "fit.check" && req.params?.numCtx !== undefined) requests.set(req.id, req.params.numCtx);
      server.send(message);
    });
    server.onMessage(message => {
      const res = JSON.parse(String(message)) as { type: string; id?: string; channel?: string; result?: GpuStatus; payload?: GpuStatus };
      if (res.type === "push" && res.channel === "gpu.changed") {
        if (holding) return;
        gpu = res.payload;
      }
      if (res.type === "response" && res.result?.vendor) gpu = res.result;
      const ctx = res.id === undefined ? undefined : requests.get(res.id);
      if (holding && ctx !== undefined) held.set(ctx, () => ws.send(message));
      else ws.send(message);
    });
  });
  await open(); await waitReady(page);
  const panel = await openGpuMemory(page);
  await panel.locator("summary", { hasText: "Details" }).click();
  for (const ctx of [8192, 16384, 32768, 65536]) {
    await expect(panel.locator(`[data-ctx="${ctx}"]`)).toHaveAttribute("data-tip", /Runs |Slower |Won't fit/);
  }
  refresh!();
  await expect.poll(() => held.has(8192) && held.has(32768) && held.has(65536)).toBe(true);
  for (const [label, text, ctx] of [["Other", "can't name", 8192], ["Whisper", "never stops it", 32768]] as const) {
    await expect(panel.locator(`[data-ctx="${ctx}"]`)).toHaveAttribute("data-tip", "Checking…");
    await panel.locator(".lg-r").filter({ hasText: new RegExp(`^${label}`) }).hover();
    await expect(page.locator("#tip")).toContainText(text);
    held.get(ctx)!();
    await expect(panel.locator(`[data-ctx="${ctx}"]`)).not.toHaveAttribute("data-tip", /Checking/);
    await expect(page.locator("#tip")).toHaveClass(/open/);
    await expect(page.locator("#tip")).toContainText(text);
  }
});

test("Memory details follow the chat's 64k choice without changing its saved 16k default", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await picker.getByRole("radio", { name: /^64k\b/ }).click();
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("64k");
  const panel = await openGpuMemory(page);
  await expect(panel).toContainText("Memory at 64k context");
  await expect(panel.locator('[data-ctx="16384"]')).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator('[data-ctx="65536"]')).toHaveAttribute("aria-pressed", "false");
  await panel.locator("summary", { hasText: "Details" }).click();
  await expect(panel.locator("details")).toHaveAttribute("open", "");
  await expect(panel.locator(".fp-v")).toContainText("64k");
  await expect(panel.locator("details")).toContainText("Where the memory goes");
  await page.screenshot({ path: test.info().outputPath("memory-selected-64k-default-16k.png") });
  await page.keyboard.press("Escape");
  await page.locator("#modelBtn").click();
  await expect(picker.getByRole("radio", { name: /^64k\b/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await openGpuMemory(page);
  await expect(panel.locator('[data-ctx="16384"]')).toHaveAttribute("aria-pressed", "true");
});

test("the panel's memory bar names whisper and the other resident app", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const panel = await openGpuMemory(page);
  await expect(panel).toContainText("Where the memory goes");
  await expect(panel.locator(".sw-whisper")).toHaveCount(2);
  const whisper = panel.locator(".lg-r").filter({ hasText: "Whisper" });
  await expect(whisper).toContainText("speech-to-text");
  await expect(panel.locator(".lg-r").filter({ hasText: "other app" })).toContainText("Media Vault vision");
  // the reassurance is the legend row's tooltip; the panel's own sentence says it only when the model does not fit
  await panel.locator("summary", { hasText: "Details" }).click();
  await whisper.hover();
  await expect(page.locator("#tip")).toContainText("never stops it");
});

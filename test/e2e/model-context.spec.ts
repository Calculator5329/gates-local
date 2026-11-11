// Journey: switch model in the picker and the context size in GPU memory
// (Settings › Advanced); the verdict follows each change.
import type { FitTable } from "@gates-local/contracts";
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
  // the fit is in the cost cell: its look, its word, and the same in words for a screen reader
  const fits = ctx.getByRole("radio", { name: "16k" }).locator(".pk-cost.gpu");
  await expect(fits).toHaveCount(1);
  await expect(fits.locator("small")).toHaveText("Fits");
  await expect(fits).toHaveAttribute("aria-label", /GB (measured|estimated); Fits$/);
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
  const spills = ctx.getByRole("radio", { name: "32k" }).locator(".pk-cost.spill");
  await expect(spills).toHaveCount(1);
  await expect(spills.locator("small")).toHaveText("Slower");
  await expect(spills).toHaveAttribute("aria-label", /GB (measured|estimated); Slower$/);
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

test("a pushed fit table keeps the Other and Whisper tooltips open", async ({ page, open }) => {
  let refresh: (() => void) | undefined;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
    const server = ws.connectToServer();
    const asked = new Set<string>();
    let table: FitTable | undefined;
    refresh = () => {
      if (!table) throw new Error("No fit table received");
      table = { ...table, reading: { ...table.reading, seq: table.reading.seq + 1000, measuredAt: table.reading.measuredAt + 1 } };
      ws.send(JSON.stringify({ type: "push", channel: "fit.changed", payload: table }));
    };
    ws.onMessage(message => {
      const req = JSON.parse(String(message)) as { id: string; method?: string };
      if (req.method === "fit.table") asked.add(req.id);
      server.send(message);
    });
    server.onMessage(message => {
      const res = JSON.parse(String(message)) as { type: string; id?: string; result?: FitTable };
      if (res.type === "response" && res.id !== undefined && asked.delete(res.id)) table = res.result;
      ws.send(message);
    });
  });
  await open(); await waitReady(page);
  const panel = await openGpuMemory(page);
  await panel.locator("summary", { hasText: "Details" }).click();
  for (const ctx of [8192, 16384, 32768, 65536]) {
    await expect(panel.locator(`[data-ctx="${ctx}"]`)).toHaveAttribute("data-tip", /Runs |Slower |Won't fit/);
  }
  for (const [label, text] of [["Other", "can't name"], ["Whisper", "never stops it"]] as const) {
    await panel.locator(".lg-r").filter({ hasText: new RegExp(`^${label}`) }).hover();
    await expect(page.locator("#tip")).toContainText(text);
    refresh!();
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

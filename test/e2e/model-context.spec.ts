// Journey: switch model in the picker and the context size in GPU memory
// (Settings › Advanced); the verdict follows each change.
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
  await expect(panel).toContainText("Uses system memory");

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

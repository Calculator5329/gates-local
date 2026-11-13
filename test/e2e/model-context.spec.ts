// Journey: switch model in the picker and the context size in GPU memory
// (Settings › Advanced); the verdict follows each change.
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

// Guards the owner's ruling: the picker carries context, and its fit verdict follows model and context.
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

  // GPU memory lives in Settings › Advanced and changes context; judged against the card's own
  // memory (the owner's ruling, 2026-11-13), 32k runs on the GPU for the 12B and 64k spills
  const panel = await openGpuMemory(page);
  await expect(panel).toContainText("Gemma 4 12B");
  await panel.getByRole("button", { name: "32k" }).click();
  await expect(panel).toContainText("Should run well");
  await panel.getByRole("button", { name: "64k" }).click();
  await expect(panel).toContainText("Should run slower");

  // the per-app breakdown reads gpu.status (the fake nvidia-smi)
  await expect(panel).toContainText("In use right now");
  await expect(panel).not.toContainText("not available in this build");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await modelBtn.click();
  await expect(ctx.getByRole("radio", { name: "64k" })).toHaveAttribute("aria-checked", "true");
  const spills = ctx.getByRole("radio", { name: "64k" }).locator(".pk-cost.spill");
  await expect(spills).toHaveCount(1);
  await expect(spills.locator("small")).toHaveText("Slower");
  await expect(spills).toHaveAttribute("aria-label", /GB (measured|estimated); Slower$/);
});

// Guards the owner's rule to show only what is true, on the GPU memory panel (unsure: no owner line on this bar).
test("the panel's memory bar names whisper and the other resident app", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const panel = await openGpuMemory(page);
  await expect(panel).toContainText("In use right now");
  await expect(panel.locator(".sw-whisper")).toHaveCount(2);
  const whisper = panel.locator(".lg-r").filter({ hasText: "Whisper" });
  await expect(whisper).toContainText("speech-to-text");
  await expect(panel.locator(".lg-r").filter({ hasText: "other app" })).toContainText("Media Vault vision");
  // the reassurance is the legend row's tooltip; the panel's own sentence says it only when the model does not fit
  await panel.locator("summary", { hasText: "Details" }).click();
  await whisper.hover();
  await expect(page.locator("#tip")).toContainText("never stops it");
});

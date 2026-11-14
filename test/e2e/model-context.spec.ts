// Journey: switch model and context size in the picker; GPU memory (Settings › Advanced)
// follows each change.
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

// Guards the owner's ruling: the picker carries context, and its fit verdict follows model and context.
test("switching model and context updates the fit verdict and the panel", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const modelBtn = page.locator("#modelBtn");
  await expect(modelBtn).toContainText("Qwen 3.5 9B");

  // the picker orders by verdict. Its Context control says 16k runs on the GPU.
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
  // judged against the card's own memory (the owner's ruling, 2026-11-13): what other programs
  // hold right now no longer turns the 27B's row off
  await expect(picker.locator('.pk-r[data-m="qwen3.8-abliterated:27b"]')).toHaveAttribute("aria-disabled", "false");
  await picker.locator("#pkSearch").fill("gemma");
  await picker.locator('.pk-r[data-m="gemma4:12b"]').click();
  await expect(picker).toBeHidden();
  await expect(modelBtn).toContainText("Gemma 4 12B");

  // context is set in the picker only (decision 13); GPU memory in Settings › Advanced follows it.
  // Judged against the card's own memory (the owner's ruling, 2026-11-13), 32k runs on the GPU
  // for the 12B and 64k spills
  const sizeTo = async (name: string) => {
    await modelBtn.click();
    await ctx.getByRole("radio", { name }).click();
    await expect(picker).toBeHidden();
    return openGpuMemory(page);
  };
  let panel = await sizeTo("32k");
  await expect(panel).toContainText("Gemma 4 12B");
  // "Runs" once a speed is measured, "Should run" before
  await expect(panel.locator(".fp-v")).toContainText(/(Should run|Runs) well\s*at 32k/);
  await page.keyboard.press("Escape");
  panel = await sizeTo("64k");
  await expect(panel.locator(".fp-v")).toContainText(/(Should run|Runs) slower\s*at 64k/);

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
  // a legend row is a row: no tooltip (decision 19); the panel's own sentence says Whisper is never
  // stopped only when the model does not fit
  await panel.locator("summary", { hasText: "Details" }).click();
  await expect(whisper.locator("[data-tip]")).toHaveCount(0);
  await expect(whisper).not.toHaveAttribute("data-tip", /./);
});

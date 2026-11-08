// Journey: switch model in the picker and the context size in GPU memory
// (Settings › Advanced); the verdict follows each change.
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test("switching model and context updates the fit verdict and the panel", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const modelBtn = page.locator("#modelBtn");
  const fitBtn = page.locator("#fitBtn");
  await expect(modelBtn).toContainText("Qwen 3.5 9B");
  await expect(fitBtn).toContainText("16k · on GPU");

  // the picker groups by verdict; the 27B cannot load at 16k
  await modelBtn.click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("Not enough memory");
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
  await expect(fitBtn).toContainText("32k · system memory");
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
  await whisper.hover();
  await expect(page.locator("#tip")).toContainText("never stops it");
});

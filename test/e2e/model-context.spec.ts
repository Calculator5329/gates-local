// Journey: switch model in the picker and the context size in the GPU panel;
// the verdict follows each change.
import { expect, test, waitReady } from "./fixtures.ts";

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

  // the panel opens from the chip and changes context; 32k spills for the 12B
  await fitBtn.click();
  const panel = page.locator("#fitPanel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "32k" }).click();
  await expect(fitBtn).toContainText("32k · system memory");
  await expect(panel).toContainText("Uses system memory");

  // the per-app breakdown needs gpu.status, which this build does not answer
  await expect(panel).toContainText("A breakdown by app is not available in this build.");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test.fixme("the panel's memory bar names whisper and the other resident app (needs gpu.status)", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#fitBtn").click();
  const panel = page.locator("#fitPanel");
  await expect(panel).toContainText("Where the memory goes");
  await expect(panel.locator(".sw-whisper")).toHaveCount(2);
  await expect(panel).toContainText("never stops it");
});

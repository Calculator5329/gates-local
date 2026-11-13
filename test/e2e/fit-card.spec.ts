// Settings row 10, the owner 2026-11-13: another program holding 9.7 GB of GPU memory made every
// model in the Download tab look worse, and he called that inaccurate. His ruling: "the measure for
// a model is not what is available now its based on the ram in the card". The list judges each
// model against the card, and one line above it names the program using memory right now. A send
// still judges right now (unit: fit/table.test.ts).
import type { Page } from "@playwright/test";
import { expect, openGpuMemory, stack, test, waitReady } from "./fixtures.ts";

const BLENDER_MIB = Math.round(9.7 * 1024);

/** Each download row's verdict and need (its tooltip), by model, installed rows too, and the line said once above the list. */
const verdicts = (page: Page) =>
  page.locator(".dlg").evaluate((dlg) => ({
    once: dlg.querySelector(".dl-once")?.textContent ?? "",
    rows: Object.fromEntries([...dlg.querySelectorAll(".dlrow[data-cat]")].map((r) => [r.getAttribute("data-cat"), `${r.getAttribute("data-verdict") ?? ""} | ${r.querySelector(".sl")?.getAttribute("data-tip") ?? ""}`])),
  }));

test("another program's GPU memory leaves the download verdicts as they were, and one line names it", async ({ page, open }, info) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
  await expect(page.locator('.dlrow[data-cat="qwen3:14b"]')).toHaveAttribute("data-verdict", "fits");
  const idle = await verdicts(page);

  await stack.gpu(BLENDER_MIB);
  const line = page.getByText(/ of GPU memory right now\.$/);
  // The new reading has reached the tab: the line came, or a row's verdict moved.
  await expect.poll(async () => (await line.count()) > 0 || JSON.stringify(await verdicts(page)) !== JSON.stringify(idle), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>(".dl-others, .dl-once")) el.style.setProperty("outline", "2px solid #f5a524");
  });
  await page.screenshot({ path: info.outputPath("fit-card-heavy.png"), animations: "disabled" });

  await expect(line).toHaveText("blender is using 9.7 GB of GPU memory right now.");
  expect(await verdicts(page), "each row's verdict, idle then with blender running").toEqual(idle);

  // Done with the GPU: the line goes.
  await stack.gpu(0);
  await expect(line).toHaveCount(0, { timeout: 15_000 });
});

// Row 10 addendum, the owner 2026-11-13: Settings › Advanced said Gemma 4 12B "Needs 2.9 GB more"
// on a 16 GB card because a lane's ComfyUI held 9.2 GB, and he called it inaccurate. His ruling:
// a model is measured against the memory on the card; what other apps hold right now is shown,
// never the verdict.
test("another program's GPU memory leaves the Settings verdicts as they were, and Details shows it as in use right now", async ({ page, open }, info) => {
  await open();
  await waitReady(page);
  const gpu = await openGpuMemory(page);
  const status = gpu.locator(".fp-v");
  // Default context says each size's fit in that size's tooltip
  const size = gpu.locator('[data-ctx="16384"]');
  // the row is the model and one verdict; the control above already says 16k (row 20)
  await expect(status).toHaveText(/^(Should run|Runs) \S+( \S+)*$/);
  const idle = { status: await status.textContent(), size: await size.getAttribute("data-tip") };

  await stack.gpu(BLENDER_MIB);
  await gpu.locator("details.fp-more summary").click();
  // The new reading has reached Settings: blender is in the breakdown.
  await expect(gpu.locator(".legend")).toContainText("blender", { timeout: 15_000 });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("#gpuMemory .fp-v, #gpuMemory .fp-more")) el.style.setProperty("outline", "2px solid #f5a524");
  });
  await page.screenshot({ path: info.outputPath("settings-heavy.png"), animations: "disabled" });

  expect({ status: await status.textContent(), size: await size.getAttribute("data-tip") }, "the verdicts, idle then with blender running").toEqual(idle);
  await expect(gpu.locator(".fp-more")).not.toContainText("Needs");
  await expect(gpu.getByText("In use right now", { exact: true })).toBeVisible();
  await expect(gpu.locator(".legend .lg-r", { hasText: "blender" })).toContainText("9.7 GB");
});

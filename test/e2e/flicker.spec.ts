/// <reference lib="dom" />
// The GPU memory context-pick tests left with the Default context control (decision 13); context is
// chosen in the picker only, which the test below and fit-still.spec.ts measure.
import { burst, delayedMemory } from "./flicker-probe.ts";
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

for (const delay of [0, 150, 600]) {
  // Guards a shipped bug fix: loading a model dropped the picker's earlier memory verdicts.
  test(`reopening the picker after loading keeps checked verdicts at ${delay} ms`, async ({ page, open }) => {
    await delayedMemory(page, delay);
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    const loading = page.locator("#picker .fit-skel, #picker .pk-cost.skel");
    await expect(loading).toHaveCount(0);
    // The context column follows the highlight. Check Gemma's contexts before
    // asking whether those same answers survive closing and loading it.
    const gemma = page.locator('#picker .pk-r[data-m="gemma4:12b"]');
    await gemma.hover();
    await expect(page.locator("#picker").getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
    await expect(loading).toHaveCount(0);
    await expect(page.locator("#picker")).not.toContainText("Checking…");
    await gemma.click();
    await expect(page.locator("#modelBtn")).not.toHaveAttribute("aria-busy", "true");
    const frames = await burst(page, `picker-reopen-${delay}`, "#picker", () => page.locator("#modelBtn").click());
    const visible = frames.filter((f) => Object.keys(f.boxes).length > 0);
    const checking = visible.filter((f) => f.checking);
    console.log(`FLICKER picker-reopen-${delay} ${JSON.stringify({ frames: visible.length, transients: new Set(checking.map((f) => f.text)).size, checkingFrames: checking.length })}`);
    expect(checking, "a model load must not erase verdicts already checked in the picker").toHaveLength(0);
  });
}

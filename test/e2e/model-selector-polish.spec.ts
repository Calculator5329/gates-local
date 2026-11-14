/// <reference lib="dom" />
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ installed: ["qwen3.5:4b", "alice/custom:latest"] });

for (const width of [1440, 360]) {
  test(`the model button keeps one width with its words at both edges, and an unknown maker stays in line, at ${width}px`, async ({ page, open }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await open(); await waitReady(page);
    const trigger = page.locator("#modelBtn");
    await expect(trigger.locator(".picker-trigger-name")).toContainText("Qwen");
    const spacing = await trigger.evaluate(button => {
      const first = button.firstElementChild!;
      const last = button.querySelector(".picker-trigger-ctx")!;
      const box = button.getBoundingClientRect();
      return { left: first.getBoundingClientRect().left - box.left, right: box.right - last.getBoundingClientRect().right };
    });
    expect(spacing.left, "the mark starts at the button's padding").toBeLessThanOrEqual(11);
    expect(Math.abs(spacing.left - spacing.right), "the same padding at both edges").toBeLessThanOrEqual(1);
    const before = await trigger.boundingBox();
    await page.locator(".composer").screenshot({ path: info.outputPath(`model-button-${width}.png`), animations: "disabled" });
    await trigger.focus(); await trigger.press("ArrowDown");
    const search = page.locator("#pkSearch");
    await expect(search).toBeFocused();
    await search.fill("custom");
    const row = page.locator('#picker .pk-r[data-m="alice/custom:latest"]');
    await expect(row.locator(".maker-mark")).toHaveCount(0);
    const columns = await row.evaluate(el => {
      const name = el.querySelector(".pk-name")!.getBoundingClientRect();
      const metric = el.querySelector(".pk-v")!.getBoundingClientRect();
      return { sameLine: Math.abs(name.top + name.height / 2 - metric.top - metric.height / 2) < 1, ordered: name.right <= metric.left };
    });
    expect(columns).toEqual({ sameLine: true, ordered: true });
    await row.locator(".pk-select").click();
    if (width <= 640) await page.locator('#picker [data-ctx="16384"]').click();
    await expect(page.locator("#picker")).toBeHidden();
    await expect(trigger.locator(".maker-mark")).toHaveCount(0);
    await expect(trigger).not.toContainText("?");
    await expect(trigger.locator(".picker-trigger-ctx")).toBeVisible();
    // one width for every usual name: picking another model moves neither end of the button
    if (width > 640) expect(await trigger.boundingBox(), "the button did not move or resize").toEqual(before);
    await page.locator(".composer").screenshot({ path: info.outputPath(`model-button-unknown-${width}.png`), animations: "disabled" });
    await trigger.click();
    await expect(page.locator('.pk-rail [aria-label="Other"]')).toHaveText("Other");
    await page.locator("#pkSearch").press("Escape");
    await expect(trigger).toBeFocused();
    expect(await page.locator(".cf").evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
  });
}

import { expect, test, waitReady } from "./fixtures.ts";

test.use({ viewport: { width: 1137, height: 749 }, video: "on" });

test("approved picker closes when the composer is clicked and lets that click focus it", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  await expect(page.locator("#pkSearch")).toBeFocused();
  const ta = page.locator("#ta"), bounds = await ta.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  await page.mouse.click(bounds.x + 8, bounds.y + 8);
  await expect(page.locator("#picker")).toBeHidden();
  await expect(ta).toBeFocused();
});

test("a loaded picker report counts the model's held allocation before drawing overflow", async ({ page, open }) => {
  const measured = new Set<unknown>();
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => {
      try {
        const frame = JSON.parse(String(message)) as { id?: unknown; method?: string; params?: { model?: string; numCtx?: number } };
        if (frame.method === "fit.check" && frame.params?.model === "qwen3.5:9b" && frame.params.numCtx === 16384) measured.add(frame.id);
      } catch { /* Non-RPC frames pass through unchanged. */ }
      server.send(message);
    });
    server.onMessage(message => {
      try {
        const frame = JSON.parse(String(message)) as { id?: unknown; type?: string; ok?: boolean; result?: Record<string, unknown> };
        if (frame.type === "response" && frame.ok && measured.has(frame.id)) {
          const gib = 1024 ** 3;
          ws.send(JSON.stringify({ ...frame, result: { ...frame.result, source: "measured", verdict: "fits", needVramBytes: 7 * gib, freeVramBytes: 2 * gib, spillRamBytes: 0 } }));
          return;
        }
      } catch { /* Non-RPC frames pass through unchanged. */ }
      ws.send(message);
    });
  });
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const cost = page.locator('#picker [data-ctx="16384"] .pk-cost');
  await expect(cost).toHaveAttribute("aria-label", /7\.0\sGB measured; Fits/);
  await expect(cost.locator(".pk-cost-over")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("picker-loaded-measured.png") });
});

test("approved picker keeps its columns fixed through hover, filtering and empty results", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker.locator(".pk-context")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#modelBtn")).toBeFocused();
  await page.locator("#modelBtn").click();
  await expect(picker.locator(".pk-context")).toBeVisible();
  const box = await picker.boundingBox();
  await expect(picker.locator(".pk-cost.gpu").first()).toBeVisible();
  await expect(picker.locator(".pk-cost.pending")).toHaveCount(0);
  await expect(picker.locator(".pk-v").filter({ hasText: "Checking…" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("picker-desktop.png") });
  await picker.locator('[data-m="gemma4:12b"]').hover();
  await expect(picker.locator(".pk-context-head small")).toHaveText("Gemma 4 12B");
  expect(await picker.boundingBox()).toEqual(box);
  await picker.locator("#pkSearch").fill("no matching local model");
  await expect(picker.getByRole("option")).toHaveCount(0);
  expect(await picker.boundingBox()).toEqual(box);
  await picker.locator("#pkSearch").fill("qwen 3.5");
  await picker.locator("#pkSearch").press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
  await expect(page.locator("#ta")).toBeFocused();
});

test("a favorite persists and filters by exact model identity", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  const row = page.locator('#picker [data-m="qwen3.5:9b"]');
  await row.hover();
  await row.getByRole("button", { name: "Favorite Qwen 3.5 9B", exact: true }).click();
  await page.locator("#picker").getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator("#pkList").getByRole("option")).toHaveCount(1);
  await page.reload(); await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.locator("#picker").getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator("#pkList").getByRole("option")).toHaveCount(1);
  await expect(page.locator("#pkList").getByRole("option")).toHaveAttribute("data-m", "qwen3.5:9b");
});

test("Download models reaches the real download tab and can start a pull", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.getByRole("tab", { name: /^Download/ })).toHaveAttribute("aria-selected", "true");
  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  const download = row.getByRole("button", { name: "Download", exact: true });
  await expect(download).toBeEnabled();
  await download.click();
  await expect(row.locator(".badge")).toHaveText("Installed", { timeout: 20_000 });
  await page.getByRole("tab", { name: /^Installed/ }).click();
  await expect(page.locator('.mp-row[data-dm="qwen3.5:4b"]')).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 749 }, isMobile: true, hasTouch: true });
  test("PK-04 PK-05: visible favorite and all phone targets are 44px; Tab skips the inert rail", async ({ page, open }) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").tap();
    const picker = page.locator("#picker"), frame = await picker.boundingBox();
    const favorite = picker.getByRole("button", { name: "Favorite Qwen 3.5 9B", exact: true });
    await expect(favorite).toBeVisible();
    await expect(favorite).toHaveCSS("opacity", "1");
    for (const target of await picker.locator(".pk-fam,.pk-favorite,.pk-select,.pk-bottom button,.pk-close").all()) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await favorite.tap();
    await picker.getByRole("button", { name: "Favorites", exact: true }).tap();
    await expect(picker.getByRole("option")).toHaveCount(1);
    expect(await picker.boundingBox()).toEqual(frame);
    await picker.getByRole("button", { name: "All models", exact: true }).tap();
    await picker.locator('[data-m="gemma4:12b"] .pk-select').tap();
    const back = picker.getByRole("button", { name: "Back to models" });
    await expect(back).toBeVisible();
    const box = await back.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await picker.boundingBox()).toEqual(frame);
    const download = picker.getByRole("button", { name: "Download models", exact: true });
    await download.focus(); await page.keyboard.press("Tab");
    await expect(back).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(download).toBeFocused();
    await back.tap();
    expect(await picker.boundingBox()).toEqual(frame);
    await page.screenshot({ path: test.info().outputPath("picker-phone-targets.png") });
  });
  test("chooses a model then context without changing the picker bounds", async ({ page, open }) => {
    await open(); await waitReady(page);
    await page.locator("#modelBtn").tap();
    const picker = page.locator("#picker");
    await expect(picker.locator(".pk-main")).toBeVisible();
    await expect(picker.locator(".pk-v").filter({ hasText: "Checking…" })).toHaveCount(0);
    const bounds = await picker.boundingBox();
    await page.screenshot({ path: test.info().outputPath("picker-phone-models.png") });
    await picker.locator('[data-m="gemma4:12b"]').tap();
    await expect(picker.locator(".pk-context")).toBeVisible();
    await expect(picker.locator(".pk-cost.pending")).toHaveCount(0);
    expect(await picker.boundingBox()).toEqual(bounds);
    await page.screenshot({ path: test.info().outputPath("picker-phone-context.png") });
    await picker.getByRole("radio", { name: /^8k/ }).tap();
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});

for (const width of [1137, 390]) {
  test.describe(`hosted picker variants at ${width}`, () => {
    const base = "hf.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
    test.use({ viewport: { width, height: 749 }, isMobile: width === 390, hasTouch: width === 390,
      installed: ["qwen3.5:9b", `${base}:Q4_K_M`, `${base}:Q8_0`] });
    test("PK-03: quantization stays visible outside the truncated base name", async ({ page, open }) => {
      await open(); await waitReady(page);
      await page.locator("#modelBtn").click();
      for (const suffix of ["Q4_K_M", "Q8_0"]) {
        const button = page.locator("#picker").getByRole("button", { name: `Gemma 4 26B ultra-uncensored (llmfan46) · ${suffix}`, exact: true });
        await expect(button.locator(".pk-variant")).toHaveText(suffix);
        await expect(button.locator(".pk-variant")).toBeVisible();
        expect(await button.locator(".pk-variant").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await page.screenshot({ path: test.info().outputPath(`picker-quantizations-${width}.png`) });
    });
  });
}

import { expect, test, waitReady } from "./fixtures.ts";
test.use({ viewport: { width: 1137, height: 749 } });

// Guards the owner's ruling that the picker is whole when it opens: skeletons fill in place and nothing moves.
test("the picker opens before the first table with skeletons, and the table fills them in place", async ({ page, open }) => {
  let holding = true;
  const held: (() => void)[] = [];
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer(), requests = new Set<unknown>();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
      if (frame.method === "fit.table") requests.add(frame.id);
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; type?: string; channel?: string };
      const table = (frame.type === "response" && requests.delete(frame.id)) || (frame.type === "push" && frame.channel === "fit.changed");
      if (table && holding) held.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  await open(); await waitReady(page);
  try {
    await page.locator("#modelBtn").click();
    const picker = page.locator("#picker"), search = page.locator("#pkSearch");
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await expect(picker.locator(".pk-cost .fit-skel").first()).toBeVisible();
    const before = await picker.boundingBox();
    holding = false;
    for (const release of held.splice(0)) release();
    await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
    const bounds = await picker.boundingBox();
    expect(bounds, "the table fills the skeletons without moving the picker").toEqual(before);
    await search.fill("qwen");
    await search.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    await page.locator("#modelBtn").click();
    expect(await picker.boundingBox()).toEqual(bounds);
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
  }
});

// Guards the owner's rule that nothing moves, on the picker he reworked: its columns hold through hover and filtering.
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
  await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
  await picker.locator('[data-m="gemma4:12b"]').hover();
  await expect(picker.getByRole("radiogroup")).toHaveAccessibleName("Context length for Gemma 4 12B");
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

// Guards the owner's ask that models download from Models (unsure: he may not need it to start from the picker).
test("Download models reaches the real download tab and can start a pull", async ({ page, open }) => {
  await open(); await waitReady(page);
  await page.locator("#modelBtn").click();
  await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.getByRole("tab", { name: /^Download/ })).toHaveAttribute("aria-selected", "true");
  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  const download = row.getByRole("button", { name: /^Download \d/ });
  await expect(download).toBeEnabled();
  await download.click();
  await expect(row.locator(".dl-done")).toHaveText("Installed", { timeout: 20_000 });
  await page.getByRole("tab", { name: /^Installed/ }).click();
  await expect(page.locator('.mp-row[data-dm="qwen3.5:4b"]')).toBeVisible();
});

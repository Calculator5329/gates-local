import { expect, test, waitReady } from "./fixtures.ts";
import { decodeRequest, decodeResult, decodeServerMessage } from "@gates-local/contracts";

test.use({ viewport: { width: 1137, height: 749 }, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

test("idle warms nothing; hover prepares the first picker view and focus and opening reuse its checks", async ({ page, open }) => {
  const requests = new Map<string, string>(), answered = new Set<string>();
  page.on("websocket", ws => {
    ws.on("framesent", frame => {
      const request = decodeRequest(frame.payload);
      if (request.ok && request.value.method === "fit.check") requests.set(request.value.id, `${request.value.params.model}@${request.value.params.numCtx}`);
    });
    ws.on("framereceived", frame => {
      const response = decodeServerMessage(frame.payload);
      if (response.ok && response.value.type === "response" && requests.has(response.value.id)) answered.add(response.value.id);
    });
  });
  const settled = async () => {
    await expect.poll(() => answered.size === requests.size).toBe(true);
    // Two frames, an idle callback and a pause: every chance a background warm-up would take.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => resolve())))));
    await page.waitForTimeout(500);
  };
  await open(); await waitReady(page); await settled();
  const idle = requests.size;
  expect(new Set(requests.values()).size, "idle checks only the selected pair").toBeLessThanOrEqual(1);
  const button = page.locator("#modelBtn");
  await button.hover();
  await expect.poll(() => requests.size, "hover warms the first view's checks").toBeGreaterThan(idle);
  await settled();
  expect(await page.locator("#picker").count(), "warming must not mount the picker").toBe(0);
  const warmed = requests.size;
  await button.focus(); await button.click();
  await expect(page.locator("#picker")).toBeVisible();
  await expect(page.locator("#picker")).not.toContainText("Checking…");
  await page.screenshot({ path: test.info().outputPath("picker-hover-complete.png") });
  await page.keyboard.press("Escape");
  await page.locator("#ta").focus(); await button.hover(); await button.focus(); await button.click();
  await expect(page.locator("#picker")).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(requests.size, "an opening after a warm, and repeated hover or focus, make no further check").toBe(warmed);
  await test.info().attach("session-fit-checks", { body: JSON.stringify({ idle, warmed, after: requests.size, pairs: [...requests.values()] }), contentType: "application/json" });
});

test("a warm invalidated before opening waits for current answers and reuses replacement checks", async ({ page, open }) => {
  const requests = new Map<string, string>(), answered = new Set<string>(), gpuRequests = new Set<string>();
  const held: (() => void)[] = [];
  let gpu: unknown, holding = false;
  let invalidate: () => void = () => { throw new Error(`No GPU connection after ${requests.size} fit requests`); };
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer();
    invalidate = () => {
      if (gpu === undefined) throw new Error("Missing measured GPU snapshot");
      holding = true;
      ws.send(JSON.stringify({ type: "push", channel: "gpu.changed", payload: gpu }));
    };
    ws.onMessage(message => {
      const request = decodeRequest(message);
      if (request.ok && request.value.method === "gpu.status") gpuRequests.add(request.value.id);
      if (request.ok && request.value.method === "fit.check") requests.set(request.value.id, `${request.value.params.model}@${request.value.params.numCtx}`);
      server.send(message);
    });
    server.onMessage(message => {
      const response = decodeServerMessage(message);
      if (response.ok && response.value.type === "response") {
        const frame = response.value;
        if (gpuRequests.delete(frame.id) && frame.ok) {
          const snapshot = decodeResult("gpu.status", frame.result);
          if (snapshot.ok) gpu = snapshot.value;
        }
        if (requests.has(frame.id)) {
          const deliver = () => { answered.add(frame.id); ws.send(message); };
          if (holding) held.push(deliver); else deliver();
          return;
        }
      }
      ws.send(message);
    });
  });
  await open(); await waitReady(page);
  const button = page.locator("#modelBtn"), picker = page.locator("#picker");
  // Composer readiness can precede hydration. Retry intent until the models
  // fixture has all six first-view pairs, not two startup reads of one pair.
  await expect.poll(async () => {
    await page.locator("#ta").hover(); await button.hover();
    return new Set(requests.values()).size;
  }).toBe(6);
  await expect.poll(() => answered.size === requests.size).toBe(true);
  const warmedPairs = new Set(requests.values()), warmed = requests.size;
  try {
    await page.locator("#ta").hover(); invalidate(); await button.hover();
    await expect.poll(() => held.length).toBe(warmedPairs.size);
    const replacing = requests.size;
    expect(replacing - warmed, "one replacement per warmed pair").toBe(warmedPairs.size);
    await button.click(); await expect(picker).toBeHidden();
    for (const release of held.splice(0, held.length - 1)) release();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(picker).toBeHidden();
    holding = false; for (const release of held.splice(0)) release();
    await expect(picker).toBeVisible(); await expect(page.locator("#pkSearch")).toBeFocused();
    await expect(picker).not.toContainText("Checking…");
    expect(requests.size, "opening adds no check to the replacement warm").toBe(replacing);
    await page.screenshot({ path: test.info().outputPath("picker-current-after-invalidation.png") });
    await test.info().attach("fit-check-counts", { body: JSON.stringify({ warmed, replacing, afterOpen: requests.size }), contentType: "application/json" });
  } finally { holding = false; for (const release of held.splice(0)) release(); }
});

test("the picker waits for missing fit replies and opens with a complete context column", async ({ page, open }) => {
  let holding = false;
  const held: (() => void)[] = [];
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer(), requests = new Set<unknown>();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
      if (holding && frame.method === "fit.check") requests.add(frame.id);
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; type?: string };
      if (frame.type === "response" && requests.delete(frame.id) && holding) held.push(() => ws.send(message));
      else ws.send(message);
    });
  });
  await open(); await waitReady(page);
  holding = true;
  try {
    await page.locator("#modelBtn").click();
    const picker = page.locator("#picker"), search = page.locator("#pkSearch");
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(picker).toBeHidden();
    holding = false;
    for (const release of held.splice(0)) release();
    await expect(picker).toBeVisible();
    await expect(search).toBeFocused();
    await expect(picker).not.toContainText("Checking…");
    const bounds = await picker.boundingBox();
    await page.screenshot({ path: test.info().outputPath("picker-complete-first-view.png") });
    await search.fill("qwen");
    await search.press("ArrowRight");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    await page.locator("#modelBtn").click();
    expect(await picker.boundingBox()).toEqual(bounds);
    await page.screenshot({ path: test.info().outputPath("picker-after-context-choice.png") });
  } finally {
    holding = false;
    for (const release of held.splice(0)) release();
  }
});

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
  // The closing sheet hands focus back to the model button by script. That is
  // not someone reaching for the picker, so it must not warm every installed
  // model at the new size. The pick itself preloads the model, and each fit
  // invalidation on the way rechecks the picked pair, as it did before warming.
  test("a pick at a new context size checks only the picked model after the sheet closes", async ({ page, open }) => {
    // `readyAt` is how many checks had been sent when the preload reported ready.
    const requests = new Map<string, string>(), answered = new Set<string>();
    let readyAt: number | undefined;
    page.on("websocket", ws => {
      ws.on("framesent", frame => {
        const request = decodeRequest(frame.payload);
        if (request.ok && request.value.method === "fit.check") requests.set(request.value.id, `${request.value.params.model}@${request.value.params.numCtx}`);
      });
      ws.on("framereceived", frame => {
        const response = decodeServerMessage(frame.payload);
        if (!response.ok) return;
        if (response.value.type === "response" && requests.has(response.value.id)) answered.add(response.value.id);
        const payload: unknown = response.value.type === "push" && response.value.channel === "models.load" ? response.value.payload : undefined;
        if (readyAt === undefined && typeof payload === "object" && payload !== null && "state" in payload && payload.state === "ready") readyAt = requests.size;
      });
    });
    await open(); await waitReady(page);
    await page.locator("#modelBtn").tap();
    const picker = page.locator("#picker");
    await expect(picker.locator(".pk-v").filter({ hasText: "Checking…" })).toHaveCount(0);
    await picker.locator('[data-m="gemma4:12b"]').tap();
    await expect(picker.locator(".pk-cost.pending")).toHaveCount(0);
    const before = new Set(requests.keys());
    readyAt = undefined;
    await picker.getByRole("radio", { name: /^8k/ }).tap();
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    // The refocus comes a frame after the close; the preload's ready push and the
    // recheck it causes come later, so by then any warm has been sent.
    await expect.poll(() => readyAt !== undefined, "the preload reports ready").toBe(true);
    await expect.poll(() => [...requests.values()].slice(readyAt).includes("gemma4:12b@8192"), "the recheck after the load").toBe(true);
    await expect.poll(() => answered.size === requests.size).toBe(true);
    const after = [...requests].filter(([id]) => !before.has(id)).map(([, pair]) => pair);
    expect(after.filter(pair => pair !== "gemma4:12b@8192"), `checks after the pick: ${after.join(", ")}`).toEqual([]);
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

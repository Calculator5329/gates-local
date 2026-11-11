import { expect, stack, test, waitReady } from "./fixtures.ts";
import { decodeRequest, decodeResult, decodeServerMessage, type FitTable } from "@gates-local/contracts";
import { FAKE_URL } from "./env.ts";
test.use({ viewport: { width: 1137, height: 749 }, video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

test("the client asks for the fit table once; hover, focus and opening the picker ask for nothing", async ({ page, open }) => {
  const asked: string[] = [];
  page.on("websocket", ws => {
    ws.on("framesent", frame => {
      const request = decodeRequest(frame.payload);
      if (request.ok && request.value.method.startsWith("fit.")) asked.push(request.value.method);
    });
  });
  await open(); await waitReady(page);
  await expect.poll(() => asked.length, "the session asks for the table at hydration").toBe(1);
  const button = page.locator("#modelBtn");
  await button.hover();
  // Two frames, an idle callback and a pause: every chance a background warm-up would take.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => resolve())))));
  await page.waitForTimeout(500);
  expect(await page.locator("#picker").count(), "hover must not mount the picker").toBe(0);
  await button.focus(); await button.click();
  await expect(page.locator("#picker")).toBeVisible();
  await expect(page.locator("#picker .fit-skel, #picker .pk-cost.skel")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("picker-hover-complete.png") });
  await page.keyboard.press("Escape");
  await page.locator("#ta").focus(); await button.hover(); await button.focus(); await button.click();
  await expect(page.locator("#picker")).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(asked, "opening, hover and focus make no fit request").toEqual(["fit.table"]);
});

test("a GPU change: a pick made on the older table cannot load what the new reading refuses, and the rows end on the new table", async ({ page, open }) => {
  const GIB = 1024 ** 3;
  // Tables the page got, tables held back, models.load asked and answered.
  const shown: FitTable[] = [], held: { table: FitTable; send: () => void }[] = [];
  const loadsAsked: string[] = [], loadEnds: string[] = [];
  let holding = false;
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer(), tableIds = new Set<string>(), loadIds = new Set<string>();
    ws.onMessage(message => {
      const request = decodeRequest(message);
      if (request.ok && request.value.method === "fit.table") tableIds.add(request.value.id);
      if (request.ok && request.value.method === "models.load") { loadIds.add(request.value.id); loadsAsked.push(request.value.params.model); }
      server.send(message);
    });
    server.onMessage(message => {
      const frame = decodeServerMessage(message);
      let table: FitTable | undefined;
      // A load refused at its fit check answers the request; one that started also pushes its end.
      if (frame.ok && frame.value.type === "response" && loadIds.delete(frame.value.id)) {
        const l = frame.value.ok ? decodeResult("models.load", frame.value.result) : undefined;
        loadEnds.push(l?.ok ? `${l.value.model}:${l.value.state}` : `answer:${frame.value.ok ? "undecoded" : "error"}`);
      }
      if (frame.ok && frame.value.type === "response" && tableIds.delete(frame.value.id) && frame.value.ok) {
        const r = decodeResult("fit.table", frame.value.result);
        if (r.ok) table = r.value;
      }
      if (frame.ok && frame.value.type === "push" && frame.value.channel === "fit.changed") {
        const r = decodeResult("fit.table", frame.value.payload);
        if (r.ok) table = r.value;
      }
      if (frame.ok && frame.value.type === "push" && frame.value.channel === "models.load") {
        const l = decodeResult("models.load", frame.value.payload);
        if (l.ok && l.value.state !== "loading") loadEnds.push(`${l.value.model}:${l.value.state}`);
      }
      if (table && holding) { const t = table; held.push({ table: t, send: () => { shown.push(t); ws.send(message); } }); return; }
      if (table) shown.push(table);
      ws.send(message);
    });
  });
  await open(); await waitReady(page);
  const picker = page.locator("#picker"), button = page.locator("#modelBtn");
  await expect.poll(() => shown.length, "the first table").toBeGreaterThan(0);
  const ctxText = (await button.locator(".picker-trigger-ctx").textContent())?.trim() ?? "";
  const numCtx = Number.parseInt(ctxText, 10) * 1024;
  await button.click();
  const selected = await picker.locator(".pk-r.sel").getAttribute("data-m");
  await page.keyboard.press("Escape"); await expect(picker).toBeHidden();
  try {
    // Another program fills the GPU. The server builds a table from the new reading; the page does not get it yet.
    holding = true;
    await stack.gpu(14_000);
    await expect.poll(() => held.length, { message: "the server pushes a table from the new reading", timeout: 15_000 }).toBeGreaterThan(0);
    const older = shown.at(-1)!, newer = held.at(-1)!.table;
    const row = (t: FitTable, model: string) => t.rows.find(r => r.model === model && r.numCtx === numCtx);
    // A model the older table lets the person pick and the new reading refuses outright.
    const target = older.rows.map(r => r.model).find(m => m !== selected && row(older, m)?.verdict !== "refuse" && row(newer, m)?.verdict === "refuse" && row(newer, m)?.stops.length === 0);
    expect(target, `a row pickable at ${ctxText} before and refused after: ${JSON.stringify(newer.rows.map(r => [r.model, r.numCtx, r.verdict]))}`).toBeDefined();
    if (!target) return;
    // The pick, made on the older table.
    await button.click();
    await picker.locator(`.pk-r[data-m="${target}"] .pk-select`).click();
    await expect.poll(() => loadsAsked.includes(target), "the pick asks the server to load it").toBe(true);
    await expect.poll(() => loadEnds, "the server judges the load on its own reading and refuses it").toContain(`${target}:error`);
    const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { loads: { model: string }[]; loaded: { name: string }[] };
    expect(state.loads.filter(l => l.model === target), "the runtime never started loading it").toEqual([]);
    expect(state.loaded.filter(l => l.name === target)).toEqual([]);
    // The new table arrives: the rows end on its values.
    holding = false;
    for (const h of held.splice(0)) h.send();
    const newest = shown.at(-1)!, need = row(newest, target)!.needVramBytes;
    await button.click();
    await expect(picker.locator(`.pk-r[data-m="${target}"] .pk-v`)).toHaveText(new RegExp(`^${(need / GIB).toFixed(1)}\\sGB$`, "u"));
    await expect(picker.locator(`.pk-r[data-m="${target}"] .pk-v`)).toHaveClass(/\bno\b/u);
    if (newest.memory.kind === "gpu") await expect(picker.locator(".pk-bottom")).toContainText(`${(newest.memory.freeBytes / GIB).toFixed(1)} GB free`);
    await page.screenshot({ path: test.info().outputPath("picker-after-gpu-change.png") });
  } finally {
    holding = false;
    for (const h of held.splice(0)) h.send();
    await stack.gpu(0);
  }
});

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

test("a loaded picker row counts the model's held allocation before drawing overflow", async ({ page, open }) => {
  // A measured row for the loaded pair whose need is larger than the free memory: the model already
  // holds its allocation, so the picker must not draw the part above free as overflow.
  const gib = 1024 ** 3;
  const measured = (table: FitTable): FitTable => ({ ...table, rows: table.rows.map(row => row.model === "qwen3.5:9b" && row.numCtx === 16384
    ? { ...row, source: "measured", verdict: "fits", needVramBytes: 7 * gib, freeVramBytes: 2 * gib, spillRamBytes: 0 } : row) });
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer(), requests = new Set<unknown>();
    ws.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; method?: string };
      if (frame.method === "fit.table") requests.add(frame.id);
      server.send(message);
    });
    server.onMessage(message => {
      const frame = JSON.parse(String(message)) as { id?: unknown; type?: string; ok?: boolean; channel?: string; result?: FitTable; payload?: FitTable };
      if (frame.type === "response" && frame.ok && requests.delete(frame.id) && frame.result) ws.send(JSON.stringify({ ...frame, result: measured(frame.result) }));
      else if (frame.type === "push" && frame.channel === "fit.changed" && frame.payload) ws.send(JSON.stringify({ ...frame, payload: measured(frame.payload) }));
      else ws.send(message);
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
  await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("picker-desktop.png") });
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
    await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
    const bounds = await picker.boundingBox();
    await page.screenshot({ path: test.info().outputPath("picker-phone-models.png") });
    await picker.locator('[data-m="gemma4:12b"]').tap();
    await expect(picker.locator(".pk-context")).toBeVisible();
    await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
    expect(await picker.boundingBox()).toEqual(bounds);
    await page.screenshot({ path: test.info().outputPath("picker-phone-context.png") });
    await picker.getByRole("radio", { name: /^8k/ }).tap();
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
  // The closing sheet hands focus back to the model button by script. A pick
  // preloads the model; the server pushes the next table after the load, and
  // the client asks for nothing on the way.
  test("a pick at a new context size asks for no fit value; the load pushes the next table", async ({ page, open }) => {
    const asked: string[] = [];
    let readyAt: number | undefined, tables = 0;
    page.on("websocket", ws => {
      ws.on("framesent", frame => {
        const request = decodeRequest(frame.payload);
        if (request.ok && request.value.method.startsWith("fit.")) asked.push(request.value.method);
      });
      ws.on("framereceived", frame => {
        const message = decodeServerMessage(frame.payload);
        if (!message.ok || message.value.type !== "push") return;
        if (message.value.channel === "fit.changed") tables++;
        const payload: unknown = message.value.channel === "models.load" ? message.value.payload : undefined;
        if (readyAt === undefined && typeof payload === "object" && payload !== null && "state" in payload && payload.state === "ready") readyAt = tables;
      });
    });
    await open(); await waitReady(page);
    await page.locator("#modelBtn").tap();
    const picker = page.locator("#picker");
    await picker.locator('[data-m="gemma4:12b"]').tap();
    await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
    const before = asked.length;
    readyAt = undefined;
    await picker.getByRole("radio", { name: /^8k/ }).tap();
    await expect(picker).toBeHidden();
    await expect(page.locator("#modelBtn .picker-trigger-ctx")).toHaveText("8k");
    await expect.poll(() => readyAt !== undefined, "the preload reports ready").toBe(true);
    await expect.poll(() => tables > (readyAt ?? Infinity), "the server pushes a table after the load").toBe(true);
    expect(asked.slice(before), "fit requests after the pick").toEqual([]);
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

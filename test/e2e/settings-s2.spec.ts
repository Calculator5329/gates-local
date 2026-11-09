/// <reference lib="dom" />
// Journeys: the Settings rows the S2 council asked for. Each row states what
// the app really does: Tools rows say what a tool needs and go where it is
// fixed, Default context says what it applies to, Runtime copies its address
// and folder, and Image generation teaches before the switch.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { GpuStatus } from "@gates-local/contracts";
import { CHECKOUT_CACHE } from "./env.ts";
import { expect, openGpuMemory, test, waitReady } from "./fixtures.ts";

test.use({ comfyUrl: "http://127.0.0.1:9" });

/** Open a Settings section, by the nav on a desktop width and the list on a phone. */
const section = async (page: Page, label: string) => {
  await page.keyboard.press("Control+Comma");
  if ((page.viewportSize()?.width ?? 0) <= 640) {
    await page.getByRole("button", { name: "Back to Settings" }).click();
    await page.locator(".set-list").getByRole("button", { name: label }).click();
  } else {
    await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
  }
  await expect(page.locator(".set h1").first()).toHaveText(label);
};

const color = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);

/** Change what the server says on its way to the page. */
const rewriteWire = (page: Page, rewrite: (v: unknown) => unknown) =>
  page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === "string" ? JSON.stringify(rewrite(JSON.parse(m))) : m));
  });

const addFolder = async (page: Page, name: string) => {
  const folder = path.join(CHECKOUT_CACHE, "e2e-library", name);
  mkdirSync(folder, { recursive: true });
  await section(page, "Library");
  await page.getByRole("button", { name: "Add folder…" }).click();
  await page.getByRole("textbox", { name: "Add a folder path" }).fill(folder);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(".srow .sl b", { hasText: name })).toBeVisible();
  return folder;
};

for (const width of [1280, 360] as const) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: 800 } });
    test("Runtime's switch shows its whole label", async ({ page, open }, info) => {
      await open();
      await waitReady(page);
      await section(page, "Runtime");
      const button = page.getByRole("button", { name: "Use Gates Local's Ollama", exact: true });
      await expect(button).toBeVisible();
      await expect(button).toHaveText("Use Gates Local's Ollama");
      const cut = await button.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(cut).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`settings-runtime-${width}.png`), fullPage: true });
    });

    test("a model's facts read in one order", async ({ page, open }) => {
      await open();
      await waitReady(page);
      await section(page, "Models");
      const row = page.locator(".mp-row").first();
      await expect(row.locator(".mp-l1 .mp-chip")).toBeVisible();
      await expect(row.locator(".mp-meta .mp-chip")).toHaveCount(0);
    });
  });
}

test("Tools rows say what each tool needs, and go where it is fixed", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "Tools");
  const set = page.locator(".set");
  const read = set.getByRole("button", { name: /^Read files/ });
  await expect(read).toContainText("Add a folder or file to your Library");
  await expect(read).toHaveClass(/\bdim\b/);
  await expect(read.locator(".dot")).toHaveCount(1);
  await read.click();
  await expect(set.getByRole("heading", { name: "Library" })).toBeVisible();

  await section(page, "Tools");
  const images = set.getByRole("button", { name: /^Make images/ });
  await expect(images).toContainText("Turned off");
  await expect(images).toHaveClass(/\bdim\b/);
  await images.click();
  await expect(set.getByRole("heading", { name: "Image generation" })).toBeVisible();

  await addFolder(page, "s2-tools");
  await section(page, "Tools");
  await expect(set.getByRole("button", { name: /^Read files/ })).toContainText("Ready");
  await expect(set.getByRole("button", { name: /^Read files/ })).not.toHaveClass(/\bdim\b/);

  // with the master switch off nothing is offered, and the fix is the switch itself
  await page.getByRole("switch", { name: "Let the model use tools" }).click();
  const off = set.locator(".srow", { hasText: "Read files" });
  await expect(off).toContainText("Turned off");
  await expect(off).toHaveClass(/\bdim\b/);
  await expect(off.getByRole("button")).toHaveCount(0);
  await expect(set.getByRole("button", { name: /^Read files/ })).toHaveCount(0);
});

/** Every Library source reads as a SQLite database on the wire. */
const allSqlite = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(allSqlite);
  if (typeof v !== "object" || v === null) return v;
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, allSqlite(x)]));
  return o["kind"] === "folder" && "state" in o ? { ...o, kind: "sqlite" } : o;
};

test("with only a SQLite database, Read files asks for a folder and Run commands is ready", async ({ page, open }) => {
  await rewriteWire(page, allSqlite);
  await open();
  await waitReady(page);
  await addFolder(page, "s2-only-a-database");
  await section(page, "Tools");
  const set = page.locator(".set");
  await expect(set.getByRole("button", { name: /^Read files/ })).toContainText("Add a folder or file to your Library");
  await expect(set.getByRole("button", { name: /^Read files/ })).toHaveClass(/\bdim\b/);
  await expect(set.getByRole("button", { name: /^Run commands/ })).toContainText("Ready");
});

test.describe("on Windows", () => {
  test.use({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" });
  test("with only a folder, Read files is ready and Query databases asks for a database", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await addFolder(page, "s2-only-a-folder");
    await section(page, "Tools");
    const set = page.locator(".set");
    await expect(set.getByRole("button", { name: /^Read files/ })).toContainText("Ready");
    const query = set.getByRole("button", { name: /^Query databases/ });
    await expect(query).toContainText("Add a SQLite database to your Library");
    await expect(query).toHaveClass(/\bdim\b/);
  });
});

test("Default context is a normal row with one live line, and the model's status sits beneath it", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const gpu = await openGpuMemory(page);
  const row = gpu.locator(".srow", { hasText: "Default context" });
  await expect(row.locator(".sl b")).toHaveText("Default context");
  const desc = row.locator(".sl .d").first();
  await expect(desc).toContainText("tokens");
  await expect(desc).toContainText("uses more GPU memory");
  expect(await color(page, "#gpuMemory .srow .sl b")).toBe(await color(page, "body"));
  const live = row.locator(".ctx-line");
  await expect(live).toHaveText(/^Estimated\. Runs on the GPU at 16k\.$/);
  await row.getByRole("button", { name: "8k" }).click();
  await expect(live).toHaveText(/at 8k\.$/);

  // the status for the current model is its own row, beneath the setting
  const status = gpu.locator(".fp-v");
  await expect(status).toContainText("Should run well");
  await expect(status).toContainText("at 8k");
  const [setting, below] = [await row.boundingBox(), await status.boundingBox()];
  expect(below?.y ?? 0).toBeGreaterThan((setting?.y ?? 0) + (setting?.height ?? 0) - 1);
  await expect(status.locator(".dot")).toHaveCount(1);
  await expect(status.locator(".stat")).toHaveCSS("color", await color(page, "body"));
});

type FitProbe = { frames: number; issues: string[]; stop(): void };

for (const width of [1280, 360]) {
  test(`SQ-03: a GPU refresh keeps the row, status and open Details mounted at ${width}px`, async ({ page, open }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let hold = false;
    let gpuStatus: GpuStatus | undefined;
    let pushGpu: (() => void) | undefined;
    const requests = new Map<string, string>();
    const queued: (() => void)[] = [];
    let pendingFits = 0;
    await page.routeWebSocket(/127\.0\.0\.1:5286/, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const frame = typeof message === "string" ? JSON.parse(message) as { type?: string; method?: string; id?: string } : undefined;
        if (frame?.type === "request" && frame.method !== undefined && frame.id !== undefined) {
          requests.set(frame.id, frame.method);
          if (frame.method === "fit.check") {
            pendingFits++;
            if (hold) { queued.push(() => server.send(message)); return; }
          }
        }
        server.send(message);
      });
      server.onMessage(message => {
        const frame = typeof message === "string" ? JSON.parse(message) as { type?: string; id?: string; channel?: string; result?: GpuStatus } : undefined;
        // Drive this transition ourselves rather than racing the periodic GPU watcher.
        if (frame?.type === "push" && frame.channel === "gpu.changed") return;
        if (frame?.type === "response" && frame.id !== undefined) {
          const method = requests.get(frame.id);
          requests.delete(frame.id);
          if (method === "gpu.status") gpuStatus = frame.result;
          if (method === "fit.check") pendingFits--;
        }
        ws.send(message);
      });
      pushGpu = () => {
        if (gpuStatus === undefined) throw new Error("GPU snapshot has not arrived");
        ws.send(JSON.stringify({ type: "push", channel: "gpu.changed", payload: { ...gpuStatus, freeBytes: 0, measuredAt: gpuStatus.measuredAt + 1 } }));
      };
    });
    await open();
    await waitReady(page);
    await section(page, "Advanced");
    await expect(page.locator("#gpuMemory .fp-v")).toContainText("Should run well");
    await expect.poll(() => pendingFits).toBe(0);
    await page.locator("#gpuMemory .fp-more summary").click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: info.outputPath(`fit-before-${width}.png`), fullPage: true });
    await page.evaluate(() => {
      const selectors = ["#gpuMemory", "#gpuMemory .srow", "#gpuMemory .srow:has(.fp-v)", "#gpuMemory .ctx-line", "#gpuMemory .fp-v", "#gpuMemory .fp-more"];
      const nodes = selectors.map(selector => document.querySelector<HTMLElement>(selector));
      if (nodes.some(node => node === null)) throw new Error("Fit layout is not ready");
      const heights = nodes.map(node => node?.getBoundingClientRect().height ?? 0);
      const details = document.querySelector<HTMLDetailsElement>("#gpuMemory .fp-more");
      if (!details?.open) throw new Error("Details must start open");
      const probe: FitProbe = { frames: 0, issues: [], stop: () => undefined };
      const add = (issue: string) => { if (!probe.issues.includes(issue)) probe.issues.push(issue); };
      const sample = () => {
        selectors.forEach((selector, index) => {
          const node = document.querySelector<HTMLElement>(selector);
          if (node === null || node !== nodes[index] || !node.isConnected) add(`${selector}: disappeared or remounted`);
          if (node !== null && (node.getClientRects().length === 0 || getComputedStyle(node).visibility === "hidden" || getComputedStyle(node).opacity === "0")) add(`${selector}: not visible`);
          if (node !== null && node.getBoundingClientRect().height !== heights[index]) add(`${selector}: height changed`);
        });
        if (!document.querySelector<HTMLDetailsElement>("#gpuMemory .fp-more")?.open) add("Details collapsed");
      };
      let frame = 0;
      const tick = () => { probe.frames++; sample(); frame = requestAnimationFrame(tick); };
      const observer = new MutationObserver(sample);
      observer.observe(document.querySelector("#gpuMemory")!, { subtree: true, childList: true, attributes: true, characterData: true });
      frame = requestAnimationFrame(tick);
      probe.stop = () => { sample(); cancelAnimationFrame(frame); observer.disconnect(); };
      (window as Window & { fitProbe?: FitProbe }).fitProbe = probe;
    });
    try {
      hold = true;
      if (pushGpu === undefined) throw new Error("WebSocket is not connected");
      pushGpu();
      await expect.poll(() => queued.length).toBeGreaterThan(0);
      await expect(page.locator("#gpuMemory .fp-v")).toContainText("Rechecking");
      await expect(page.locator("#gpuMemory .fp-v")).not.toContainText("Should run well");
      await page.evaluate(() => new Promise<void>(resolve => {
        let remaining = 6;
        const tick = () => { if (--remaining === 0) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }));
      await page.screenshot({ path: info.outputPath(`fit-pending-${width}.png`), fullPage: true });
      hold = false;
      for (const send of queued.splice(0)) send();
      await expect.poll(() => pendingFits).toBe(0);
      await page.screenshot({ path: info.outputPath(`fit-after-${width}.png`), fullPage: true });
    } finally {
      hold = false;
      for (const send of queued.splice(0)) send();
      await page.evaluate(() => (window as Window & { fitProbe?: FitProbe }).fitProbe?.stop());
    }
    const probe = await page.evaluate(() => {
      const value = (window as Window & { fitProbe?: FitProbe }).fitProbe;
      return { frames: value?.frames ?? 0, issues: value?.issues ?? ["sampler missing"] };
    });
    expect(probe.frames).toBeGreaterThanOrEqual(6);
    expect(probe.issues).toEqual([]);
  });
}

test("context is one size across chats, and Settings says so", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const gpu = await openGpuMemory(page);
  const desc = gpu.locator(".srow", { hasText: "Default context" }).locator(".sl .d").first();
  await expect(desc).toContainText("one size for all your chats");
  await expect(desc).toContainText("changes every chat until you reopen the app");
  await expect(desc).not.toContainText("each chat");
  await page.keyboard.press("Escape");

  // what those words promise: a size picked in one chat is still the size in the next
  const contextMenu = async () => {
    await page.locator("#modelBtn").click();
    return page.locator("#picker").getByRole("radiogroup", { name: "Context" });
  };
  const first = await contextMenu();
  await first.getByRole("radio", { name: "8k" }).click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("8k");
  await page.keyboard.press("Control+n");
  const next = await contextMenu();
  await expect(next.getByRole("radio", { name: "8k" })).toHaveAttribute("aria-checked", "true");
});

test.describe("options that would read alike", () => {
  test.use({ installed: ["local/model:9b-q4_K_M", "local/model:9b-q8_0", "alice/custom:latest", "bob/custom:latest"] });
  test("show what differs, and each carries its full id as a tooltip and accessible name", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await section(page, "Models");
    const select = page.locator(".mp-select");
    await select.click();
    const list = page.getByRole("listbox", { name: "Installed chat models" });
    for (const [id, variant] of [
      ["local/model:9b-q4_K_M", "q4_K_M"],
      ["local/model:9b-q8_0", "q8_0"],
      ["alice/custom:latest", "alice"],
      ["bob/custom:latest", "bob"],
    ] as const) {
      const option = list.getByRole("option", { name: id });
      await expect(option).toHaveCount(1);
      await expect(option).toContainText(variant);
      await expect(option).toHaveAttribute("data-tip", id);
      await option.hover();
      await expect(page.locator("#tip.open")).toContainText(id);
    }
    await list.getByRole("option", { name: "bob/custom:latest" }).click();
    await expect(select).toContainText("custom");
    await expect(select).toContainText("bob");
    await expect(select).toHaveAccessibleName("Default for new chats: custom bob");
  });
});

test("Models says the same fit in the same words, with colour only on the dot", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "Models");
  const fit = page.locator('.mp-row[data-dm="gemma4:12b"] .mp-fitc .mp-fit');
  await expect(fit).toHaveText("Should run well");
  await expect(fit.locator("svg")).toHaveCount(0);
  await expect(fit.locator(".dot.ok")).toHaveCount(1);
  expect(await fit.evaluate((el) => getComputedStyle(el).color)).toBe(await color(page, "body"));
  await expect(fit.locator(".mp-w")).toHaveCSS("text-decoration-line", "none");
});

test.describe("a model the catalog does not know", () => {
  test.use({ installed: ["qwen3.5:9b", "tiny-chat:2k"] });
  test("gets a cleaned name, its Ollama id in gray, and the same row height", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await section(page, "Models");
    const known = page.locator('.mp-row[data-dm="qwen3.5:9b"]');
    const unknown = page.locator('.mp-row[data-dm="tiny-chat:2k"]');
    await expect(unknown.locator(".mp-l1")).toContainText("tiny 2k chat");
    await expect(unknown.locator(".mp-p")).toHaveText("tiny-chat:2k");
    // compared inside the row: the second row also carries the 1 px divider above it
    expect((await unknown.locator(".mp-nm").boundingBox())?.height).toBe((await known.locator(".mp-nm").boundingBox())?.height);
  });
});

const savedDefault = (v: unknown, model: string): unknown => {
  if (Array.isArray(v)) return v.map((x) => savedDefault(x, model));
  if (typeof v !== "object" || v === null) return v;
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, savedDefault(x, model)]));
  return "thinking" in o && "runtimeMode" in o ? { ...o, defaultModel: model } : o;
};

test("a saved default that can't run here says which model new chats really start on", async ({ page, open }) => {
  await rewriteWire(page, (v) => savedDefault(v, "qwen3.8-abliterated:27b"));
  await open();
  await waitReady(page);
  await section(page, "Models");
  await expect(page.locator(".mp-fb")).toHaveText(/won't run here, so new chats start on Qwen 3\.5 9B\.$/);
});

test("a Library folder shows its path on one line, with nothing that looks like an error", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const folder = await addFolder(page, "s2-a-rather-long-folder-name-that-has-to-stay-on-one-line-in-the-row");
  const row = page.locator(".srow.src").first();
  const line = row.locator(".path");
  await expect(line).toHaveAttribute("data-tip", folder);
  await expect(row.locator(".src-d")).toHaveCount(0);
  await expect(row).not.toContainText("bytes");
  const [box, style] = await line.evaluate((el) => [el.getBoundingClientRect().height, parseFloat(getComputedStyle(el).lineHeight)] as const);
  expect(box).toBeLessThan(style * 1.5);
  await expect(page.locator(".grp", { hasText: "Files and folders" })).toContainText("The model always sees the latest version.");
  await expect(page.locator(".grp", { hasText: "SQLite databases" })).toContainText("Later changes show up after you refresh it.");
});

test.describe("copying from Runtime", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  test("the address has Copy, and a folder nobody here can know is never guessed at", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await section(page, "Runtime");
    const set = page.locator(".set");
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    const address = set.getByRole("button", { name: "Copy Ollama address" });
    await address.click();
    await expect(set.locator(".srow", { hasText: "Ollama address" }).getByRole("button")).toHaveText("Copied");
    expect(await clip()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(set.getByRole("button", { name: "Copy models folder path" })).toHaveCount(0);
    await expect(set.getByRole("button", { name: "Open models folder" })).toHaveCount(0);
    await expect(set.locator(".srow", { hasText: "Using the system Ollama" })).toHaveCount(0);
    await expect(set.locator(".path")).toHaveCount(0);
    await expect(set.locator(".srow", { hasText: /^Models/ })).toContainText("3 models");
  });

  test("Gates Local's own folder is the one the server reports, in Copy and in the words", async ({ page, open }) => {
    await rewriteWire(page, appOwned);
    await open();
    await waitReady(page);
    await section(page, "Runtime");
    const set = page.locator(".set");
    await set.getByRole("button", { name: "Copy models folder path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPORTED_MODELS_DIR);
    await expect(set.locator(".path")).toHaveAttribute("data-tip", REPORTED_MODELS_DIR);
    // a browser, as on a phone, cannot open a folder on the computer
    await expect(set.getByRole("button", { name: "Open models folder" })).toHaveCount(0);
  });
});

const desktopWindow = (page: Page, folder: string | null = REPORTED_MODELS_DIR) =>
  page.addInitScript((knownFolder: string | null) => {
    let reads = 0;
    Object.assign(window, {
      gatesLocal: {
        getServerUrl: () => Promise.resolve(new URLSearchParams(location.search).get("server")),
        onState: () => () => undefined,
        modelsFolder: () => {
          Object.assign(window, { folderReads: ++reads });
          return Promise.resolve(knownFolder);
        },
        openModelsFolder: (...args: unknown[]) => {
          Object.assign(window, { opened: "models", openArgs: args });
          return Promise.resolve(null);
        },
      },
    });
  }, folder);

/** Not the usual place: a guessed path can't match it, as with XDG_DATA_HOME or GATES_LOCAL_DATA_DIR set. */
const REPORTED_MODELS_DIR = "/data/apps/gates-local/models";

/** The stack has no Ollama to install, so a healthy status reads as the app's own copy on the wire. */
const appOwned = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(appOwned);
  if (typeof v !== "object" || v === null) return v;
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, appOwned(x)]));
  return "owner" in o && "baseUrl" in o ? { ...o, owner: "app", modelsDir: REPORTED_MODELS_DIR } : o;
};

test.describe("on the desktop", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  test("Open carries no path and Copy uses the folder main knows, even outside the usual place", async ({ page, open }) => {
    await desktopWindow(page);
    await rewriteWire(page, appOwned);
    await open();
    await waitReady(page);
    await section(page, "Runtime");
    await page.getByRole("button", { name: "Open models folder" }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { opened?: string }).opened)).toBe("models");
    expect(await page.evaluate(() => (window as Window & { openArgs?: unknown[] }).openArgs)).toEqual([]);
    await page.getByRole("button", { name: "Copy models folder path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(REPORTED_MODELS_DIR);
  });

  test("an unknown folder in main has no Models folder row or Open action", async ({ page, open }) => {
    await desktopWindow(page, null);
    await rewriteWire(page, appOwned);
    await open();
    await waitReady(page);
    await section(page, "Runtime");
    await expect.poll(() => page.evaluate(() => (window as Window & { folderReads?: number }).folderReads ?? 0)).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Open models folder" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy models folder path" })).toHaveCount(0);
    await expect(page.locator(".set .path")).toHaveCount(0);
  });

  test("the system Ollama's folder has neither Copy nor Open, because only the system knows where it is", async ({ page, open }) => {
    await desktopWindow(page);
    await open();
    await waitReady(page);
    await section(page, "Runtime");
    await expect(page.locator(".set .srow", { hasText: "Ollama address" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy models folder path" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open models folder" })).toHaveCount(0);
  });

  test("Copy keeps its width through every state, so nothing beside it moves", async ({ page, open }) => {
    await desktopWindow(page);
    await rewriteWire(page, appOwned);
    // the first copy works, every later one fails both ways
    await page.addInitScript(() => {
      let writes = 0;
      navigator.clipboard.writeText = () => (writes++ === 0 ? Promise.resolve() : Promise.reject(new Error("denied")));
      document.execCommand = () => false;
    });
    await open();
    await waitReady(page);
    await section(page, "Runtime");
    const row = page.locator(".set .srow", { hasText: "Models folder" });
    const copy = row.getByRole("button").last();
    const openFolder = row.getByRole("button", { name: "Open models folder" });
    const measure = async () => ({ copy: (await copy.boundingBox())?.width, open: (await openFolder.boundingBox())?.x, path: (await row.locator(".path").boundingBox())?.width });
    await expect(copy).toHaveText("Copy");
    const before = await measure();
    await copy.click();
    await expect(copy).toHaveText("Copied");
    expect(await measure()).toEqual(before);
    await copy.click();
    await expect(copy).toHaveText("Couldn't copy");
    expect(await measure()).toEqual(before);
    const cut = await copy.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(cut).toBeLessThanOrEqual(0);
  });
});

test("Image generation teaches before the switch, and says Not connected after it", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "Image generation");
  const set = page.locator(".set");
  const setup = set.getByRole("link", { name: "How to set up" });
  await expect(setup).toHaveAttribute("href", /github\.com.*image-generation-with-comfyui/);
  await expect(set).toContainText("Install ComfyUI first");
  await page.getByRole("switch", { name: "Generate images" }).click();
  await expect(set.locator(".srow", { hasText: "Not connected" })).toBeVisible();
  await expect(set).not.toContainText("Not found");
  await expect(set.getByRole("button", { name: "Test connection" })).toBeVisible();
  await expect(set.locator(".srow", { hasText: "ComfyUI address" })).toContainText("Only change this if ComfyUI runs somewhere else.");
});

test("Reset's confirm uses the danger button", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await section(page, "Advanced");
  await page.getByRole("button", { name: "Reset…" }).click();
  const reset = page.getByRole("group", { name: "Confirm reset" }).getByRole("button", { name: "Reset", exact: true });
  await expect(reset).toHaveClass(/mp-danger/);
});

test("GPU Details spell things out and turn a chevron", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const gpu = await openGpuMemory(page);
  const summary = gpu.locator("summary");
  await expect(summary.locator("svg")).toHaveCount(1);
  const shut = await summary.locator("svg").evaluate((el) => getComputedStyle(el).transform);
  await summary.click();
  await expect.poll(() => summary.locator("svg").evaluate((el) => getComputedStyle(el).transform)).not.toBe(shut);
  await summary.hover();
  await expect(summary).toHaveCSS("text-decoration-line", "none");
  const details = gpu.locator("details");
  await expect(details).toContainText("estimated");
  await expect(details).not.toContainText("est.");
  await expect(details).toContainText("Speed: not measured yet.");
  await expect(details.locator(".fp-mt", { hasText: "Speed" })).toHaveCount(0);
});

test("the small things line up", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const top = async (label: string) => {
    await section(page, label);
    return (await page.locator(".set h1").first().boundingBox())?.y;
  };
  expect(await top("Models")).toBe(await top("General"));
  await section(page, "Models");
  const sizes = await page.locator(".mp-th > span").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
  expect(new Set(sizes).size).toBe(1);

  await section(page, "General");
  const group = await page.locator(".grp-t").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const row = await page.locator(".sl b").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(group).toBeGreaterThan(row);
  const on = page.getByRole("group", { name: "Theme" }).locator("button.on");
  expect(await on.evaluate((el) => getComputedStyle(el).boxShadow)).not.toContain("inset");
  expect(await on.evaluate((el) => getComputedStyle(el, "::after").height)).toBe("2px");

  await section(page, "Tools");
  const knob = await page.getByRole("switch", { name: "Let the model use tools" }).evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
  expect(knob).toBe("rgb(255, 255, 255)");

  await section(page, "Advanced");
  await expect(page.locator(".set-h p")).toBeVisible();
  await expect(page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).locator("use")).toHaveAttribute("href", "#i-sliders");
  await section(page, "Shortcuts");
  await expect(page.locator(".set-h p")).toContainText("fixed for now");
});

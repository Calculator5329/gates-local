/// <reference lib="dom" />
// Fixes from the first review of the chat-feel lane: a failed fit check ends
// the held verdict, Export as Markdown makes a file only from a loaded thread,
// and downloads remain reachable from the picker.
import { readFile } from "node:fs/promises";
import type { Download, Page, WebSocketRoute } from "@playwright/test";
import { expect, stack, test, waitReady } from "./fixtures.ts";

/**
 * Sits between the page and the server on the app's WebSocket: counts requests
 * by method, can answer chosen methods with an error, and can push a frame to
 * the page as if the server sent it.
 */
interface Tap {
  readonly calls: Map<string, number>;
  /** Methods answered with an error instead of reaching the server. */
  readonly fail: Set<string>;
  /** Methods whose answer reaches the page this many ms late (the server has already acted). */
  readonly late: Map<string, number>;
  readonly hold: Set<string>;
  queued(method: string): number;
  release(method: string): number;
  readonly pending: Set<unknown>;
  /** Methods whose result is rewritten on its way to the page: what another client changed since this one last looked. */
  readonly edit: Map<string, (result: unknown) => unknown>;
  push(channel: string, payload: unknown): void;
}

async function tap(page: Page): Promise<Tap> {
  const calls = new Map<string, number>();
  const fail = new Set<string>();
  const late = new Map<string, number>();
  const hold = new Set<string>();
  const held = new Map<string, (() => void)[]>();
  const pending = new Set<unknown>();
  const edit = new Map<string, (result: unknown) => unknown>();
  const methodOf = new Map<unknown, string>();
  let app: WebSocketRoute | undefined;
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const req = parse(m);
      if (req?.type === "request" && typeof req.method === "string") {
        // the app's socket, not the dev server's reload socket
        app = ws;
        calls.set(req.method, (calls.get(req.method) ?? 0) + 1);
        methodOf.set(req.id, req.method);
        pending.add(req.id);
        if (fail.has(req.method)) {
          pending.delete(req.id);
          ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "test: refused by the tap" } }));
          return;
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const res = parse(m);
      const method = res?.type === "response" ? (methodOf.get(res.id) ?? "") : res?.type === "push" ? channelOf(res) : "";
      const change = edit.get(method);
      const frame = change === undefined ? m : rewritten(m, change);
      const deliver = () => { pending.delete(res?.id); ws.send(frame); };
      if (hold.has(method)) {
        const waiting = held.get(method) ?? [];
        waiting.push(deliver); held.set(method, waiting);
      } else {
        const ms = late.get(method);
        if (ms === undefined) deliver();
        else setTimeout(deliver, ms);
      }
    });
  });
  return {
    calls,
    fail,
    late,
    hold,
    pending,
    queued: method => held.get(method)?.length ?? 0,
    release: method => {
      hold.delete(method);
      const waiting = held.get(method) ?? [];
      held.delete(method);
      waiting.forEach(deliver => deliver());
      return waiting.length;
    },
    edit,
    push: (channel, payload) => app?.send(JSON.stringify({ type: "push", channel, payload })),
  };
}

function rewritten(m: string | Buffer, change: (result: unknown) => unknown): string {
  const frame = JSON.parse(String(m)) as { result?: unknown };
  return JSON.stringify({ ...frame, result: change(frame.result) });
}

function channelOf(frame: object): string {
  return "channel" in frame && typeof frame.channel === "string" ? frame.channel : "";
}

function parse(m: string | Buffer): { type?: unknown; id?: unknown; method?: unknown } | undefined {
  if (typeof m !== "string") return undefined;
  try {
    return JSON.parse(m) as { type?: unknown; id?: unknown; method?: unknown };
  } catch {
    return undefined;
  }
}

/** Gemma 4 12B at 64k: the fake GPU refuses it, and Send says so. */
async function refusedGemma(page: Page): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator("#pkSearch").fill("gemma");
  await page.locator('#picker .pk-r[data-m="gemma4:12b"]').click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#modelBtn")).toContainText("Gemma 4 12B");
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Advanced", exact: true }).click();
  await page.locator(".set").getByRole("button", { name: "64k" }).first().click();
  await expect(page.locator(".set")).toContainText("Needs ");
  await page.keyboard.press("Escape");
  await page.locator("#ta").fill("Too big?");
  await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tip", /not enough memory at 64k/);
}

test.describe("a failed fit check", () => {
  test("memory frees and the refresh fails: Send is not left refused by the old verdict, and the check is asked again", async ({ page, open }) => {
    const t = await tap(page);
    await open();
    await waitReady(page);
    await refusedGemma(page);
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await expect.poll(() => t.pending.size).toBe(0);

    // another model leaves the GPU; the fresh check fails
    t.fail.add("fit.check");
    const before = t.calls.get("fit.check") ?? 0;
    t.push("models.load", { model: "qwen3.5:9b", numCtx: 16384, state: "unloaded" });
    await expect.poll(() => t.calls.get("fit.check") ?? 0).toBeGreaterThan(before);
    await expect(send).not.toHaveAttribute("data-tip", /not enough memory/);
    await expect(send).not.toHaveAttribute("aria-disabled", /./);

    // a failure is not a verdict to keep: the check is asked again with no other change
    t.fail.delete("fit.check");
    await expect(send).toHaveAttribute("data-tip", /not enough memory at 64k/, { timeout: 15_000 });
  });

  test("a load error invalidates the fit checks", async ({ page, open }) => {
    const t = await tap(page);
    await open();
    await waitReady(page);
    await refusedGemma(page);
    await expect.poll(() => t.pending.size).toBe(0);
    const before = t.calls.get("fit.check") ?? 0;
    t.push("models.load", { model: "gemma4:12b", numCtx: 65536, state: "error", message: "test: the load failed" });
    await expect.poll(() => t.calls.get("fit.check") ?? 0).toBeGreaterThan(before);
    await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tip", /not enough memory at 64k/);
  });
});

const ctx = (page: Page, size: string) => page.locator("#picker").getByRole("radiogroup", { name: "Context length" }).getByRole("radio", { name: new RegExp(`^${size}`) });

test.describe("downloads from the approved picker", () => {
  test("the footer opens the real Download tab; estimates follow 16k to 64k and back", async ({ page, open }) => {
    const t = await tap(page), reports = new Map<number, string>();
    t.edit.set("fit.check", result => {
      if (result && typeof result === "object" && "model" in result && result.model === "qwen3:14b" && "numCtx" in result && typeof result.numCtx === "number" && "verdict" in result && typeof result.verdict === "string") reports.set(result.numCtx, result.verdict);
      return result;
    });
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
    await expect(page.getByRole("tab", { name: /^Download/ })).toHaveAttribute("aria-selected", "true");
    const dl = page.locator('.dlrow[data-cat="qwen3:14b"]');
    await expect(dl).toBeVisible();
    await expect(dl.getByRole("button", { name: "Download", exact: true })).toBeEnabled();
    await expect(dl.locator(".dl-v .vl")).toHaveText("Runs on GPU");
    await expect(dl.locator(".dl-v small")).toHaveText(/est\. \d+\.\d\sGB at 16k/);
    await page.getByRole("button", { name: /^Back to chat/ }).click();
    await page.locator("#modelBtn").click();
    await ctx(page, "64k").click();
    await expect(page.locator("#picker")).toBeHidden();
    await page.locator("#modelBtn").click();
    await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
    // Selecting a context now preloads the current model. Its allocation can make
    // the offered model slower or refused; compare the UI with the actual check.
    await expect.poll(async () => `${reports.get(65536)}:${await dl.locator(".dl-v .vl").textContent()}`)
      .toMatch(/^(spills:Uses system memory · slower|refuse:Not enough memory at 64k)$/);
    await expect(dl.locator(".dl-v small")).toHaveText(/est\. \d+\.\d\sGB at 64k/);
    await expect(dl.locator(".dl-v")).toHaveAttribute("data-tip", /at 64k/);
    await expect(dl.locator("xpath=../..").locator(".grp-t")).not.toHaveText("Recommended");
    await page.getByRole("button", { name: /^Back to chat/ }).click();
    await page.locator("#modelBtn").click();
    await ctx(page, "16k").click();
    await expect(page.locator("#picker")).toBeHidden();
    await page.locator("#modelBtn").click();
    await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
    await expect.poll(async () => `${reports.get(16384)}:${await dl.locator(".dl-v .vl").textContent()}`)
      .toMatch(/^(fits:Runs on GPU|spills:Uses system memory · slower|refuse:Not enough memory at 16k)$/);
    await expect(dl.locator(".dl-v small")).toHaveText(/est\. \d+\.\d\sGB at 16k/);
  });

  test("a pull started in Download appears disabled in the picker with real progress and need", async ({ page, open }) => {
    await stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 64 * 1024 * 1024 });
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#picker").getByRole("button", { name: "Download models", exact: true }).click();
    await page.locator('.dlrow[data-cat="qwen3.5:4b"]').getByRole("button", { name: "Download", exact: true }).click();
    await page.getByRole("button", { name: /^Back to chat/ }).click();
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("qwen 3.5 4b");
    const downloading = page.locator("#picker .pk-r.dis", { hasText: "Qwen 3.5 4B" });
    await expect(downloading).toHaveAttribute("aria-disabled", "true");
    await expect(downloading.locator(".pk-v")).toHaveText(/\d+%/);
    await expect(downloading).toHaveAttribute("data-tip", /GB estimated; fits on GPU/);
  });
});

/** Choose this model, then open the picker again. */
async function pick(page: Page, tag: string): Promise<void> {
  await page.locator(`#picker .pk-r[data-m="${tag}"]`).click();
  await expect(page.locator("#picker")).toBeHidden();
  await page.locator("#modelBtn").click();
}

/** Tab from the search box until a context size has the focus; undefined if none ever does. */
async function tabToSize(page: Page): Promise<string | undefined> {
  await page.locator("#pkSearch").focus();
  for (let n = 0; n < 40; n++) {
    await page.keyboard.press("Tab");
    const size = await page.evaluate(() => document.activeElement?.getAttribute("data-ctx") ?? undefined);
    if (size !== undefined) return size;
  }
  return undefined;
}

/** 64k chosen on a model that takes it, then a model that stops at 32k, with the picker open. */
async function cappedAt32k(page: Page): Promise<void> {
  await page.locator("#modelBtn").click();
  await pick(page, "qwen3.5:9b");
  await ctx(page, "64k").click();
  await expect(page.locator("#picker")).toBeHidden();
  await page.locator("#modelBtn").click();
  await expect(ctx(page, "64k")).toHaveAttribute("aria-checked", "true");
  await pick(page, "mid-chat:32k");
  await expect(page.locator("#modelBtn")).toContainText("32k");
  await expect(ctx(page, "64k")).toBeDisabled();
}

test.describe("the context sizes when the chosen one is more than the model takes", () => {
  test.use({ installed: ["qwen3.5:9b", "mid-chat:32k"] });

  test("Tab reaches the capped size and Left returns to search", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await cappedAt32k(page);
    expect(await tabToSize(page)).toBe("32768");
    await page.keyboard.press("ArrowLeft");
    await expect(ctx(page, "32k")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#pkSearch")).toBeFocused();
  });

  test("Down from the capped size wraps to the smallest and Enter commits it", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await cappedAt32k(page);
    expect(await tabToSize(page)).toBe("32768");
    await page.keyboard.press("ArrowDown");
    await expect(ctx(page, "8k")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#picker")).toBeHidden();
    await expect(page.locator("#modelBtn")).toContainText("8k");
  });
});

const row = (page: Page, title: string) => page.locator(".sb-row", { hasText: title });

/** Every download the page starts, from now on. */
function downloads(page: Page): Download[] {
  const got: Download[] = [];
  page.on("download", (d) => got.push(d));
  return got;
}

async function exportRow(page: Page, title: string): Promise<void> {
  await row(page, title).click({ button: "right" });
  await page.locator("#threadMenu").getByRole("menuitem", { name: "Export as Markdown" }).click();
}

test.describe("Export as Markdown from the thread menu", () => {
  test.use({ seed: "design" });
  const OTHER = "Fix the backup cron";

  test("a thread not loaded yet exports from its own load, and the open thread stays open", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // the open thread has loaded, so a load the tap fails or holds below is only the export's
    await expect(page.locator(".tl .turn").first()).toBeVisible();
    t.late.set("threads.get", 1000);
    const got = page.waitForEvent("download");
    await exportRow(page, OTHER);
    const file = await got;
    expect(file.suggestedFilename()).toBe(`${OTHER}.md`);
    const md = await readFile(await file.path(), "utf8");
    expect(md.startsWith(`# ${OTHER}\n`)).toBe(true);
    expect(md).toContain("## You");
    await expect(page.locator(".hdr h2")).toHaveText("Library: Effect Schema books");
  });

  test("a thread already cached exports what the server says now, not the cached copy", async ({ page, open, seededThread }) => {
    const OPEN = "Library: Effect Schema books";
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    await expect(page.locator(".tl .turn").first()).toBeVisible();
    await row(page, OTHER).click();
    await expect(page.locator(".hdr h2")).toHaveText(OTHER);
    // another client added a reply this one never heard about
    t.edit.set("threads.get", (result) => {
      const answer = result as { messages: { id: string; content: string }[] };
      return { ...answer, messages: [...answer.messages, { ...answer.messages.at(-1), id: "added-elsewhere", content: "A reply added on the other device" }] };
    });
    const got = page.waitForEvent("download");
    await exportRow(page, OPEN);
    const md = await readFile(await (await got).path(), "utf8");
    expect(md).toContain("A reply added on the other device");
  });

  test("a load that fails says so and makes no file", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // the open thread has loaded, so a load the tap fails or holds below is only the export's
    await expect(page.locator(".tl .turn").first()).toBeVisible();
    const files = downloads(page);
    t.fail.add("threads.get");
    await exportRow(page, OTHER);
    await expect(page.locator('.c-note[role="status"]')).toContainText(`Couldn't export “${OTHER}”`);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(files).toHaveLength(0);
  });

  test("a load slower than the limit says so and makes no file", async ({ page, open, seededThread }) => {
    await page.clock.install();
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // the open thread has loaded, so a load the tap fails or holds below is only the export's
    await expect(page.locator(".tl .turn").first()).toBeVisible();
    const files = downloads(page);
    t.hold.add("threads.get");
    const before = t.calls.get("threads.get") ?? 0;
    await exportRow(page, OTHER);
    await expect.poll(() => t.calls.get("threads.get") ?? 0).toBeGreaterThan(before);
    await page.clock.fastForward(10_001);
    await expect(page.locator('.c-note[role="status"]')).toContainText("took too long");
    await expect.poll(() => t.queued("threads.get")).toBe(1);
    expect(t.release("threads.get")).toBe(1);
    await page.clock.runFor(1000);
    expect(files).toHaveLength(0);
  });

  test("a thread deleted while it loads says so and makes no file", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // the open thread has loaded, so a load the tap fails or holds below is only the export's
    await expect(page.locator(".tl .turn").first()).toBeVisible();
    const files = downloads(page);
    t.late.set("threads.get", 1500);
    await exportRow(page, OTHER);
    await row(page, OTHER).click({ button: "right" });
    await page.locator("#threadMenu").getByRole("menuitem", { name: "Delete thread" }).click();
    await expect(row(page, OTHER)).toHaveCount(0);
    await expect(page.locator('.c-note[role="status"]')).toContainText("it was deleted");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(files).toHaveLength(0);
  });

  for (const preload of ["in flight", "cached"] as const) {
    test(`deleting during export ignores hover history ${preload}`, async ({ page, open, seededThread }) => {
      const t = await tap(page);
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      await expect(page.locator(".tl .turn").first()).toBeVisible();
      const files = downloads(page);
      if (preload === "in flight") t.hold.add("threads.get");
      const before = t.calls.get("threads.get") ?? 0;
      await row(page, OTHER).hover();
      await expect.poll(() => t.calls.get("threads.get") ?? 0).toBe(before + 1);
      if (preload === "in flight") await expect.poll(() => t.queued("threads.get")).toBe(1);
      else await expect.poll(() => t.pending.size).toBe(0);

      // Hold the export independently: a completed hover is never its source.
      t.hold.add("threads.get");
      await exportRow(page, OTHER);
      const held = preload === "in flight" ? 2 : 1;
      await expect.poll(() => t.queued("threads.get")).toBe(held);
      // Model a delete requested before history arrives but confirmed after it.
      t.hold.add("threads.delete");
      t.hold.add("threads.changed");
      await row(page, OTHER).click({ button: "right" });
      await page.locator("#threadMenu").getByRole("menuitem", { name: "Delete thread" }).click();
      await expect.poll(() => t.queued("threads.delete")).toBe(1);
      expect(t.release("threads.get")).toBe(held);
      await expect.poll(() => t.pending.size).toBe(1);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(files).toHaveLength(0);
      expect(t.release("threads.delete")).toBe(1);
      expect(t.release("threads.changed")).toBe(1);
      await expect(row(page, OTHER)).toHaveCount(0);
      await expect(page.locator('.c-note[role="status"]')).toContainText("it was deleted");
      expect(files).toHaveLength(0);
    });
  }
});

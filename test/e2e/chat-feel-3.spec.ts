/// <reference lib="dom" />
// Fixes from the first review of the chat-feel lane: a failed fit check ends
// the held verdict, Export as Markdown makes a file only from a loaded thread,
// and a download row's fit follows the picker's context.
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
  /** Methods whose result is rewritten on its way to the page: what another client changed since this one last looked. */
  readonly edit: Map<string, (result: unknown) => unknown>;
  push(channel: string, payload: unknown): void;
}

async function tap(page: Page): Promise<Tap> {
  const calls = new Map<string, number>();
  const fail = new Set<string>();
  const late = new Map<string, number>();
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
        if (fail.has(req.method)) {
          ws.send(JSON.stringify({ type: "response", id: req.id, ok: false, error: { code: "internal", message: "test: refused by the tap" } }));
          return;
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const res = parse(m);
      const method = res?.type === "response" ? (methodOf.get(res.id) ?? "") : "";
      const change = edit.get(method);
      const frame = change === undefined ? m : rewritten(m, change);
      const ms = late.get(method);
      if (ms === undefined) ws.send(frame);
      else setTimeout(() => ws.send(frame), ms);
    });
  });
  return {
    calls,
    fail,
    late,
    edit,
    push: (channel, payload) => app?.send(JSON.stringify({ type: "push", channel, payload })),
  };
}

function rewritten(m: string | Buffer, change: (result: unknown) => unknown): string {
  const frame = JSON.parse(String(m)) as { result?: unknown };
  return JSON.stringify({ ...frame, result: change(frame.result) });
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
    // let the checks in flight answer: a push during one is overwritten by its answer
    await page.waitForTimeout(500);

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
    await page.waitForTimeout(500);
    const before = t.calls.get("fit.check") ?? 0;
    t.push("models.load", { model: "gemma4:12b", numCtx: 65536, state: "error", message: "test: the load failed" });
    await expect.poll(() => t.calls.get("fit.check") ?? 0).toBeGreaterThan(before);
    await expect(page.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tip", /not enough memory at 64k/);
  });
});

const ctx = (page: Page, size: string) => page.locator("#picker").getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: size });

test.describe("picker download rows at the picker's context", () => {
  test("changing Context from 16k to 64k, a download row's fit, Recommended and tooltip follow", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("qwen 3 14b");
    const dl = page.locator('#picker .pk-dr[data-dl="qwen3:14b"]');
    await expect(ctx(page, "16k")).toHaveAttribute("aria-checked", "true");
    await expect(dl.locator(".pk-v")).toHaveText("Fits");
    await expect(dl.locator(".pk-rec")).toHaveAttribute("data-tip", /room for 16k/);

    await ctx(page, "64k").click();
    await expect(ctx(page, "64k")).toHaveAttribute("aria-checked", "true");
    await expect(dl.locator(".pk-v")).toHaveText("Slower");
    // it no longer runs on the GPU at 64k, so nothing promises it does
    await expect(dl.locator(".pk-rec")).toHaveCount(0);
    await expect(dl).toHaveAttribute("data-tip", /at 64k spills/);

    await ctx(page, "16k").click();
    await expect(dl.locator(".pk-v")).toHaveText("Fits");
    await expect(dl).toHaveAttribute("data-tip", /at 16k fits on the GPU/);
  });

  test("a downloading row states its fit at the picker's context", async ({ page, open }) => {
    await stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 64 * 1024 * 1024 });
    await open();
    await waitReady(page);
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("qwen 3.5 4b");
    await page.locator('#picker .pk-dr[data-dl="qwen3.5:4b"]').getByRole("button", { name: "Download Qwen 3.5 4B" }).click();
    const downloading = page.locator("#picker .pk-r.dis", { hasText: "Qwen 3.5 4B" });
    await expect(downloading).toContainText("Downloading");
    await expect(downloading).toHaveAttribute("data-tip", /at 16k fits on the GPU/);
    const need = async () => /est\. ([\d.]+ GB)/.exec((await downloading.getAttribute("data-tip")) ?? "")?.[1];
    const at16 = await need();
    expect(at16).toBeDefined();
    await ctx(page, "64k").click();
    await expect(downloading).toHaveAttribute("data-tip", /at 64k fits on the GPU/);
    // the estimate itself is the one at 64k: a bigger KV cache, so a bigger need
    await expect.poll(need).not.toBe(at16);
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
  await expect(ctx(page, "64k")).toHaveAttribute("aria-checked", "true");
  await pick(page, "mid-chat:32k");
  await expect(page.locator("#picker .pk-help")).toHaveText("Runs at 32k, the most this model takes.");
  await expect(ctx(page, "64k")).toBeDisabled();
}

test.describe("the context sizes when the chosen one is more than the model takes", () => {
  test.use({ installed: ["qwen3.5:9b", "mid-chat:32k"] });

  test("Tab reaches the largest size the model takes, and Left chooses it", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await cappedAt32k(page);
    expect(await tabToSize(page)).toBe("32768");
    await page.keyboard.press("ArrowLeft");
    await expect(ctx(page, "32k")).toHaveAttribute("aria-checked", "true");
    await expect(ctx(page, "32k")).toBeFocused();
  });

  test("Right from there chooses the smallest", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await cappedAt32k(page);
    expect(await tabToSize(page)).toBe("32768");
    await page.keyboard.press("ArrowRight");
    await expect(ctx(page, "8k")).toHaveAttribute("aria-checked", "true");
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
  await page.locator("#moreMenu").getByRole("menuitem", { name: "Export as Markdown" }).click();
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
    await expect(page.getByRole("status")).toContainText(`Couldn't export “${OTHER}”`);
    await page.waitForTimeout(1000);
    expect(files).toHaveLength(0);
  });

  test("a load slower than the limit says so and makes no file", async ({ page, open, seededThread }) => {
    const t = await tap(page);
    await open(`#thread=${seededThread ?? ""}`);
    await waitReady(page);
    // the open thread has loaded, so a load the tap fails or holds below is only the export's
    await expect(page.locator(".tl .turn").first()).toBeVisible();
    const files = downloads(page);
    t.late.set("threads.get", 12_000);
    await exportRow(page, OTHER);
    await expect(page.getByRole("status")).toContainText("took too long", { timeout: 12_000 });
    await page.waitForTimeout(1000);
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
    await page.locator("#moreMenu").getByRole("menuitem", { name: "Delete thread" }).click();
    await expect(row(page, OTHER)).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("it was deleted");
    await page.waitForTimeout(1000);
    expect(files).toHaveLength(0);
  });
});

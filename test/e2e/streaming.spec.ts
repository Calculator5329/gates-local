/// <reference lib="dom" />
// Streaming continuity: partial words show at once, Stop keeps them, and the
// reveal stays steady between network bursts.
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { appUrl } from "./env.ts";

test.use({ screenshot: "only-on-failure" });

interface Frame {
  at: number;
  gap: number;
  chars: number;
  height: number;
  top: number;
  bottom: number;
  oldShift: number;
  raw: boolean;
  writing: boolean;
  thinking: boolean;
  received: number;
  revealed: number;
}
interface Probe {
  start: number;
  firstDelta?: number;
  done?: number;
  removed: number;
  frames: Frame[];
  stopped?: boolean;
}
declare global {
  interface Window { streamProbe: Probe }
}

function installProbe(): void {
  const p: Probe = { start: 0, removed: 0, frames: [] };
  window.streamProbe = p;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (m: MessageEvent<string>) => {
        const e = JSON.parse(m.data) as { payload?: { event?: { type: string } } };
        const kind = e.payload?.event?.type;
        if (kind === "delta") p.firstDelta ??= performance.now();
        if (kind === "done") p.done = performance.now();
      });
    }
  };
  const seen = new Map<Element, number>();
  new MutationObserver((ms) => {
    if (!p.start) return;
    for (const m of ms) for (const n of m.removedNodes) {
      if (!(n instanceof Element)) continue;
      p.removed += [...seen.keys()].filter((el) => el === n || n.contains(el)).length;
    }
  }).observe(document, { subtree: true, childList: true });
  let last = performance.now();
  const tick = (at: number) => {
    if (p.stopped) return;
    if (p.start) {
      const tl = document.querySelector(".tl");
      const turn = [...document.querySelectorAll(".turn.a")].at(-1);
      const md = turn?.querySelector(".md");
      let oldShift = 0;
      for (const el of md?.children ?? []) {
        const offset = el.getBoundingClientRect().top + (tl?.scrollTop ?? 0);
        const prev = seen.get(el);
        if (prev !== undefined) oldShift = Math.max(oldShift, Math.abs(offset - prev));
        seen.set(el, offset);
      }
      const prose = [...(md?.querySelectorAll("p,h1,h2,h3,h4,li,td,th") ?? [])].map((el) => el.textContent ?? "").join(" ");
      p.frames.push({ at: at - p.start, gap: at - last, chars: md?.textContent?.length ?? 0,
        height: md?.getBoundingClientRect().height ?? 0, top: tl?.scrollTop ?? 0,
        bottom: tl ? tl.scrollHeight - tl.scrollTop - tl.clientHeight : 0, oldShift,
        raw: /\*\*|```|\|\s*---/.test(prose), writing: !!turn?.querySelector(".writing"),
        thinking: !!turn?.querySelector(".working.thinking"),
        received: Number(turn?.getAttribute("data-received") ?? 0), revealed: Number(turn?.getAttribute("data-revealed") ?? 0) });
    }
    last = at;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Guards the owner's ask that streaming shows words as they come, not a whole paragraph at a time.
test("streaming keeps partial prose visible instead of waiting for a paragraph", async ({ page, open }) => {
  await stack.scenario("slow-drip", { tokenDelayMs: 20, longDrip: 1, holdAfterTokens: 14 });
  await open();
  await waitReady(page);
  await sendMessage(page, "Check disk space");
  const prose = page.locator(".turn.a .md p").first();
  await expect(prose).toContainText("Start with");
  await expect(prose).not.toContainText("full disk");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

// Guards the owner's ask that Stop keeps the partial reply, with no extra line of words.
test("Stop keeps the rendered blocks and cancels further text", async ({ page, open }) => {
  await stack.scenario("slow-drip", { tokenDelayMs: 20, holdAfterTokens: 46 });
  await open();
  await waitReady(page);
  await sendMessage(page, "Check disk space");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".md h2")).toBeVisible();
  const first = await reply.locator(".md p").first().elementHandle();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  // the person's Stop: the stop square and its seconds in the reply's actions row, no line of words
  await expect(reply.locator(".a-act.stop .s")).toHaveText(/^\d+ s$/);
  await expect(page.locator(".stop-note")).toHaveCount(0);
  expect(await first!.evaluate((el) => el.isConnected)).toBe(true);
  // Stop cancels delivery; the already received pacing tail still drains.
  await expect(reply.locator(".writing")).toHaveCount(0);
  const text = await reply.locator(".md").textContent();
  await page.waitForTimeout(250);
  expect(await reply.locator(".md").textContent()).toBe(text);
});

// Guards the owner's ask for a steady paced reveal: words keep coming between network bursts.
test("steady pacing continues between delivery bursts and finishes the complete reply", async ({ browser, seededThread }) => {
  test.info().annotations.push({ type: "budget", description: "Real rendering frames between spaced network bursts prove visible pacing; immediate delivery cannot exercise this behavior." });
  void seededThread;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
  try {
    await page.addInitScript(installProbe);
    await stack.scenario("slow-drip", { longDrip: 1, burstTokens: 26, tokenDelayMs: 120 });
    await page.goto(appUrl());
    await waitReady(page);
    await page.evaluate(() => { window.streamProbe.start = performance.now(); });
    await sendMessage(page, "Check disk space with bursty delivery");
    await expect(page.locator(".turn.a").last()).toHaveClass(/done/, { timeout: 30_000 });
    await expect(page.locator(".turn.a .md")).toContainText("without an extra blank line");
    const p = await page.evaluate(() => { window.streamProbe.stopped = true; return window.streamProbe; });
    const intermediate = p.frames.filter((f, i) => {
      const prev = p.frames[i - 1];
      return prev && f.received === prev.received && f.chars > prev.chars;
    }).length;
    expect(intermediate, "visible text advances on frames between network bursts").toBeGreaterThan(50);
    expect(p.frames.filter((f) => f.raw)).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

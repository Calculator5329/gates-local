/// <reference lib="dom" />
// Per-frame measurements are opt-in; the short continuity probes always run.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

test("streaming keeps completed blocks and the open thinking disclosure through completion", async ({ page, open }) => {
  await stack.scenario("slow-drip", { tokenDelayMs: 20 });
  await open();
  await waitReady(page);
  await sendMessage(page, "Check disk space");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".md h2")).toBeVisible();
  const first = await reply.locator(".md p").first().elementHandle();
  await reply.locator(".think").click();
  await expect(reply).toHaveClass(/done/, { timeout: 15_000 });
  expect(await first!.evaluate((el) => el.isConnected), "completed paragraph survives the final handoff").toBe(true);
  await expect(reply.locator(".think")).toHaveAttribute("aria-expanded", "true");
});

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

test("streaming under reduced motion shows arrivals without intermediate paced frames", async ({ page, open }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(installProbe);
  await stack.scenario("slow-drip", { longDrip: 1, burstTokens: 26, tokenDelayMs: 240 });
  await open();
  await waitReady(page);
  await page.evaluate(() => { window.streamProbe.start = performance.now(); });
  await sendMessage(page, "Check disk space with reduced motion");
  await expect(page.locator(".turn.a").last()).toHaveClass(/done/, { timeout: 30_000 });
  const probe = await page.evaluate(() => { window.streamProbe.stopped = true; return window.streamProbe; });
  const active = probe.frames.filter((f) => f.received > 0);
  expect(active.length).toBeGreaterThan(20);
  expect(active.every((f) => f.revealed === f.received), "reduced motion bypasses the pacing reservoir").toBe(true);
  expect(active.filter((f) => f.raw)).toHaveLength(0);
  await expect(page.locator(".turn.a .md")).toContainText("without an extra blank line");
});

test("Stop keeps the rendered blocks and cancels further text", async ({ page, open }) => {
  await stack.scenario("slow-drip", { tokenDelayMs: 20, holdAfterTokens: 46 });
  await open();
  await waitReady(page);
  await sendMessage(page, "Check disk space");
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator(".md h2")).toBeVisible();
  const first = await reply.locator(".md p").first().elementHandle();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(reply.locator(".stopped")).toBeVisible();
  expect(await first!.evaluate((el) => el.isConnected)).toBe(true);
  // Stop cancels delivery; the already received pacing tail still drains.
  await expect(reply.locator(".writing")).toHaveCount(0);
  const text = await reply.locator(".md").textContent();
  await page.waitForTimeout(250);
  expect(await reply.locator(".md").textContent()).toBe(text);
});

for (const rate of [20, 60, 110]) {
  test(`measure mixed Markdown at ${rate} fake tokens per second`, async ({ page, open }, info) => {
    const root = process.env["GL_STREAM_MEASURE"];
    test.skip(!root, "set GL_STREAM_MEASURE to an evidence directory");
    test.setTimeout(120_000);
    await page.addInitScript(installProbe);
    await stack.scenario("slow-drip", { tokenDelayMs: 1000 / rate, longDrip: 1 });
    await open();
    await waitReady(page);
    await page.evaluate(() => { window.streamProbe.start = performance.now(); });
    await sendMessage(page, "Check disk space with a long example");
    const dir = path.join(root!, String(rate));
    await mkdir(dir, { recursive: true });
    let readerTop: number | undefined;
    let readerAt = Infinity;
    let readerDrift = 0;
    let followGap = 0;
    const shots: string[] = [];
    for (let i = 0; i < 260; i++) {
      // A screenshot burst at 250 ms, alongside the independent rAF samples.
      const shot = path.join(dir, `${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path: shot });
      shots.push(shot);
      const state = await page.evaluate(() => {
        const tl = document.querySelector(".tl")!;
        return { done: !!window.streamProbe.done, at: performance.now() - window.streamProbe.start, top: tl.scrollTop, height: tl.scrollHeight, viewport: tl.clientHeight };
      });
      if (readerTop === undefined) followGap = Math.max(followGap, state.height - state.top - state.viewport);
      if (readerTop === undefined && state.height > state.viewport + 400) {
        readerAt = state.at;
        readerTop = await page.locator(".tl").evaluate((el) => { el.scrollTop = 100; return el.scrollTop; });
      } else if (readerTop !== undefined && !state.done) readerDrift = Math.max(readerDrift, Math.abs(state.top - readerTop));
      if (state.done) break;
      await page.waitForTimeout(250);
    }
    await expect(page.locator(".turn.a").last()).toHaveClass(/done/);
    await page.waitForTimeout(100);
    const probe = await page.evaluate(() => { window.streamProbe.stopped = true; return window.streamProbe; });
    const visible = probe.frames.filter((f) => f.chars > 0);
    const jumps = probe.frames.flatMap((f, i) => {
      const prev = probe.frames[i - 1];
      return prev && f.chars !== prev.chars ? [{ at: f.at, chars: f.chars - prev.chars, px: f.height - prev.height }] : [];
    });
    const summary = {
      rate, frames: probe.frames.length, over16: probe.frames.filter((f) => f.gap > 16).length,
      over50: probe.frames.filter((f) => f.gap > 50).length, removedBlocks: probe.removed,
      firstVisibleMs: visible[0]?.at, deltaToVisibleMs: probe.firstDelta === undefined ? undefined : (visible[0]?.at ?? 0) - (probe.firstDelta - probe.start),
      rawFrames: probe.frames.filter((f) => f.raw).length, oldShiftPx: Math.max(0, ...probe.frames.map((f) => f.oldShift)),
      readerDriftPx: readerDrift, followAfterPaintGapPx: followGap,
      followRafGapPx: Math.max(0, ...probe.frames.filter((f) => f.at < readerAt).map((f) => f.bottom)),
      finalHandoff: probe.frames.flatMap((f, i) => {
        const prev = probe.frames[i - 1];
        return prev?.writing && !f.writing ? [{ chars: f.chars - prev.chars, height: f.height - prev.height, scroll: f.top - prev.top }] : [];
      }),
      maxBacklogChars: Math.max(0, ...probe.frames.map((f) => f.received - f.revealed)),
      completionTailMs: probe.done === undefined ? undefined : (probe.frames.find((f) => f.at >= probe.done! - probe.start && !f.writing)?.at ?? 0) - (probe.done - probe.start),
      jumps, shots: shots.length,
    };
    await writeFile(path.join(dir, "probe.json"), JSON.stringify({ summary, probe }, null, 2));
    await info.attach(`stream-${rate}`, { body: JSON.stringify(summary), contentType: "application/json" });
    console.log(JSON.stringify(summary));
  });
}

test("steady pacing continues between delivery bursts and finishes the complete reply", async ({ browser, seededThread }, info) => {
  test.info().annotations.push({ type: "budget", description: "Real rendering frames between spaced network bursts prove visible pacing; immediate delivery cannot exercise this behavior." });
  void seededThread;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", recordVideo: { dir: info.outputPath("video") } });
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
    const maxBacklog = Math.max(0, ...p.frames.map((f) => f.received - f.revealed));
    const tail = p.done === undefined ? undefined : (p.frames.find((f) => f.at >= p.done! - p.start && !f.writing)?.at ?? 0) - (p.done - p.start);
    console.log(JSON.stringify({ intermediateFrames: intermediate, maxBacklogChars: maxBacklog, completionTailMs: tail }));
    expect(intermediate, "visible text advances on frames between network bursts").toBeGreaterThan(50);
    expect(p.frames.filter((f) => f.raw)).toHaveLength(0);
    const evidence = info.outputPath("paced-bursts.json");
    await writeFile(evidence, JSON.stringify({ intermediate, maxBacklog, tail, probe: p }));
    await info.attach("paced-bursts", { path: evidence, contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

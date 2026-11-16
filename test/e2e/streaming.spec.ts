/// <reference lib="dom" />
// Streaming continuity: partial words show at once, Stop keeps them, and the
// reveal stays steady between network bursts. A reply grows through partial
// blocks to the whole answer, and a stopped reply is marked by a stop square and
// the server's seconds, the same in every window and after a reload.
import type { Page } from "@playwright/test";
import { DRIP_REPLY } from "../fake-ollama/fake-ollama.ts";
import { blockPrefix, type BlockSnap } from "./block-prefix.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { tap } from "./socket-tap.ts";
import { holds } from "./waits.ts";
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
  await holds(page, 250, () => reply.locator(".md").textContent(), text, { message: "the stopped reply's words" });
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

/** Records the last reply's blocks on every DOM change. */
function sampleReplies(): void {
  const w = window as unknown as { glSamples: BlockSnap[][] };
  w.glSamples = [];
  const snap = () => {
    const md = [...document.querySelectorAll(".turn.a .md")].at(-1);
    if (!md) return;
    w.glSamples.push(
      [...md.children].map((c) => ({ tag: c.tagName, text: c.textContent ?? "" })),
    );
  };
  new MutationObserver(snap).observe(document, { subtree: true, childList: true, characterData: true });
}

test.describe("the whole answer", () => {
  // no image engine answers here
  test.use({ comfyUrl: "http://127.0.0.1:9" });

  // Guards the owner's ask: a reply streams as it is written, then shows the whole answer.
  test("a streaming reply grows through partial blocks, then the whole answer", async ({ page, open }) => {
    await page.addInitScript(sampleReplies);
    await open();
    await waitReady(page);
    await stack.scenario("slow-drip");
    await sendMessage(page, "How do I check disk space before a download?");
    const reply = page.locator(".turn.a").last();
    await expect(reply).toHaveClass(/\bdone\b/, { timeout: 15_000 });
    await expect(reply.locator(".md table")).toBeVisible();

    const samples = await page.evaluate(() => (window as unknown as { glSamples: BlockSnap[][] }).glSamples);
    const final = samples.at(-1) ?? [];
    // Prose appears before its paragraph completes; finished blocks stay put.
    expect(samples.filter((s) => s.length > 0 && s.length < final.length).length).toBeGreaterThan(2);
    expect(samples.filter((s) => s[0]?.tag === "P" && s[0].text.length > 0 && s[0].text.length < (final[0]?.text.length ?? 0)).length).toBeGreaterThan(2);
    for (const s of samples) expect(blockPrefix(s, final), JSON.stringify(s.at(-1))).toBe(true);
    expect(final.map((b) => b.tag)).toEqual(["P", "H2", "UL", "DIV", "TABLE", "P"]);
    // the final text is the whole answer: every word of the reply, in order
    const words = DRIP_REPLY.split(/\s+/).filter((w) => w !== "" && !/^(#+|-|```\w*|\||---)$/.test(w));
    const finalText = final.map((b) => b.text).join(" ");
    let from = 0;
    for (const w of words) {
      const at = finalText.indexOf(w, from);
      expect(at, `"${w}" in the final reply`).toBeGreaterThanOrEqual(0);
      from = at + w.length;
    }
  });
});

const stopSecs = (page: Page) => page.locator(".turn.a").last().locator(".stop-mark .s");

// Guards one number for a stopped reply: the seconds are counted where the reply ran, not on the clock of the window that pressed Stop.
test("Stop on a slow connection shows the same seconds in the pressing window, a second window and after a reload", async ({ page, open, context }) => {
  test.setTimeout(60_000);
  const t = await tap(page);
  // the press reaches the server a second and a half after the click
  t.late.set("reply.stop", 1500);
  await open();
  await waitReady(page);
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await sendMessage(page, "How do I check disk space before a download?");
  await expect(page.locator(".turn.a .md ul li")).toHaveCount(3, { timeout: 20_000 });

  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await expect(other.locator(".turn.a .md ul li"), "the second window watches the same reply").toHaveCount(3, { timeout: 20_000 });

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(stopSecs(page)).toHaveText(/^\d+ s$/);
  const pressed = (await stopSecs(page).textContent()) ?? "";
  await page.screenshot({ path: test.info().outputPath("pressing-window.png") });
  await expect(stopSecs(other), "the second window shows the pressing window's seconds").toHaveText(pressed);
  await other.screenshot({ path: test.info().outputPath("second-window.png") });
  // the saved row takes the live one's place without the number changing
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.locator(".turn.a").last()).toHaveClass(/\binterrupted\b/);
  await expect(stopSecs(page), "the number never changes in the pressing window").toHaveText(pressed);

  await page.reload();
  await waitReady(page);
  await expect(stopSecs(page), "a reload shows the same seconds").toHaveText(pressed);
  await other.close();
});

test.describe("a reply the person stopped", () => {
  const UNSEEN = "Stopped. The model won't see this reply.";
  const OLD_WORDS = /excluded from later model prompts|Its text is kept here|Stopped after|Interrupted before this reply finished/;
  // Guards the owner's ruling (N11): a stopped reply gets a stop square and its seconds, no line of words, and its text holds still.
  test("is marked by a stop square and its seconds in its actions row, with no line of words, and its text holds still", async ({ page, open }) => {
    await open(); await waitReady(page);
    await stack.scenario("models", { tokenDelayMs: 120 });
    await sendMessage(page, "Tell me about cron");
    const reply = page.locator(".turn.a").last();
    await expect(reply.locator(".think.run")).toBeVisible();
    await expect.poll(async () => (await reply.locator(".md").innerText()).split(/\s+/).length).toBeGreaterThan(8);
    // where the reply's last block sits in the column, before Stop, right after, once saved, after a reload
    const blocks = reply.locator(".md > *");
    const k = await blocks.count();
    const box = () => page.locator(".turn.a").last().locator(".md > *").nth(k - 1).evaluate(el => {
      const r = el.getBoundingClientRect(), c = el.closest(".col")!.getBoundingClientRect();
      return { top: r.top - c.top, left: r.left - c.left, height: r.height };
    });
    const before = await box();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(reply.locator(".think.run")).toHaveCount(0);
    const stopped = await box();
    await expect(page.locator(".turn.a.interrupted")).toHaveCount(1);
    await expect(reply.locator(".a-act")).toHaveCount(1);
    const saved = await box();

    await expect(page.getByText(OLD_WORDS)).toHaveCount(0);
    await expect(page.locator(".stop-note")).toHaveCount(0);
    const mark = reply.getByRole("img", { name: UNSEEN, exact: true });
    await expect(mark).toBeVisible();
    await expect(mark).toHaveAttribute("data-tip", UNSEEN);
    await expect(reply.locator(".a-act.stop .stop-mark .s")).toHaveText(/^\d+ s$/);

    // the reply's text holds still from Stop through the save
    expect(stopped.top, "Stop leaves the last block where it was").toBeCloseTo(before.top, 1);
    expect(saved, "saving leaves it where it was").toEqual(stopped);

    // after a reload the server's record of how the reply ended still says when: the same square and seconds, the same text in the same place
    await page.reload(); await waitReady(page);
    const kept = page.locator(".turn.a.interrupted");
    await expect(kept).toHaveCount(1);
    await expect(kept.getByRole("img", { name: UNSEEN, exact: true })).toBeVisible();
    await expect(kept.locator(".stop-mark .s")).toHaveText(/^\d+ s$/);
    await expect(page.locator(".stop-note")).toHaveCount(0);
    await expect(page.getByText(OLD_WORDS)).toHaveCount(0);
    expect(await box(), "a reload leaves it where it was").toEqual(saved);
  });
});

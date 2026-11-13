/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { CONTROL_URL, FAKE_URL, appUrl } from "../e2e/env.ts";
import { install, measure, type LaterEnd, type Observation } from "./probe.ts";
import { metric, quantile, type Run } from "./stats.ts";
import { selectJourneys, type Journey } from "./selection.ts";
import type { FixtureIds } from "./fixture.ts";
import { fakeVoice } from "./voice-fixture.ts";
import { threadReply } from "../fake-ollama/fake-ollama.ts";
import { parallelPrompt } from "./workload.ts";
import { STREAM_REPLY } from "../fake-ollama/stream-reply.ts";

const only = selectJourneys(process.env["GL_PERF_ONLY"]);
if (!only) throw new Error("Priority journeys require an explicit --only selection");
const selected = new Set<Journey>(only);
selected.delete("desktop-launch");
const samples = Number(process.env["GL_PERF_SAMPLES"] ?? 5);
const values = new Map<string, { unit: "ms" | "count"; samples: number[] }>();
const hoverDwellMs = 350;
declare global { interface Window { threadMotionQueries: number; threadHeightReads: number } }
const profilers = new WeakMap<Page, CDPSession>();
let profileIndex = 0;
const add = (name: string, value: number, unit: "ms" | "count" = "ms") => {
  const metricRow = values.get(name) ?? { unit, samples: [] }; metricRow.samples.push(value); values.set(name, metricRow);
};
function smooth(name: string, o: Observation) {
  // Short windows' p95 duplicates their max; only switches span many frames.
  if (name === "parallel-switch") add(`${name}.frame-p95`, quantile(o.frames, .95));
  add(`${name}.frame-max`, Math.max(...o.frames));
  if (name !== "thread-200-cold-click" && name !== "paste-text-50000") {
    add(`${name}.long-tasks`, o.longTasks.length, "count"); add(`${name}.long-task-time`, o.longTasks.reduce((a, b) => a + b, 0));
  }
}
async function quiet(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function timing(page: Page, name: string, trigger: () => Promise<unknown>, event: string, selector: string, text = "", mode = "text", later?: LaterEnd) {
  await quiet(page);
  const profiler = profilers.get(page);
  await profiler?.send("Profiler.start");
  const o = await measure(page, trigger, event, selector, text, mode, later); add(name, o.elapsed);
  if (profiler) {
    const profile = await profiler.send("Profiler.stop");
    const out = process.env["GL_PERF_OUT"] ?? "perf-results";
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${++profileIndex}-${name}.cpuprofile`), JSON.stringify(profile.profile));
    console.log("Profile", name, await page.evaluate(() => {
      const rows = (window as Window & { glRows?: { renders: Record<string, number> } }).glRows?.renders ?? {};
      return { rows: Object.keys(rows).length, renders: Object.values(rows).reduce((a, b) => a + b, 0), nodes: document.querySelectorAll(".tl *").length };
    }));
  }
  return o;
}
async function scenario(scenarioName = "slow-drip", options: Record<string, unknown> = {}) {
  const response = await fetch(`${FAKE_URL}/__fake/scenario`, { method: "POST", body: JSON.stringify({ scenario: scenarioName, firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, loadDelayMs: 0, ...options }) });
  if (!response.ok) throw new Error("Could not configure fake inference");
}
const ready = (page: Page) => expect(page.locator(".composer:not(.blocked) #ta")).toBeEnabled();
async function row(page: Page, id: string) {
  const button = page.locator(`.sb-row[data-thread="${id}"] .sb-thread`); await button.scrollIntoViewIfNeeded(); return button;
}
async function openShort(page: Page, id: string) { await (await row(page, id)).click(); await expect(page.locator(".bubble")).toContainText("Short marker"); }
async function newThread(page: Page) { await page.keyboard.press("Control+n"); await expect(page.locator(".turn")).toHaveCount(0); await ready(page); }
async function send(page: Page, text: string) { await page.locator("#ta").fill(text); await page.locator("#ta").press("Enter"); await expect(page.locator(".turn.a:not(.done) .md")).toBeVisible(); }
async function stop(page: Page) { await page.getByRole("button", { name: "Stop", exact: true }).click(); await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0); }
function threadId(page: Page) { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread"); if (!id) throw new Error("Missing selected thread"); return id; }

test("focused priority production journeys", async ({ browser }) => {
  const loadBefore = loadavg();
  const seed = await (await fetch(`${CONTROL_URL}/seed`)).json() as FixtureIds;
  const voice = selected.has("voice") ? await fakeVoice() : undefined;
  try {
    for (let repeat = 0; repeat < (selected.size === 1 && selected.has("first-run") ? 0 : samples); repeat++) {
      console.log(`Priority repetition ${repeat + 1}/${samples}`);
      await scenario();
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", permissions: ["clipboard-read", "clipboard-write", "microphone"] });
      try {
        const page = await context.newPage(); await install(page);
        await page.addInitScript(() => {
          const match = window.matchMedia.bind(window);
          window.threadMotionQueries = 0;
          window.matchMedia = query => {
            if (query === "(prefers-reduced-motion: reduce)") window.threadMotionQueries++;
            return match(query);
          };
          window.threadHeightReads = 0;
          const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
          const get = descriptor?.get;
          if (!get) throw new Error("Missing native scrollHeight getter");
          Object.defineProperty(Element.prototype, "scrollHeight", {
            ...descriptor,
            get: function(this: Element) {
              if (this.classList.contains("tl") && this.firstElementChild?.classList.contains("long")) window.threadHeightReads++;
              return get.call(this);
            },
          });
        });
        let historyRequests = 0;
        page.on("websocket", socket => socket.on("framesent", frame => {
          const request = JSON.parse(String(frame.payload)) as { method?: string };
          if (request.method === "threads.get") historyRequests++;
        }));
        const cdp = await context.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        if (process.env["GL_PERF_PROFILE"] === "1") {
          await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); profilers.set(page, cdp);
          await page.addInitScript(() => { (window as Window & { glRows?: { renders: Record<string, number> } }).glRows = { renders: {} }; });
          cdp.on("Network.webSocketFrameSent", event => { const request = JSON.parse(event.response.payloadData) as { method?: string }; if (request.method === "threads.get") console.log("History request"); });
        }
        await page.goto(appUrl());
        const cold = await page.evaluate(() => window.perfJourney.result); if (selected.has("startup")) add("cold-composer", cold.elapsed);
        await ready(page);

        if (selected.has("picker")) {
          await newThread(page);
          await page.locator("#ta").fill("Measure first picker opening");
          await page.locator("#ta").press("Enter");
          await expect(page.locator(".turn.a.done")).toHaveCount(1);
          await timing(page, "picker-open", () => page.locator("#modelBtn").click(), "click", "#picker.open");
          await expect(page.locator("#pkSearch")).toBeFocused();
          await expect(page.locator("#picker .fit-skel, #picker .pk-cost.skel")).toHaveCount(0);
          await page.keyboard.press("Escape");
        }

        if (selected.has("threads")) {
          for (const [count, clickId, hoverId, clickTitle, hoverTitle] of [
            [200, seed.long, seed.hoverLong, "Perf long 200", "Perf hover 200"],
            [2000, seed.thousands, seed.hoverThousands, "Perf thousands 2000", "Perf hover 2000"],
          ] as const) {
            for (const [pathName, id, title] of [["click", clickId, clickTitle], ["hover", hoverId, hoverTitle]] as const) {
              for (const warmth of ["cold", "warm"]) {
                await openShort(page, seed.short);
                const button = await row(page, id);
                if (pathName === "hover") { await button.hover(); await page.waitForTimeout(hoverDwellMs); }
                const action = `thread-${count}-${warmth}-${pathName}`;
                const requestsBeforeClick = historyRequests;
                const beforeClick = await page.evaluate(() => ({ motion: window.threadMotionQueries, height: window.threadHeightReads }));
                const observation = await timing(page, action, () => button.click(), "click", ".tl .turn:last-child .md", title, "text", { selector: "turn", text: String(count), mode: "class-count" });
                add(`${action}.history-requests`, historyRequests - requestsBeforeClick, "count");
                const afterClick = await page.evaluate(() => ({ motion: window.threadMotionQueries, height: window.threadHeightReads }));
                add(`${action}.motion-queries`, afterClick.motion - beforeClick.motion, "count");
                add(`${action}.height-reads`, afterClick.height - beforeClick.height, "count");
                smooth(action, observation);
                add(`${action}-mounted`, (await page.evaluate(() => window.perfJourney.later)).elapsed);
                await expect(page.locator(".tl .turn")).toHaveCount(count);
                await expect(page.locator(`.sb-row.on[data-thread="${id}"]`)).toBeVisible();
                await expect(page.locator(".tl .turn:last-child .md")).toContainText(title);
              }
            }
          }
          await openShort(page, seed.short);
          await timing(page, "open-huge-reply", async () => (await row(page, seed.huge)).click(), "click", ".turn.a.done .md", "Huge reply end");
          await expect(page.locator(".md tbody tr")).toHaveCount(300);
          console.log("Priority threads complete");
        }

        if (selected.has("clipboard")) {
          await (await row(page, seed.short)).click(); await expect(page.locator(".bubble")).toContainText("Short marker");
          const copy = page.locator(".turn.u [data-copy]"); await copy.scrollIntoViewIfNeeded(); await copy.hover();
          await timing(page, "copy-message", () => copy.click(), "click", '.turn.u [data-copy][data-tip="Copied"]');
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Short marker");
          await (await row(page, seed.huge)).click(); await expect(page.locator(".md pre")).toHaveCount(1);
          const code = page.getByRole("button", { name: "Copy code", exact: true }); await code.scrollIntoViewIfNeeded(); await code.hover();
          const codeText = await page.locator(".md pre code").textContent();
          await timing(page, "copy-code-4000", () => code.click(), "click", ".cb-copy", "Copied");
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codeText);
          await newThread(page);
          const text = "paste text line\n".repeat(3125);
          expect(text).toHaveLength(50_000);
          await page.evaluate(value => navigator.clipboard.writeText(value), text);
          const ta = page.locator("#ta"); await ta.focus(); const before = await ta.boundingBox();
          await ta.evaluate(el => {
            let inputs = 0;
            el.addEventListener("input", () => { inputs++; });
            el.addEventListener("paste", event => { el.dataset["trustedPaste"] = String(event.isTrusted); }, { once: true });
            Object.defineProperty(el, "pasteInputEvents", { get: () => inputs });
          });
          const pasted = await timing(page, "paste-text-50000", () => ta.press("Control+v"), "paste", "#ta", text, "usable-value"); smooth("paste-text-50000", pasted);
          add("paste-input-events", await ta.evaluate(el => Number(Reflect.get(el, "pasteInputEvents"))), "count");
          await expect(ta).toHaveValue(text); await expect(ta).toHaveAttribute("data-trusted-paste", "true"); expect((await ta.boundingBox())?.height).toBeGreaterThan(before?.height ?? 0);
          await timing(page, "type-after-paste", () => ta.press("x"), "keydown", "#ta", text + "x", "usable-value");
          await ta.fill("");
          console.log("Priority clipboard complete");
        }

        if (voice) {
          await newThread(page);
          await page.keyboard.press("Control+Comma");
          await page.getByRole("textbox", { name: "whisper.cpp address" }).fill(voice.url);
          await page.getByRole("button", { name: "Connect", exact: true }).click();
          await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible(); await page.keyboard.press("Escape");
          await timing(page, "voice-start-recording", () => page.getByRole("button", { name: "Dictate", exact: true }).click(), "click", ".voice.listening", "Listening");
          await expect(page.locator(".voice")).toContainText("1s");
          await timing(page, "voice-stop-to-transcript", () => page.getByRole("button", { name: "Stop dictation" }).click(), "click", "#ta", "spoken words", "value");
          await expect(page.locator("#ta")).toHaveValue("spoken words"); await page.locator("#ta").fill("");
          await page.getByRole("button", { name: "Dictate", exact: true }).click(); await expect(page.locator(".voice")).toContainText("1s");
          const held = voice.hold();
          const arrival = await measure(page, async () => {
            await page.getByRole("button", { name: "Stop dictation" }).click(); await held.arrived;
            await page.locator("#ta").press("x"); held.release();
          }, "click", "#ta", "x spoken words", "value");
          smooth("voice-arrival", arrival); add("voice-arrival-input-delay", arrival.inputDelays.at(-1)!);
          await expect(page.locator("#ta")).toHaveValue("x spoken words"); await page.locator("#ta").fill("");
          console.log("Priority voice complete");
        }

        if (selected.has("send")) {
          await newThread(page); await scenario(); await page.locator("#ta").fill("Measure first words");
          await timing(page, "send-first-visible-token", () => page.locator("#ta").press("Enter"), "keydown", ".turn.a:not(.done) .md", "Here is");
          await expect(page.locator(".turn.a.done")).toHaveCount(1);
        }

        if (selected.has("parallel")) {
          await scenario("threads", { tokenDelayMs: 24, burstTokens: 1, parallelLimit: 2 });
          const alphaPrompt = parallelPrompt("parallel alpha"), betaPrompt = parallelPrompt("parallel beta");
          await newThread(page); await send(page, alphaPrompt); const alpha = threadId(page);
          await newThread(page); await page.locator("#ta").fill(betaPrompt);
          await timing(page, "two-streams-start", () => page.locator("#ta").press("Enter"), "keydown", ".turn.a:not(.done) .md", "parallel beta"); const beta = threadId(page);
          for (const [id, marker, prompt] of [[alpha, "parallel alpha", alphaPrompt], [beta, "parallel beta", betaPrompt], [alpha, "parallel alpha", alphaPrompt], [beta, "parallel beta", betaPrompt]] as const) {
            await expect(page.locator('.sb [aria-label="Reply in progress"]')).toHaveCount(2);
            const state = await (await fetch(`${FAKE_URL}/__fake/state`)).json() as { turns: { prompt: string; tokens: number }[] };
            const emitted = state.turns.find(turn => turn.prompt === prompt)?.tokens;
            if (!emitted) throw new Error("Parallel reply has not emitted text");
            const current = (threadReply(prompt).match(/\s*\S+/g) ?? []).slice(0, emitted).join("").replace(/\s/g, "");
            const button = await row(page, id!);
            const o = await timing(page, "parallel-switch", () => button.click(), "click", ".turn.a:not(.done) .md", current, "compact-text"); smooth("parallel-switch", o);
            await expect(page.locator(".turn.u .bubble")).toContainText(marker!);
            await expect(page.locator(".turn.a:not(.done) .md")).toContainText(marker!);
            expect((await page.locator(".turn.a:not(.done) .md").textContent())?.replace(/\s/g, "")).toContain(current);
          }
          await stop(page); await (await row(page, alpha)).click(); await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible(); await stop(page);
          console.log("Priority parallel complete");
        }

        if (selected.has("queue")) {
          await scenario("slow-drip", { prompts: { "queue baseline reply": { holdAfterTokens: 46 } } }); await newThread(page); await send(page, "queue baseline reply");
          for (let i = 1; i <= 5; i++) {
            await page.locator("#ta").fill(`queued item ${i}`);
            const o = await timing(page, `queue-send-${i}`, () => page.locator("#ta").press("Enter"), "keydown", ".qt-r", String(i), "count");
            add("queue-send", o.elapsed); await expect(page.locator(".qt-r").nth(i - 1)).toContainText(`queued item ${i}`);
          }
          await timing(page, "queue-finish-to-next-token", async () => { const result = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST" }); if (!result.ok) throw new Error("Could not release fake reply"); }, "mutation:.turn.a.done", ".turn.a:not(.done) .md", "Here is");
          await expect(page.locator(".qt-r")).toHaveCount(0, { timeout: 15_000 });
          await expect(page.locator(".turn.a.done")).toHaveCount(6, { timeout: 15_000 });
          expect(await page.locator(".turn.u .bubble").allTextContents()).toEqual(["queue baseline reply", ...Array.from({ length: 5 }, (_, i) => `queued item ${i + 1}`)]);
          console.log("Priority queue complete");
        }

        if (selected.has("reconnect")) {
          await scenario("slow-drip", { longDrip: 1 }); await newThread(page); await send(page, "Reconnect while replying");
          const id = threadId(page);
          await timing(page, "reconnect-during-stream", () => page.evaluate(() => window.perfJourney.drop()), "now", ".composer:not(.blocked) #ta", "", "reconnect");
          expect(threadId(page)).toBe(id); await expect(page.locator(".turn.a .md")).toBeVisible();
          const socket = new URL(appUrl()).searchParams.get("server"); if (!socket) throw new Error("Missing fixture socket");
          const client = createClient(new WebSocket(socket));
          try {
            await expect.poll(async () => (await client.call("threads.get", { threadId: id })).messages.filter(m => m.role === "assistant").length, { timeout: 15_000 }).toBe(1);
            const saved = await client.call("threads.get", { threadId: id });
            expect(saved.messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["Reconnect while replying"]);
            expect(saved.messages.find(message => message.role === "assistant")?.content).toBe(STREAM_REPLY);
          }
          finally { client.close(); }
          console.log("Priority reconnect complete");
        }
      } finally { await context.close(); }
    }
  } finally { await voice?.close(); }
  const run: Run = {
    schema: 1, commit: process.env["GL_PERF_COMMIT"] ?? "working-tree", round: Number(process.env["GL_PERF_ROUND"] ?? 0), arm: process.env["GL_PERF_ARM"] === "candidate" ? "candidate" : "base", only,
    browser: browser.version(), machine: { cpus: availableParallelism(), memoryBytes: totalmem(), freeBytes: freemem(), loadBefore, loadAfter: loadavg() },
    fake: { firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 8, burstTokens: 8 }, concurrentParallelLimit: 2 },
    workload: { hoverDwellMs, pasteCharacters: 50_000, settleFrames: 2, parallelTokenDelayMs: 24, parallelBurstTokens: 1, clipboard: "native Chromium Clipboard API and trusted keyboard paste", voice: "recorded sine microphone, existing fake Whisper; held second arrival for input/frame observation" },
    metrics: [...values].map(([action, value]) => metric(action, value.unit, value.samples)),
  };
  const out = process.env["GL_PERF_OUT"] ?? "perf-results"; mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "run.json"), JSON.stringify(run, null, 2) + "\n", { flag: "wx" });
});

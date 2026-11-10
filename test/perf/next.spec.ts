/// <reference lib="dom" />
// The priority journeys, also recording what each action cost the browser.
//
// A run is timed repetitions, then three counter repetitions, then in the first
// round one profile repetition. Counting and profiling never share a
// repetition with timing. Input goes straight to the browser, because a
// locator click runs Playwright's own script in the page during the window.
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";
import { CONTROL_URL, FAKE_URL, appUrl } from "../e2e/env.ts";
import { browserReactHook, costRows, counterRows, emptyNetwork, frameBytes, hotSpots, snapshot, type HotSpot, type MetricSnapshot, type NetworkCounts, type ReactCounts, type Row } from "./counters.ts";
import type { FixtureIds } from "./fixture.ts";
import { install, measure, type LaterEnd, type Observation } from "./probe.ts";
import { COUNTER_REPETITIONS, NEXT_DEFAULT, nextJourneys, repetitionPlan } from "./next-journeys.ts";
import type { Journey } from "./selection.ts";
import { metric, type Run } from "./stats.ts";
import { fakeVoice } from "./voice-fixture.ts";
import { threadReply } from "../fake-ollama/fake-ollama.ts";
import { parallelPrompt } from "./workload.ts";

const only = nextJourneys(process.env["GL_PERF_ONLY"] ?? NEXT_DEFAULT);
const selected = new Set<Journey>(only);
const timedRepetitions = Number(process.env["GL_PERF_SAMPLES"] ?? 2);
const round = Number(process.env["GL_PERF_ROUND"] ?? 0);
const throttle = Number(process.env["GL_PERF_THROTTLE"] ?? 1);
const paste = process.env["GL_PERF_PASTE"] === "1";
const out = process.env["GL_PERF_OUT"] ?? "perf-results";
const hoverDwellMs = 350;
type Rows = Map<string, { unit: Row["unit"]; samples: number[] }>;
const timed: Rows = new Map(), counted: Rows = new Map();
const hot: Record<string, HotSpot[]> = {};

function add(rows: Rows, measured: Row) {
  const entry = rows.get(measured.action) ?? { unit: measured.unit, samples: [] };
  entry.samples.push(measured.value);
  rows.set(measured.action, entry);
}
function fixtureIds(value: unknown): FixtureIds {
  const read = (key: keyof FixtureIds): string => {
    const id: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
    if (typeof id !== "string" || id.length === 0) throw new Error(`The seed has no ${key} thread`);
    return id;
  };
  return { short: read("short"), long: read("long"), thousands: read("thousands"), huge: read("huge"), hoverLong: read("hoverLong"), hoverThousands: read("hoverThousands") };
}
function tokensFor(state: unknown, prompt: string): number {
  const turns: unknown = typeof state === "object" && state !== null ? Reflect.get(state, "turns") : undefined;
  if (!Array.isArray(turns)) throw new Error("Fake inference reported no turns");
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null || Reflect.get(turn, "prompt") !== prompt) continue;
    const tokens: unknown = Reflect.get(turn, "tokens");
    if (typeof tokens === "number" && tokens > 0) return tokens;
  }
  throw new Error("Parallel reply has not emitted text");
}
async function metrics(cdp: CDPSession): Promise<MetricSnapshot> {
  return snapshot((await cdp.send("Performance.getMetrics")).metrics);
}
async function quiet(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
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
async function point(locator: Locator) { const box = await locator.boundingBox(); if (!box) throw new Error("Target has no box"); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }

test("priority journeys with costs", async ({ browser }) => {
  const loadBefore = loadavg();
  const seed = fixtureIds(await (await fetch(`${CONTROL_URL}/seed`)).json());
  const voice = selected.has("voice") ? await fakeVoice() : undefined;
  const plan = repetitionPlan(timedRepetitions, round);
  try {
    for (const [repeat, kind] of plan.entries()) {
      console.log(`Repetition ${repeat + 1}/${plan.length} ${kind} ${new Date().toISOString()}`);
      await scenario();
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", permissions: ["clipboard-read", "clipboard-write", "microphone"] });
      try {
        if (kind === "counters") await context.addInitScript(browserReactHook);
        const page = await context.newPage(); await install(page);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
        let network: NetworkCounts = emptyNetwork();
        cdp.on("Network.requestWillBeSent", () => { network.requests++; });
        cdp.on("Network.loadingFinished", event => { network.bytes += event.encodedDataLength; });
        cdp.on("Network.webSocketFrameSent", event => { network.wsOut++; network.wsBytes += frameBytes(event.response.opcode, event.response.payloadData); });
        cdp.on("Network.webSocketFrameReceived", event => { network.wsIn++; network.wsBytes += frameBytes(event.response.opcode, event.response.payloadData); });
        if (kind === "profile") { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); }
        // A missing hook must fail the run: read as zero, it would look like an exact improvement.
        const reactCounts = async (): Promise<ReactCounts> => {
          const counts = await page.evaluate(() => window.perfReact ? { commits: window.perfReact.commits, renders: window.perfReact.renders } : null);
          if (!counts) throw new Error("The React counting hook is missing from the page, so React work cannot be counted");
          return counts;
        };
        let loaded = false;
        const begin = async () => {
          if (kind === "profile") { await cdp.send("Profiler.start"); return undefined; }
          network = emptyNetwork();
          // Before the first load nothing has rendered, and the page has no hook yet.
          return { metrics: await metrics(cdp), react: kind === "counters" && loaded ? await reactCounts() : { commits: 0, renders: 0 } };
        };
        const finish = async (name: string, before: Awaited<ReturnType<typeof begin>>, elapsed: number) => {
          if (kind === "profile") {
            const { profile } = await cdp.send("Profiler.stop");
            mkdirSync(path.join(out, "profiles"), { recursive: true });
            writeFileSync(path.join(out, "profiles", `${name}.cpuprofile`), JSON.stringify(profile));
            hot[name] = hotSpots(profile);
            return;
          }
          if (!before) throw new Error("Measurement window never began");
          const after = await metrics(cdp);
          if (kind === "timed") {
            add(timed, { action: name, unit: "ms", value: elapsed });
            for (const cost of costRows(name, before.metrics, after)) add(timed, cost);
            return;
          }
          const elements = await page.evaluate(() => document.getElementsByTagName("*").length);
          for (const count of counterRows(name, { before: before.react, after: await reactCounts() }, network, elements)) add(counted, count);
        };
        // A later end gives a second row from the same input and the same opening reading.
        // The profile covers the first window only, but its later window must still close
        // before the next action arms the probe.
        const timing = async (name: string, trigger: () => Promise<unknown>, event: string, selector: string, text = "", mode = "text", later?: { name: string } & LaterEnd): Promise<Observation> => {
          await quiet(page);
          const before = await begin();
          const observation = await measure(page, trigger, event, selector, text, mode, later);
          await finish(name, before, observation.elapsed);
          if (later) {
            const closed = await page.evaluate(() => window.perfJourney.later);
            if (kind !== "profile") await finish(later.name, before, closed.elapsed);
          }
          return observation;
        };
        const clicking = async (locator: Locator) => { const { x, y } = await point(locator); return () => page.mouse.click(x, y); };

        const beforeLoad = await begin();
        await page.goto(appUrl());
        const cold = await page.evaluate(() => window.perfJourney.result);
        await ready(page);
        loaded = true;
        if (kind === "counters" && (await reactCounts()).commits < 1) throw new Error("React committed nothing during the first load, so the counting hook was installed too late");
        if (selected.has("startup")) await finish("cold-composer", beforeLoad, cold.elapsed);
        else if (kind === "profile") await cdp.send("Profiler.stop");

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
                const name = `thread-${count}-${warmth}-${pathName}`;
                await timing(name, await clicking(button), "click", ".tl .turn:last-child .md", title, "text", { name: `${name}-mounted`, selector: "turn", text: String(count), mode: "class-count" });
                await expect(page.locator(".tl .turn")).toHaveCount(count);
                await expect(page.locator(`.sb-row.on[data-thread="${id}"]`)).toBeVisible();
              }
            }
          }
          // One keystroke with the last 2000-turn visit open and every turn mounted.
          await expect(page.locator(".tl .turn")).toHaveCount(2000); await ready(page);
          const composer = page.locator("#ta"); await composer.focus();
          await timing("type-in-thread-2000", () => page.keyboard.press("x"), "keydown", "#ta", "x", "usable-value");
          await expect(composer).toHaveValue("x"); await composer.fill("");
          await openShort(page, seed.short);
          await timing("open-huge-reply", await clicking(await row(page, seed.huge)), "click", ".turn.a.done .md", "Huge reply end");
          await expect(page.locator(".md tbody tr")).toHaveCount(300);
        }

        if (selected.has("clipboard")) {
          await openShort(page, seed.short);
          const copy = page.locator(".turn.u [data-copy]"); await copy.scrollIntoViewIfNeeded(); await copy.hover();
          await timing("copy-message", await clicking(copy), "click", '.turn.u [data-copy][data-tip="Copied"]');
          await (await row(page, seed.huge)).click(); await expect(page.locator(".md pre")).toHaveCount(1);
          const code = page.getByRole("button", { name: "Copy code", exact: true }); await code.scrollIntoViewIfNeeded(); await code.hover();
          await timing("copy-code-4000", await clicking(code), "click", ".cb-copy", "Copied");
          await newThread(page);
          if (paste) {
            const text = "paste text line\n".repeat(3125);
            await page.evaluate(value => navigator.clipboard.writeText(value), text);
            const ta = page.locator("#ta"); await ta.focus();
            await timing("paste-text-50000", () => page.keyboard.press("Control+v"), "paste", "#ta", text, "usable-value");
            await expect(ta).toHaveValue(text);
            await timing("type-after-paste", () => page.keyboard.press("x"), "keydown", "#ta", text + "x", "usable-value");
            await ta.fill("");
          }
        }

        if (voice) {
          await newThread(page);
          await page.keyboard.press("Control+Comma");
          await page.getByRole("textbox", { name: "whisper.cpp address" }).fill(voice.url);
          await page.getByRole("button", { name: "Connect", exact: true }).click();
          await expect(page.getByText("Connected for dictation.", { exact: false })).toBeVisible(); await page.keyboard.press("Escape");
          await timing("voice-start-recording", await clicking(page.getByRole("button", { name: "Dictate", exact: true })), "click", ".voice.listening", "Listening");
          await expect(page.locator(".voice")).toContainText("1s");
          await timing("voice-stop-to-transcript", await clicking(page.getByRole("button", { name: "Stop dictation" })), "click", "#ta", "spoken words", "value");
          await expect(page.locator("#ta")).toHaveValue("spoken words"); await page.locator("#ta").fill("");
        }

        if (selected.has("send")) {
          await newThread(page); await scenario(); await page.locator("#ta").fill("Measure first words");
          await timing("send-first-visible-token", () => page.keyboard.press("Enter"), "keydown", ".turn.a:not(.done) .md", "Here is");
          await expect(page.locator(".turn.a.done")).toHaveCount(1);
        }

        if (selected.has("parallel")) {
          await scenario("threads", { tokenDelayMs: 24, burstTokens: 1, parallelLimit: 2 });
          const alphaPrompt = parallelPrompt("parallel alpha"), betaPrompt = parallelPrompt("parallel beta");
          await newThread(page); await send(page, alphaPrompt); const alpha = threadId(page);
          await newThread(page); await page.locator("#ta").fill(betaPrompt);
          await timing("two-streams-start", () => page.keyboard.press("Enter"), "keydown", ".turn.a:not(.done) .md", "parallel beta"); const beta = threadId(page);
          for (const [id, prompt] of [[alpha, alphaPrompt], [beta, betaPrompt], [alpha, alphaPrompt], [beta, betaPrompt]] as const) {
            await expect(page.locator('.sb [aria-label="Reply in progress"]')).toHaveCount(2);
            const emitted = tokensFor(await (await fetch(`${FAKE_URL}/__fake/state`)).json(), prompt);
            const current = (threadReply(prompt).match(/\s*\S+/g) ?? []).slice(0, emitted).join("").replace(/\s/g, "");
            await timing("parallel-switch", await clicking(await row(page, id)), "click", ".turn.a:not(.done) .md", current, "compact-text");
          }
          await stop(page); await (await row(page, alpha)).click(); await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible(); await stop(page);
        }

        if (selected.has("queue")) {
          await scenario("slow-drip", { prompts: { "queue baseline reply": { holdAfterTokens: 46 } } }); await newThread(page); await send(page, "queue baseline reply");
          for (let i = 1; i <= 5; i++) {
            await page.locator("#ta").fill(`queued item ${i}`);
            await timing(`queue-send-${i}`, () => page.keyboard.press("Enter"), "keydown", ".qt-r", String(i), "count");
          }
          await timing("queue-finish-to-next-token", async () => { const result = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST" }); if (!result.ok) throw new Error("Could not release fake reply"); }, "mutation:.turn.a.done", ".turn.a:not(.done) .md", "Here is");
          await expect(page.locator(".qt-r")).toHaveCount(0, { timeout: 15_000 });
          await expect(page.locator(".turn.a.done")).toHaveCount(6, { timeout: 15_000 });
        }

        if (selected.has("reconnect")) {
          await scenario("slow-drip", { longDrip: 1 }); await newThread(page); await send(page, "Reconnect while replying");
          await timing("reconnect-during-stream", () => page.evaluate(() => window.perfJourney.drop()), "now", ".composer:not(.blocked) #ta", "", "reconnect");
          await expect(page.locator(".turn.a .md")).toBeVisible();
          // The reply can end before this point; an unbounded click would wait out the test.
          await page.getByRole("button", { name: "Stop", exact: true }).click({ timeout: 2_000 }).catch(() => undefined);
        }
      } finally { await context.close(); }
    }
  } finally { await voice?.close(); }
  const record = (rows: Rows, repetitions: number): Run & { repetitions: number; throttle: number } => ({
    schema: 1, commit: process.env["GL_PERF_COMMIT"] ?? "working-tree", round, arm: process.env["GL_PERF_ARM"] === "candidate" ? "candidate" : "base", only, repetitions, throttle,
    browser: browser.version(), machine: { cpus: availableParallelism(), memoryBytes: totalmem(), freeBytes: freemem(), loadBefore, loadAfter: loadavg() },
    fake: { firstTokenDelayMs: 40, tokenDelayMs: 8, burstTokens: 8, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 8, burstTokens: 8 }, concurrentParallelLimit: 2 },
    metrics: [...rows].map(([action, entry]) => metric(action, entry.unit, entry.samples)),
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "run.json"), JSON.stringify(record(timed, timedRepetitions), null, 2) + "\n", { flag: "wx" });
  writeFileSync(path.join(out, "counters.json"), JSON.stringify(record(counted, COUNTER_REPETITIONS), null, 2) + "\n", { flag: "wx" });
  if (Object.keys(hot).length) writeFileSync(path.join(out, "profiles", "hot-spots.json"), JSON.stringify(hot, null, 2) + "\n", { flag: "wx" });
});

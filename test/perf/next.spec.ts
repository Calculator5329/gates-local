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
import { test, expect, type Browser, type CDPSession, type Locator, type Page } from "@playwright/test";
import { decodeRequest } from "@gates-local/contracts";
import { CONTROL_URL, FAKE_URL, appUrl } from "../e2e/env.ts";
import { browserReactHook, costRows, counterRows, emptyNetwork, frameBytes, hotSpots, snapshot, type HotSpot, type MetricSnapshot, type NetworkCounts, type ReactCounts, type Row } from "./counters.ts";
import type { FixtureIds } from "./fixture.ts";
import { install, measure, type LaterEnd, type Observation } from "./probe.ts";
import { COUNTER_REPETITIONS, NEXT_DEFAULT, nextJourneys, repetitionPlan, type RepetitionKind } from "./next-journeys.ts";
import type { Journey } from "./selection.ts";
import { metric, type Run } from "./stats.ts";
import { fakeVoice } from "./voice-fixture.ts";
import { threadReply } from "../fake-ollama/fake-ollama.ts";
import { parallelPrompt } from "./workload.ts";
import { browserBusyStart, browserBusyStop, browserLongTasks, browserRegionHook, longSince, type RegionCounts } from "./typing.ts";

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

/** How long a hand rests on the model button between arriving and clicking, or a keyboard user between focus and Enter. */
const handDwellMs = 150;

/**
 * After a completed reply every fit report is stale, so these sessions open
 * the picker the way people do: a hand that arrives and clicks about 150 ms
 * later, or keyboard focus and then Enter. `hover-away` hovers and leaves
 * without opening: the one warm-up whose checks no opening uses.
 */
export async function pickerReplyCase(browser: Browser, kind: RepetitionKind, mode: "hand" | "keyboard" | "hover-away") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  try {
    const page = await context.newPage(); await install(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    let checks = 0;
    cdp.on("Network.webSocketFrameSent", event => {
      const request = decodeRequest(event.response.payloadData);
      if (request.ok && request.value.method.startsWith("fit.")) checks++;
    });
    await page.goto(appUrl()); await page.evaluate(() => window.perfJourney.result); await ready(page);
    await page.locator("#ta").fill("Measure first picker opening");
    await page.locator("#ta").press("Enter");
    await expect(page.locator(".turn.a.done")).toHaveCount(1);
    await quiet(page);
    const button = page.locator("#modelBtn"), name = `picker-open-${mode}`;
    if (mode === "hover-away") {
      await button.hover(); await page.waitForTimeout(hoverDwellMs);
      const away = await point(page.locator("#ta")); await page.mouse.move(away.x, away.y);
      // Let every warm-up answer arrive before counting.
      await page.waitForTimeout(hoverDwellMs); await quiet(page);
      expect(await page.locator("#picker").count(), "hovering must not mount the picker").toBe(0);
      if (kind === "counters") add(counted, { action: `${name}.session-fit-checks`, unit: "count", value: checks });
      return;
    }
    let observation: Observation;
    if (mode === "hand") {
      const { x, y } = await point(button);
      await page.mouse.move(x, y); await page.waitForTimeout(handDwellMs);
      observation = await measure(page, () => page.mouse.click(x, y), "click", "#picker.open");
    } else {
      await button.focus();
      // Only focus with a focus ring warms; without one this row would be a cold open.
      expect(await button.evaluate(b => b.matches(":focus-visible")), "script focus after typing counts as keyboard focus").toBe(true);
      await page.waitForTimeout(handDwellMs);
      observation = await measure(page, () => page.keyboard.press("Enter"), "keydown", "#picker.open");
    }
    if (kind === "timed") add(timed, { action: name, unit: "ms", value: observation.elapsed });
    await expect(page.locator("#pkSearch")).toBeFocused();
    await expect(page.locator("#picker .fit-skel, #picker .pk-cost.skel")).toHaveCount(0);
    await quiet(page);
    if (kind === "counters") add(counted, { action: `${name}.session-fit-checks`, unit: "count", value: checks });
  } finally { await context.close(); }
}

/** Each case owns a fresh client session; none warms the next case's fit cache. */
export async function pickerReadyCase(browser: Browser, kind: RepetitionKind, mode: "hover" | "cold-ready") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  try {
    const page = await context.newPage(); await install(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    let checks = 0;
    cdp.on("Network.webSocketFrameSent", event => {
      const request = decodeRequest(event.response.payloadData);
      if (request.ok && request.value.method.startsWith("fit.")) checks++;
    });
    await page.goto(appUrl()); await page.evaluate(() => window.perfJourney.result); await ready(page);
    const button = page.locator("#modelBtn");
    if (mode === "hover") { await button.hover(); await page.waitForTimeout(350); }
    const location = await point(button);
    const name = `picker-open-${mode}`;
    const observation = await measure(page, () => page.mouse.click(location.x, location.y), "click", "#picker.open");
    if (kind === "timed") add(timed, { action: name, unit: "ms", value: observation.elapsed });
    await expect(page.locator("#picker .fit-skel, #picker .pk-cost.skel")).toHaveCount(0);
    const first = checks;
    // A session includes repeated pointer/focus intent and a second opening.
    // This must not multiply answers which are current or already in flight.
    await page.keyboard.press("Escape"); await page.locator("#ta").focus();
    await button.hover(); await button.focus(); await button.click();
    await expect(page.locator("#pkSearch")).toBeFocused(); await quiet(page);
    expect(checks, "repeated intent must reuse the same session's checks").toBe(first);
    if (kind === "counters") add(counted, { action: `${name}.session-fit-checks`, unit: "count", value: checks });
  } finally { await context.close(); }
}

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
        if (kind === "counters" && selected.has("typing")) await context.addInitScript(browserRegionHook);
        if (selected.has("typing")) await context.addInitScript(browserLongTasks);
        const page = await context.newPage(); await install(page);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
        let network: NetworkCounts = emptyNetwork();
        let sessionFitChecks = 0;
        cdp.on("Network.requestWillBeSent", () => { network.requests++; });
        cdp.on("Network.loadingFinished", event => { network.bytes += event.encodedDataLength; });
        cdp.on("Network.webSocketFrameSent", event => {
          network.wsOut++; network.wsBytes += frameBytes(event.response.opcode, event.response.payloadData);
          const request = decodeRequest(event.response.payloadData);
          if (request.ok && request.value.method.startsWith("fit.")) sessionFitChecks++;
        });
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

        if (selected.has("picker")) {
          // Match the broad journey: open after a completed reply, without
          // visiting the picker or settings first to warm their fit checks.
          await newThread(page);
          await page.locator("#ta").fill("Measure first picker opening");
          await page.locator("#ta").press("Enter");
          await expect(page.locator(".turn.a.done")).toHaveCount(1);
          await timing("picker-open", await clicking(page.locator("#modelBtn")), "click", "#picker.open");
          await expect(page.locator("#pkSearch")).toBeFocused();
          await expect(page.locator("#picker .fit-skel, #picker .pk-cost.skel")).toHaveCount(0);
          if (kind === "counters") add(counted, { action: "picker-open.session-fit-checks", unit: "count", value: sessionFitChecks });
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

        if (selected.has("typing")) {
          // Typing the next message while a reply streams, in a new chat and in a
          // thread of 400 messages. Each key is its own window. The states: idle;
          // held, a reply running but quiet; stream, chunks arriving about every
          // 24 ms; busy, the stream plus back-to-back 100 ms tasks.
          const seeded: unknown = await (await fetch(`${CONTROL_URL}/seed`)).json();
          const typingId: unknown = typeof seeded === "object" && seeded !== null ? Reflect.get(seeded, "typing") : undefined;
          if (typeof typingId !== "string" || !typingId) throw new Error("The seed has no typing thread");
          const ta = page.locator("#ta");
          // Six keys a state keeps four rounds of both arms inside one runner job.
          const KEYS = "steady", BUSY_KEYS = "busy", HOLD_TOKENS = 24, CHUNK_WINDOW_MS = 600;
          const regions = async (): Promise<RegionCounts> => {
            const counts = await page.evaluate(() => window.perfRegions ? { ...window.perfRegions, where: { ...window.perfRegions.where } } : null);
            if (!counts) throw new Error("The region hook is missing from the page, so renders cannot be placed");
            return counts;
          };
          // A missing counter must fail the run: read as zero it would look like an exact improvement.
          const flushes = async () => {
            const count = await page.evaluate(() => (window as unknown as { glPerf?: { flushes: number } }).glPerf?.flushes);
            if (count === undefined) throw new Error("The client's flush counter is missing");
            return count;
          };
          const regionRows = (name: string, before: RegionCounts, after: RegionCounts) => {
            for (const region of ["composer", "live", "elsewhere"] as const) add(counted, { action: `${name}.renders-${region}`, unit: "count", value: after[region] - before[region] });
            const where = Object.entries(after.where).map(([label, n]) => [label, n - (before.where[label] ?? 0)] as const).filter(([, n]) => n > 0);
            if (where.some(([label]) => label !== "composer textarea#ta.ta" && !label.startsWith("began textarea#ta.ta "))) console.log(`${name} renders outside the live reply: ${where.map(([label, n]) => `${label} x${n}`).join(", ")}`);
          };
          const profiled = async (name: string, act: () => Promise<unknown>) => {
            await cdp.send("Profiler.start");
            await act();
            const { profile } = await cdp.send("Profiler.stop");
            mkdirSync(path.join(out, "profiles"), { recursive: true });
            writeFileSync(path.join(out, "profiles", `${name}.cpuprofile`), JSON.stringify(profile));
            hot[name] = hotSpots(profile);
          };
          /** One window per key, each closing when the typed text is in the field and painted; the profile covers the whole burst. */
          const typeKeys = async (name: string, text: string) => {
            await ta.fill(""); await ta.focus();
            if (kind === "profile") await profiled(name, async () => { for (const ch of text) await page.keyboard.press(ch); await expect(ta).toHaveValue(text); });
            else {
              let value = "";
              for (const ch of text) {
                value += ch;
                await quiet(page);
                const before = await begin();
                const placed = kind === "counters" ? await regions() : undefined;
                const observation = await measure(page, () => page.keyboard.press(ch), "keydown", "#ta", value, "usable-value");
                if (placed) regionRows(name, placed, await regions());
                await finish(name, before, observation.elapsed);
                if (kind === "timed") add(timed, { action: `${name}.long-tasks`, unit: "count", value: observation.longTasks.length });
              }
            }
            await expect(ta).toHaveValue(text); await ta.fill("");
          };
          /** No key in the window: what the streamed chunks alone render. Its time row is the window's fixed length. */
          const chunkWindow = async (name: string) => {
            if (kind === "profile") { await profiled(name, () => page.waitForTimeout(CHUNK_WINDOW_MS)); return; }
            await quiet(page);
            const before = await begin();
            const placed = kind === "counters" ? await regions() : undefined;
            const from = await flushes();
            await page.waitForTimeout(CHUNK_WINDOW_MS);
            const flushed = await flushes() - from;
            if (placed) regionRows(name, placed, await regions());
            await finish(name, before, CHUNK_WINDOW_MS);
            add(kind === "timed" ? timed : counted, { action: `${name}.flushes`, unit: "count", value: flushed });
          };
          const emitted = async (prompt: string) => { try { return tokensFor(await (await fetch(`${FAKE_URL}/__fake/state`)).json(), prompt); } catch { return 0; } };
          const typeDuringReply = async (label: string, prompt: string) => {
            // Earlier repetitions left interrupted replies in the 400-message thread; only the live one counts.
            await ta.fill(prompt); await ta.press("Enter"); await expect(page.locator(".md.live")).toBeVisible();
            await expect.poll(() => emitted(prompt)).toBe(HOLD_TOKENS);
            const shown = (threadReply(prompt).match(/\s*\S+/g) ?? []).slice(0, HOLD_TOKENS).join("").replace(/\s/g, "");
            await expect.poll(async () => ((await page.locator(".md.live").textContent()) ?? "").replace(/\s/g, "")).toContain(shown);
            await quiet(page);
            await typeKeys(`typing-${label}-held`, KEYS);
            const released = await fetch(`${FAKE_URL}/__fake/release`, { method: "POST" });
            if (!released.ok) throw new Error("Could not release fake reply");
            await expect.poll(() => emitted(prompt)).toBeGreaterThan(HOLD_TOKENS + 4);
            await chunkWindow(`chunks-${label}`);
            await typeKeys(`typing-${label}-stream`, KEYS);
            await page.evaluate(browserBusyStart);
            try { await typeKeys(`typing-${label}-busy`, BUSY_KEYS); } finally { await page.evaluate(browserBusyStop); }
            // Every state after the hold ran with the reply still streaming.
            expect(await page.locator(".md.live").count(), "the reply ended before the typing did").toBe(1);
            await stop(page);
          };

          await scenario("threads", { tokenDelayMs: 24, burstTokens: 1, holdAfterTokens: HOLD_TOKENS });
          await newThread(page);
          await typeKeys("typing-short-idle", KEYS);
          await typeDuringReply("short", parallelPrompt("typing short"));

          // The 400-message thread opened from a fresh load, as the release check opens it,
          // then scrolled top, middle and end. Earlier repetitions each added a turn pair.
          const turns = page.locator(".tl .turn");
          // A hash-only change would keep the document, its long tasks and its busy spins.
          await page.goto("about:blank");
          const openLong = async () => {
            await page.goto(appUrl(`#thread=${typingId}`));
            await ready(page);
            await expect.poll(() => turns.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(400);
            let count = -1;
            await expect.poll(async () => { const previous = count; count = await turns.count(); return count === previous; }, { intervals: [300] }).toBe(true);
          };
          const scrollLong = async () => {
            const tl = page.locator(".tl");
            await tl.evaluate(el => el.scrollTo({ top: 0 })); await page.waitForTimeout(200);
            await tl.evaluate(el => el.scrollTo({ top: el.scrollHeight / 2 })); await page.waitForTimeout(200);
            await tl.evaluate(el => el.scrollTo({ top: el.scrollHeight })); await page.waitForTimeout(300);
          };
          const longTasks = () => page.evaluate(() => window.perfLong ?? []);
          if (kind === "profile") { await profiled("open-400", openLong); await profiled("scroll-400", scrollLong); }
          else {
            await openLong();
            const opened = await longTasks(), scrollFrom = await page.evaluate(() => performance.now());
            await scrollLong();
            const scrolled = longSince(await longTasks(), scrollFrom), open = longSince(opened, 0);
            if (kind === "timed") {
              add(timed, { action: "open-400.long-tasks", unit: "count", value: open.count });
              add(timed, { action: "open-400.longest-task", unit: "ms", value: open.longest });
              add(timed, { action: "scroll-400.long-tasks", unit: "count", value: scrolled.count });
              add(timed, { action: "scroll-400.longest-task", unit: "ms", value: scrolled.longest });
            }
            console.log(`open-400 ${kind}: long tasks ${opened.map(task => `${Math.round(task.duration)} ms at ${Math.round(task.start)}`).join(", ") || "none"}; scroll ${scrolled.count}, longest ${Math.round(scrolled.longest)} ms`);
          }
          await typeKeys("typing-400-idle", KEYS);
          await typeDuringReply("400", parallelPrompt("typing 400"));
        }
      } finally { await context.close(); }
      // The fresh picker sessions record no profile; hover-away records only a count.
      if (selected.has("picker") && kind !== "profile") {
        for (const mode of ["hover", "cold-ready"] as const) await pickerReadyCase(browser, kind, mode);
        for (const mode of ["hand", "keyboard", "hover-away"] as const) {
          if (mode !== "hover-away" || kind === "counters") await pickerReplyCase(browser, kind, mode);
        }
      }
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

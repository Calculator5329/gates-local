/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { CONTROL_URL, FAKE_URL, appUrl } from "../e2e/env.ts";
import { install, measure, type Observation } from "./probe.ts";
import { metric, quantile, type Run } from "./stats.ts";

const samples = Number(process.env["GL_PERF_SAMPLES"] ?? 3);
const firstTokenDelayMs = 40;
const tokenDelayMs = 8;
const burstTokens = 8;
const values = new Map<string, { unit: "ms" | "count"; samples: number[] }>();
function add(action: string, value: number, unit: "ms" | "count" = "ms") {
  const row = values.get(action) ?? { unit, samples: [] };
  row.samples.push(value); values.set(action, row);
}
function latency(action: string, observation: Observation) { add(action, observation.elapsed); }
function smoothness(action: string, observation: Observation) {
  add(`${action}.frame-p95`, quantile(observation.frames, 0.95));
  add(`${action}.frame-max`, Math.max(...observation.frames));
  add(`${action}.long-tasks`, observation.longTasks.length, "count");
  add(`${action}.long-task-time`, observation.longTasks.reduce((a, b) => a + b, 0));
}
async function scenario(options: Record<string, number> = {}) {
  const response = await fetch(`${FAKE_URL}/__fake/scenario`, { method: "POST", body: JSON.stringify({ scenario: "slow-drip", firstTokenDelayMs, tokenDelayMs, burstTokens, loadDelayMs: 0, ...options }) });
  if (!response.ok) throw new Error("Could not configure fake");
}
async function ready(page: Page) {
  await expect(page.locator(".composer:not(.blocked) #ta")).toBeEnabled();
}
async function newThread(page: Page) {
  await page.keyboard.press("Control+n");
  await expect(page.locator(".turn")).toHaveCount(0);
  await ready(page);
}
async function send(page: Page, prompt: string) {
  await page.locator("#ta").fill(prompt);
  await page.locator("#ta").press("Enter");
  await expect(page.locator(".turn.a:not(.done) .md")).toBeVisible();
}
async function stop(page: Page) {
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}
async function select(page: Page, title: string) {
  const row = page.locator(".sb-row").filter({ hasText: title }).locator(".sb-thread");
  // Scroll/actionability is setup, deliberately excluded from click-to-paint.
  await row.scrollIntoViewIfNeeded();
  return row;
}

test("production browser journeys", async ({ browser }) => {
  const loadBefore = loadavg();
  const seedResponse = await fetch(`${CONTROL_URL}/seed`);
  const seed = await seedResponse.json() as { short: string; long: string; thousands: string; huge: string };
  for (let repeat = 0; repeat < samples; repeat++) {
    console.log(`Journey repetition ${repeat + 1}/${samples}`);
    await scenario();
    // A new context drops HTTP caches, storage and connections. The fixture server is warm.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const page = await context.newPage();
    await install(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await page.goto(appUrl());
    latency("cold-composer", await page.evaluate(() => window.perfJourney.result));
    await expect(page.locator(".sb-row")).toHaveCount(400 + repeat * 5);
    // Measure rendering/filtering a populated sidebar, then clear search.
    await page.keyboard.press("Control+k");
    await page.locator("#searchIn").focus();
    latency("sidebar-search-400", await measure(page, () => page.locator("#searchIn").fill("Perf sidebar 399"), "input", ".sb-row", "", "absent"));
    latency("sidebar-restore-400", await measure(page, () => page.locator("#searchIn").fill(""), "input", ".sb-row", String(400 + repeat * 5), "count"));
    await page.keyboard.press("Escape");

    const row = await select(page, "Perf short");
    latency("switch-thread", await measure(page, () => row.click(), "click", ".bubble", "Short marker"));
    const longRow = await select(page, "Perf long 200");
    latency("open-thread-200", await measure(page, () => longRow.click(), "click", ".tl .turn", "200", "count"));
    const thousands = await select(page, "Perf thousands 2000");
    latency("open-thread-2000", await measure(page, () => thousands.click(), "click", ".tl .turn", "2000", "count"));
    const huge = await select(page, "Perf huge reply");
    latency("open-huge-reply", await measure(page, () => huge.click(), "click", ".turn.a.done .md", "Huge reply end"));
    await expect(page.locator(".md pre")).toHaveCount(1);
    await expect(page.locator(".md tbody tr")).toHaveCount(300);

    latency("new-thread", await measure(page, () => page.keyboard.press("Control+n"), "keydown", ".turn", "", "absent"));
    await ready(page);
    for (const char of "typing") {
      const before = await page.locator("#ta").inputValue();
      const observation = await measure(page, () => page.locator("#ta").press(char), "keydown", "#ta", before + char, "value");
      latency("composer-type", observation);
      add("composer-input-delay", observation.inputDelays[0]!);
    }
    await page.locator("#ta").fill("Measure first visible text");
    latency("send-first-visible-token", await measure(page, () => page.locator("#ta").press("Enter"), "keydown", ".turn.a:not(.done) .md", "Here is"));
    const streaming = await measure(page, async () => {}, "now", ".turn.a.done .md", "Keep some room");
    latency("mixed-stream-complete", streaming);
    smoothness("mixed-stream", streaming);

    latency("picker-open", await measure(page, () => page.locator("#modelBtn").click(), "click", "#picker.open"));
    latency("picker-search", await measure(page, () => page.locator("#pkSearch").fill("gemma"), "input", "#picker .pk-r", "1", "count"));
    latency("picker-select", await measure(page, () => page.locator('#picker .pk-r[data-m="gemma4:12b"]').click(), "click", "#modelBtn", "Gemma"));
    await page.locator("#modelBtn").click();
    await page.locator("#pkSearch").fill("qwen");
    await page.locator('#picker .pk-r[data-m="qwen3.5:9b"]').click();

    latency("settings-open", await measure(page, () => page.keyboard.press("Control+Comma"), "keydown", ".set h1", "General"));
    for (const label of ["Models", "Instructions", "Library", "Tools", "Image generation", "Runtime", "Advanced", "Shortcuts", "General"]) {
      latency(`settings-${label.toLowerCase().replaceAll(" ", "-")}`, await measure(page, () => page.locator(".snav").getByRole("button", { name: label, exact: true }).click(), "click", ".set h1", label));
    }
    await page.keyboard.press("Escape");

    await scenario({ longDrip: 1, tokenDelayMs: 12, burstTokens: 4 });
    await newThread(page);
    await send(page, "Typing while a mixed reply streams");
    for (const char of "draft") {
      const before = await page.locator("#ta").inputValue();
      await expect(page.locator(".turn.a:not(.done) .md")).toBeVisible();
      const observation = await measure(page, () => page.locator("#ta").press(char), "keydown", "#ta", before + char, "value");
      latency("type-during-stream", observation);
      add("stream-input-delay", observation.inputDelays[0]!);
    }
    latency("stop", await measure(page, () => page.getByRole("button", { name: "Stop", exact: true }).click(), "click", ".stopped", "Stopped"));

    // Same model/context permits two real server turns at once. Both must visibly start.
    await scenario({ longDrip: 1, tokenDelayMs: 12, burstTokens: 4, parallelLimit: 2 });
    await newThread(page);
    await send(page, "First concurrent reply");
    const firstId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
    await newThread(page);
    await page.locator("#ta").fill("Second concurrent reply");
    latency("two-streams-start", await measure(page, () => page.locator("#ta").press("Enter"), "keydown", ".turn.a:not(.done) .md", "", "text"));
    await expect(page.locator(".turn.a:not(.done) .md")).toBeVisible();
    const secondId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
    await expect(page.locator('.sb [aria-label="Reply in progress"]')).toHaveCount(2);
    const two = await measure(page, async () => {}, "now", '.sb [aria-label="Reply in progress"]', "2", "less-than");
    smoothness("two-streams", two);
    if (await page.getByRole("button", { name: "Stop", exact: true }).count()) await stop(page);
    // Navigate back and stop only if the first turn is still running.
    await page.goto(appUrl(`#thread=${firstId ?? seed.short}`));
    await ready(page);
    if (await page.getByRole("button", { name: "Stop", exact: true }).count()) await stop(page);

    await scenario({ longDrip: 1, tokenDelayMs: 12, burstTokens: 4 });
    await newThread(page);
    await send(page, "Reconnect during this reply");
    const reconnectId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread");
    const reconnect = await measure(page, () => page.evaluate(() => window.perfJourney.drop()), "now", ".composer:not(.blocked) #ta", "", "reconnect");
    latency("reconnect-during-stream", reconnect);
    expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("thread")).toBe(reconnectId);
    await expect(page.locator(".turn.a .md")).toBeVisible();
    // The subject may resume the live reply or show its interrupted snapshot.
    // In either case the same thread must finish saving before the next repeat.
    const socketUrl = new URL(appUrl()).searchParams.get("server");
    if (!socketUrl || !reconnectId) throw new Error("Missing fixture connection");
    const client = createClient(new WebSocket(socketUrl));
    try {
      await expect.poll(async () => (await client.call("threads.get", { threadId: reconnectId })).messages.filter(m => m.role === "assistant").length, { timeout: 15_000 }).toBe(1);
    } finally { client.close(); }
    expect(firstId).toBeTruthy(); expect(secondId).toBeTruthy(); expect(secondId).not.toBe(firstId);
    await context.close();
  }
  const run: Run = {
    schema: 1, commit: process.env["GL_PERF_COMMIT"] ?? "working-tree", round: Number(process.env["GL_PERF_ROUND"] ?? 0), arm: process.env["GL_PERF_ARM"] === "candidate" ? "candidate" : "base",
    browser: browser.version(),
    machine: { cpus: availableParallelism(), memoryBytes: totalmem(), freeBytes: freemem(), loadBefore, loadAfter: loadavg() },
    fake: { firstTokenDelayMs, tokenDelayMs, burstTokens, thinking: false, loadDelayMs: 0, longMarkdown: { tokenDelayMs: 12, burstTokens: 4 }, concurrentParallelLimit: 2 },
    metrics: [...values].map(([action, row]) => metric(action, row.unit, row.samples)),
  };
  const out = process.env["GL_PERF_OUT"] ?? "perf-results";
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "run.json"), JSON.stringify(run, null, 2) + "\n", { flag: "wx" });
});

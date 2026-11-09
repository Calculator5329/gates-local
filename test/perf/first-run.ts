/// <reference lib="dom" />
// A separate cold context exercises setup without changing the existing chat journeys.
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { CONTROL_URL, ROOT, WEB_ORIGIN, WEB_PORT, appUrl } from "../e2e/env.ts";
import { install } from "./probe.ts";
import { metric } from "./stats.ts";
import { ownProcesses } from "./processes.ts";

export async function firstRunTimes(target: string, fixture: string, samples: number, screenshot?: string, signal = new AbortController().signal) {
  const processes = ownProcesses(signal);
  const children: ChildProcess[] = [];
  const browserPath = process.env["GATES_LOCAL_CHROMIUM"] ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  let browser: Browser | undefined;
  const onAbort = () => { void browser?.close().catch(error => console.error("First-run browser cleanup failed:", error)); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    children.push(processes.spawn(process.execPath, ["test/perf/stack.ts"], { cwd: ROOT, env: { ...process.env, GL_PERF_TARGET: target, GL_PERF_FIXTURE: fixture }, stdio: ["ignore", "ignore", "inherit"], detached: true }));
    children.push(processes.spawn("pnpm", ["--filter", "@gates-local/web", "exec", "vite", "preview", "--host", new URL(WEB_ORIGIN).hostname, "--port", String(WEB_PORT), "--strictPort"], { cwd: target, stdio: ["ignore", "ignore", "inherit"], detached: true }));
    browser = await chromium.launch({ executablePath: browserPath });
    signal.throwIfAborted();
    for (const url of [`${CONTROL_URL}/health`, WEB_ORIGIN]) {
      const deadline = Date.now() + 30_000;
      while (true) {
        signal.throwIfAborted();
        if (children.some(child => child.exitCode !== null)) throw new Error("First-run fixture exited before readiness");
        try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* still starting */ }
        if (Date.now() >= deadline) throw new Error(`First-run fixture did not become ready: ${new URL(url).pathname}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      signal.throwIfAborted();
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      try {
        const page = await context.newPage();
        await install(page, true);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await page.goto(appUrl());
        await page.waitForFunction(() => document.querySelector(".fr h1")?.textContent === "Ready to chat", undefined, { timeout: 15_000 });
        signal.throwIfAborted();
        const observation = await page.evaluate(() => window.perfJourney.result);
        times.push(observation.elapsed);
        if (i === 0 && screenshot !== undefined) await page.screenshot({ path: screenshot });
      } finally { await context.close(); }
    }
    signal.throwIfAborted();
    return metric("first-run-ready", "ms", times);
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { await processes.close(); }
    finally { await browser?.close(); }
  }
}

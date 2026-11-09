/// <reference lib="dom" />
// A separate cold context exercises setup without changing the existing chat journeys.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { CONTROL_URL, ROOT, WEB_ORIGIN, WEB_PORT, appUrl } from "../e2e/env.ts";
import { install } from "./probe.ts";
import { metric } from "./stats.ts";

export async function firstRunTimes(target: string, fixture: string, samples: number, screenshot?: string) {
  const children = [
    spawn(process.execPath, ["test/perf/stack.ts"], { cwd: ROOT, env: { ...process.env, GL_PERF_TARGET: target, GL_PERF_FIXTURE: fixture }, stdio: ["ignore", "ignore", "inherit"], detached: true }),
    spawn("pnpm", ["--filter", "@gates-local/web", "exec", "vite", "preview", "--host", new URL(WEB_ORIGIN).hostname, "--port", String(WEB_PORT), "--strictPort"], { cwd: target, stdio: ["ignore", "ignore", "inherit"], detached: true }),
  ];
  const browserPath = process.env["GATES_LOCAL_CHROMIUM"] ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: browserPath });
    for (const url of [`${CONTROL_URL}/health`, WEB_ORIGIN]) {
      const deadline = Date.now() + 30_000;
      while (true) {
        if (children.some(child => child.exitCode !== null)) throw new Error("First-run fixture exited before readiness");
        try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* still starting */ }
        if (Date.now() >= deadline) throw new Error(`First-run fixture did not become ready: ${new URL(url).pathname}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      try {
        const page = await context.newPage();
        await install(page, true);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await page.goto(appUrl());
        await page.waitForFunction(() => document.querySelector(".fr h1")?.textContent === "Ready to chat", undefined, { timeout: 15_000 });
        const observation = await page.evaluate(() => window.perfJourney.result);
        times.push(observation.elapsed);
        if (i === 0 && screenshot !== undefined) await page.screenshot({ path: screenshot });
      } finally { await context.close(); }
    }
    return metric("first-run-ready", "ms", times);
  } finally {
    await browser?.close();
    for (const child of children) if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
    await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()))));
  }
}

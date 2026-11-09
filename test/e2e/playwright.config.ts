// E2E for the web client against the real server and the fake Ollama.
//   pnpm e2e        functional journeys and informational bundle sizes (project "e2e")
//   pnpm e2e:timing wall-clock measurements, unchanged budgets (project "timing", informational for releases)
// Timing journeys have separate functional companions in the blocking e2e project.
//   pnpm e2e:shots  the deterministic screenshot rig (project "shots")
//   pnpm shots:readme  the README images in docs/screenshots (project "readme")
// Browser: GATES_LOCAL_CHROMIUM, else /usr/bin/chromium when present, else
// Playwright's own Chromium; Edge on Windows. One worker: every journey
// shares the one server and resets it first.
import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, type LaunchOptions } from "@playwright/test";
import { CONTROL_URL, RESULTS_DIR, ROOT, WEB_ORIGIN, WEB_PORT } from "./env.ts";

function browser(): { channel?: string; launchOptions?: LaunchOptions } {
  const pinned = process.env["GATES_LOCAL_CHROMIUM"];
  if (pinned) return { launchOptions: { executablePath: pinned } };
  if (process.platform === "win32") return { channel: "msedge" };
  if (existsSync("/usr/bin/chromium")) return { launchOptions: { executablePath: "/usr/bin/chromium" } };
  return {};
}

const preview = `pnpm --filter @gates-local/web build && pnpm --filter @gates-local/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`;
const realSmoke = process.env["GATES_REAL_SMOKE"] === "1";

export default defineConfig({
  testDir: ".",
  // Keep the setup's real-ollama.log outside Playwright's cleared output folder.
  outputDir: realSmoke ? path.join(RESULTS_DIR, "browser") : RESULTS_DIR,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["./budget-reporter.ts"]],
  use: {
    ...browser(),
    baseURL: WEB_ORIGIN,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  projects: [
    // Browser journeys are *.spec.ts; a *.test.ts here (seed.test.ts) is a vitest unit test.
    { name: "e2e", testMatch: realSmoke ? /real-smoke\.spec\.ts$/ : /\.spec\.ts$/, testIgnore: realSmoke ? [] : [/shots\.spec\.ts/, /real-smoke\.spec\.ts/], grepInvert: /@timing/ },
    { name: "timing", testMatch: /\.spec\.ts$/, grep: /@timing/ },
    { name: "shots", testMatch: /(^|[\\/])shots\.spec\.ts$/ },
    { name: "readme", testMatch: /readme-shots\.spec\.ts$/ },
  ],
  webServer: [
    ...(realSmoke ? [] : [{ command: "node test/e2e/stack.ts", cwd: ROOT, url: `${CONTROL_URL}/health`, reuseExistingServer: false, timeout: 30_000, stdout: "ignore" as const, stderr: "pipe" as const }]),
    { command: preview, cwd: ROOT, url: WEB_ORIGIN, reuseExistingServer: false, timeout: 120_000, stdout: "ignore", stderr: "pipe" },
  ],
});

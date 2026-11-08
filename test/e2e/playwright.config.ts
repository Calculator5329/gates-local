// E2E for the web client against the real server and the fake Ollama.
//   pnpm e2e        journeys and perf budgets (project "e2e")
//   pnpm e2e:shots  the deterministic screenshot rig (project "shots")
//   pnpm shots:readme  the README images in docs/screenshots (project "readme")
// Browser: GATES_LOCAL_CHROMIUM, else /usr/bin/chromium when present, else
// Playwright's own Chromium; Edge on Windows. One worker: every journey
// shares the one server and resets it first.
import { existsSync } from "node:fs";
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

export default defineConfig({
  testDir: ".",
  outputDir: RESULTS_DIR,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
  use: {
    ...browser(),
    baseURL: WEB_ORIGIN,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "e2e", testIgnore: /shots\.spec\.ts/ },
    { name: "shots", testMatch: /(^|[\\/])shots\.spec\.ts$/ },
    { name: "readme", testMatch: /readme-shots\.spec\.ts$/ },
  ],
  webServer: [
    { command: "node test/e2e/stack.ts", cwd: ROOT, url: `${CONTROL_URL}/health`, reuseExistingServer: false, timeout: 30_000, stdout: "ignore", stderr: "pipe" },
    { command: preview, cwd: ROOT, url: WEB_ORIGIN, reuseExistingServer: false, timeout: 120_000, stdout: "ignore", stderr: "pipe" },
  ],
});

import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { CONTROL_URL, ROOT, WEB_ORIGIN, WEB_PORT } from "../e2e/env.ts";

const target = process.env["GL_PERF_TARGET"] ?? ROOT;
const executablePath = process.env["GATES_LOCAL_CHROMIUM"] ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: ".",
  testMatch: "journeys.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  outputDir: path.resolve(process.env["GL_PERF_OUT"] ?? "perf-results", "browser-artifacts"),
  use: {
    browserName: "chromium",
    launchOptions: { executablePath, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"] },
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    { command: "node test/perf/stack.ts", cwd: ROOT, url: `${CONTROL_URL}/health`, reuseExistingServer: false, timeout: 30_000 },
    { command: `pnpm --filter @gates-local/web exec vite preview --host ${new URL(WEB_ORIGIN).hostname} --port ${WEB_PORT} --strictPort`, cwd: target, url: WEB_ORIGIN, reuseExistingServer: false, timeout: 30_000 },
  ],
});

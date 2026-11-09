import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { CONTROL_URL, ROOT, WEB_ORIGIN, WEB_PORT } from "../e2e/env.ts";
import { prepareFixture } from "./fixture.ts";
import { selectJourneys } from "./selection.ts";
import { fakeMicrophoneFile } from "./voice-fixture.ts";

const target = process.env["GL_PERF_TARGET"] ?? ROOT;
// The comparison supplies a template per build. Direct Playwright invocations
// prepare it before the webServer deadline begins; workers inherit this path.
process.env["GL_PERF_FIXTURE"] ??= await prepareFixture(target);
const executablePath = process.env["GATES_LOCAL_CHROMIUM"] ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const only = selectJourneys(process.env["GL_PERF_ONLY"] || undefined);
const microphone = only?.includes("voice") ? fakeMicrophoneFile() : undefined;

export default defineConfig({
  testDir: ".",
  testMatch: only ? "priority.spec.ts" : "journeys.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: "list",
  outputDir: path.resolve(process.env["GL_PERF_OUT"] ?? "perf-results", "browser-artifacts"),
  use: {
    browserName: "chromium",
    launchOptions: { executablePath, args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", ...(microphone ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${microphone}`] : [])] },
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

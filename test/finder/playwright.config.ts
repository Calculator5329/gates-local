// The bug finder's walk (scripts/bug-finder.ts): the e2e suite's stack, browser
// and page settings, with only test/finder/walk.spec.ts in it. Not part of
// `pnpm e2e` or the release check.
import { defineConfig } from "@playwright/test";
import e2e from "../e2e/playwright.config.ts";

export default defineConfig({
  ...e2e,
  testDir: ".",
  timeout: 240_000,
  reporter: [["list"]],
  // the screencast keeps every frame; a video would only slow the walk
  use: { ...e2e.use, video: "off" },
  projects: [{ name: "finder", testMatch: /(^|[\\/])walk\.spec\.ts$/ }],
});

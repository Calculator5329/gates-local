// The screenshot rig (`pnpm e2e:shots`): the real client on the real server
// and the fake Ollama, in the states the design's shots show, written as
// <SHOTS_DIR>/<design name>.png at 1440x900, scale 1, dark and light. The
// clock, time zone and seeded threads are pinned, so two runs give the same
// pixels. Compare with the design's own rig: rounds/r6/shots, same names.
//
// A light twin takes the design's light name where the design has one
// (S-01-thread pairs with S-26-light-thread), else S-NN-light-<rest>.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { LONG_NAME } from "../fake-ollama/models.ts";
import { SHOTS_DIR } from "./env.ts";
import { type RuntimeMode, type Scenario, expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago (CST, UTC-6). */
const NOW = Date.UTC(2026, 10, 12, 20, 0);

interface Shot {
  readonly name: string;
  /** The design's light shot of the same state, when it has one. */
  readonly light?: string;
  readonly scenario?: Scenario;
  /** Saved settings' runtime mode; undefined is fresh settings. */
  readonly runtimeMode?: RuntimeMode;
  /** Open on the seeded thread (default), a new thread, or first run. */
  readonly start?: "thread" | "new" | "firstrun";
  /** Seed other than the design's threads (a number seeds one long thread, test/e2e/seed.ts). */
  readonly seed?: number;
  /** What to do once the page is ready. */
  readonly act?: (page: Page) => Promise<void>;
}

const settings = (label: string) => async (page: Page) => {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
};

const SHOTS: readonly Shot[] = [
  { name: "S-01-thread", light: "S-26-light-thread" },
  { name: "S-04-new", start: "new" },
  { name: "S-05-picker", light: "S-62-light-picker", act: (p) => p.locator("#modelBtn").click() },
  // chat-feel: the docked fit panel (the design's S-07-fit) moved to Settings › Advanced
  {
    name: "S-133-settings-advanced",
    act: async (p) => {
      await settings("Advanced")(p);
      await expect(p.locator("#gpuMemory .fp-v")).toContainText("Runs on GPU");
      await p.mouse.move(1400, 880);
    },
  },
  // the design's state: the user chose the system Ollama and a wrong service holds its port
  { name: "S-12-runtime-wrong", scenario: "wrong-service", runtimeMode: "system" },
  { name: "S-14-firstrun-found", light: "S-66-light-firstrun-found", start: "firstrun" },
  { name: "S-16-firstrun-nomodels", light: "S-76-light-firstrun-nomodels-before", scenario: "no-models", start: "firstrun" },
  { name: "S-17-settings-general", act: settings("General") },
  { name: "S-18-settings-models", light: "S-90-light-settings-models", act: settings("Models") },
  { name: "S-19-settings-runtime", light: "S-60-light-settings-runtime", act: settings("Runtime") },
  { name: "S-20-settings-memory", act: settings("Memory") },
  { name: "S-21-settings-images", act: settings("Image generation") },
  { name: "S-109-settings-library", light: "S-110-light-settings-library", act: settings("Library") },
  { name: "S-23-thread-hover-actions", act: (p) => p.locator(".turn.a").last().locator(".md").hover() },
  { name: "S-24-tool-expanded", act: (p) => p.locator(".wr").first().click() },
  { name: "S-25-plus-menu", act: (p) => p.locator("#plusBtn").click() },
  // chat-feel: a reply held mid code block (the fake waits after 46 tokens), a code block hovered, the thinking row hovered
  {
    name: "S-130-stream-held",
    start: "new",
    act: async (p) => {
      await stack.scenario("slow-drip", { holdAfterTokens: 46 });
      await sendMessage(p, "How do I check disk space before a download?");
      await expect(p.locator(".turn.a").last().getByRole("heading", { name: "Steps" })).toBeVisible();
      await p.waitForTimeout(600);
      await p.mouse.move(720, 120);
    },
  },
  { name: "S-131-code-hover", seed: 2, act: (p) => p.locator(".turn.a .md pre").last().hover() },
  { name: "S-132-think-hover", act: (p) => p.locator(".turn.a .think").last().hover() },
  // chat-feel part 2: a long model tag truncated in the composer (its tooltip has the whole tag)
  {
    name: "S-134-composer-long-name",
    scenario: "long-name",
    act: async (p) => {
      await p.locator("#modelBtn").click();
      await p.locator("#pkSearch").fill("heretic");
      await p.locator(`#picker .pk-r[data-m="${LONG_NAME}"]`).click();
      await expect(p.locator("#picker")).toBeHidden();
      await p.locator("#modelBtn").hover();
      await expect(p.locator("#tip")).toContainText(LONG_NAME);
    },
  },
  {
    name: "S-135-picker-context-8k",
    act: async (p) => {
      await p.locator("#modelBtn").click();
      await p.locator("#picker").getByRole("radiogroup", { name: "Context" }).getByRole("radio", { name: "8k" }).click();
      await p.mouse.move(1400, 880);
    },
  },
  {
    name: "S-136-sidebar-thread-menu",
    act: async (p) => {
      await p.locator(".sb-row", { hasText: "Fix the backup cron" }).click({ button: "right", position: { x: 60, y: 14 } });
      await expect(p.locator("#moreMenu")).toBeVisible();
    },
  },
  {
    name: "S-137-more-menu-gpu",
    act: async (p) => {
      await p.locator("#moreBtn").click();
      await p.locator("#moreMenu").getByRole("menuitem", { name: "GPU memory" }).hover();
    },
  },
  {
    name: "S-138-gpu-panel",
    act: async (p) => {
      await p.locator("#moreBtn").click();
      await p.locator("#moreMenu").getByRole("menuitem", { name: "GPU memory" }).click();
      await expect(p.locator("#fitPanel .fp-v")).toContainText("Runs on GPU");
      await p.mouse.move(700, 720);
    },
  },
];

const lightName = (s: Shot) => s.light ?? s.name.replace(/^(S-\d+)-/, "$1-light-");

test.use({ seed: "design", seedAt: NOW, timezoneId: "America/Chicago", locale: "en-US" });

test.beforeAll(() => mkdirSync(SHOTS_DIR, { recursive: true }));

for (const shot of SHOTS) {
  for (const theme of ["dark", "light"] as const) {
    const file = theme === "dark" ? shot.name : lightName(shot);
    test.describe(file, () => {
      // first run shows only on an empty store, so its shots seed nothing
      test.use({
        scenario: shot.scenario ?? "models",
        skipFirstRun: shot.start !== "firstrun",
        colorScheme: theme,
        ...(shot.start === "firstrun" ? { seed: 0 } : shot.seed === undefined ? {} : { seed: shot.seed }),
        ...(shot.runtimeMode === undefined ? {} : { runtimeMode: shot.runtimeMode }),
      });
      test("shot", async ({ page, open, seededThread }) => {
        await page.clock.setFixedTime(NOW);
        await open(shot.start === undefined || shot.start === "thread" ? `#thread=${seededThread ?? ""}` : "");
        if (shot.start === "firstrun") await expect(page.locator(".first").getByRole("heading").first()).toBeVisible();
        else if (shot.scenario === undefined || shot.scenario === "long-name") await waitReady(page);
        else await expect(page.locator(".banner")).toBeVisible();
        // the app is dark by default; a light shot asks for the light tokens
        if (theme === "light") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
        await shot.act?.(page);
        // let fit checks, popovers and fonts settle; animations are frozen below
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${file}.png`), animations: "disabled", caret: "hide" });
      });
    });
  }
}

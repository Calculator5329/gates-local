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
import { SHOTS_DIR } from "./env.ts";
import { type RuntimeMode, type Scenario, expect, stack, test, waitReady } from "./fixtures.ts";

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
  {
    name: "S-07-fit",
    light: "S-42-light-fit-panel",
    // click once the verdict settles: the chip widens then, and an early click left the pointer over Thinking (its tooltip)
    act: async (p) => {
      await expect(p.locator("#fitBtn")).toContainText("on GPU");
      await p.locator("#fitBtn").click();
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
];

const lightName = (s: Shot) => s.light ?? s.name.replace(/^(S-\d+)-/, "$1-light-");

// Settings › Models in the states of the models-a4 design (its a4-NN shot is
// named in the comment): one theme each, some at phone size.
const models = settings("Models");
const kebab = (tag: string) => async (p: Page) => {
  await models(p);
  await p.locator(`.mp-row[data-dm="${tag}"]`).getByRole("button", { name: /^More for / }).click();
};
/** Slow the fake's pulls so a download is still running when the shot is taken. */
const slowPulls = () => stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 400 * 1024 ** 2 });
const downloadTab = async (p: Page) => {
  await models(p);
  await p.getByRole("tab", { name: /^Download/ }).click();
};
const typed = (text: string) => async (p: Page) => {
  await downloadTab(p);
  await p.getByRole("searchbox").fill(text);
  await p.getByRole("button", { name: `Download ${text}` }).click();
};
const PHONE = { width: 412, height: 915 };

interface ModelsShot {
  readonly name: string;
  readonly theme: "dark" | "light";
  readonly scenario?: Scenario;
  readonly viewport?: { width: number; height: number };
  readonly act: (page: Page) => Promise<void>;
}

const MODELS_SHOTS: readonly ModelsShot[] = [
  // a4-01, a4-11
  { name: "M-01-installed-dark", theme: "dark", act: models },
  { name: "M-02-installed-light", theme: "light", act: models },
  // a4-02
  { name: "M-03-row-menu-dark", theme: "dark", act: kebab("gemma4:12b") },
  // a4-04
  {
    name: "M-04-remove-default-dark",
    theme: "dark",
    act: async (p) => {
      await kebab("qwen3.5:9b")(p);
      await p.getByRole("menuitem", { name: /^Remove…/ }).click();
      await expect(p.getByRole("dialog")).toBeVisible();
    },
  },
  // a4-05, a4-12
  {
    name: "M-05-download-running-dark",
    theme: "dark",
    act: async (p) => {
      await slowPulls();
      await downloadTab(p);
      await p.getByRole("button", { name: "Download Qwen 3.5 4B" }).click();
      await expect(p.locator(".mp-pmeta b")).toBeVisible();
      await p.waitForTimeout(2500);
    },
  },
  {
    name: "M-06-download-running-light",
    theme: "light",
    act: async (p) => {
      await slowPulls();
      await downloadTab(p);
      await p.getByRole("button", { name: "Download Qwen 3.5 4B" }).click();
      await expect(p.locator(".mp-pmeta b")).toBeVisible();
      await p.waitForTimeout(2500);
    },
  },
  // a4-07: a name outside the curated list that the library has
  {
    name: "M-07-typed-found-dark",
    theme: "dark",
    act: async (p) => {
      await stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 20 * 1024 ** 2 });
      await typed("nomic-embed-text:latest")(p);
      await expect(p.locator(".mp-lookup")).toContainText("Found");
    },
  },
  // a4-08
  {
    name: "M-08-typed-not-found-dark",
    theme: "dark",
    act: async (p) => {
      await typed("mistral-nemox:12b")(p);
      await expect(p.locator(".mp-miss")).toBeVisible();
    },
  },
  // no a4 twin: the M3 ledger's ready card
  {
    name: "M-09-ready-dark",
    theme: "dark",
    act: async (p) => {
      await downloadTab(p);
      await p.getByRole("button", { name: "Download Qwen 3.5 4B" }).click();
      await expect(p.locator(".mp-ready")).toBeVisible({ timeout: 20_000 });
    },
  },
  // a4-09
  { name: "M-10-zero-models-dark", theme: "dark", scenario: "no-models", act: models },
  // a4-15, a4-16
  { name: "M-11-phone-installed-dark", theme: "dark", viewport: PHONE, act: models },
  {
    name: "M-12-phone-download-dark",
    theme: "dark",
    viewport: PHONE,
    act: async (p) => {
      await slowPulls();
      await downloadTab(p);
      await p.getByRole("button", { name: "Download Qwen 3.5 4B" }).click();
      await expect(p.locator(".mp-pmeta b")).toBeVisible();
      await p.waitForTimeout(2500);
    },
  },
  // a4-14
  {
    name: "M-13-default-dropdown-dark",
    theme: "dark",
    act: async (p) => {
      await models(p);
      await p.getByRole("button", { name: /^Default for new chats:/ }).click();
    },
  },
];

test.describe("models page", () => {
  for (const shot of MODELS_SHOTS) {
    test.describe(shot.name, () => {
      test.use({
        scenario: shot.scenario ?? "models",
        colorScheme: shot.theme,
        ...(shot.viewport ? { viewport: shot.viewport } : {}),
      });
      test("shot", async ({ page, open, seededThread }) => {
        await page.clock.setFixedTime(NOW);
        await open(`#thread=${seededThread ?? ""}`);
        // with no models the composer stays disabled, so only the runtime dot says ready
        if (shot.scenario === undefined) await waitReady(page);
        else await expect(page.locator(".sb-foot .rt .dot.ok")).toBeVisible();
        await shot.act(page);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${shot.name}.png`), animations: "disabled", caret: "hide" });
      });
    });
  }
});

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
        ...(shot.start === "firstrun" ? { seed: 0 } : {}),
        ...(shot.runtimeMode === undefined ? {} : { runtimeMode: shot.runtimeMode }),
      });
      test("shot", async ({ page, open, seededThread }) => {
        await page.clock.setFixedTime(NOW);
        await open(shot.start === undefined || shot.start === "thread" ? `#thread=${seededThread ?? ""}` : "");
        if (shot.start === "firstrun") await expect(page.locator(".first").getByRole("heading").first()).toBeVisible();
        else if (shot.scenario === undefined) await waitReady(page);
        else await expect(page.locator(".banner")).toBeVisible();
        await shot.act?.(page);
        // let fit checks, popovers and fonts settle; animations are frozen below
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${file}.png`), animations: "disabled", caret: "hide" });
      });
    });
  }
}

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
import { CHECKOUT_CACHE, SHOTS_DIR } from "./env.ts";
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
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    // a phone has no section nav: back to the list, then the section
    await page.getByRole("button", { name: "Back to Settings" }).click();
    await page.locator(".set-list").getByRole("button", { name: label }).click();
    return;
  }
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
  { name: "S-20-settings-tools", act: settings("Tools") },
  { name: "S-22-settings-shortcuts", act: settings("Shortcuts") },
  { name: "S-21-settings-images", act: settings("Image generation") },
  { name: "S-109-settings-library", light: "S-110-light-settings-library", act: settings("Library") },
  { name: "S-23-thread-hover-actions", act: (p) => p.locator(".turn.a").last().locator(".md").hover() },
  { name: "S-24-tool-expanded", act: (p) => p.locator(".wr").first().click() },
  { name: "S-25-plus-menu", act: (p) => p.locator("#plusBtn").click() },
  // chat-feel: a reply held mid code block, a code block hovered, the composer Thinking pill hovered
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
  { name: "S-132-think-hover", act: (p) => p.locator('.cf-l button[aria-label="Thinking"]').hover() },
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
const runningDownload = async (p: Page) => {
  await slowPulls();
  await downloadTab(p);
  await p.locator('.dlrow[data-cat="qwen3.5:4b"]').getByRole("button", { name: "Download", exact: true }).click();
  await expect(p.locator(".dlrow.dlg .prog-l")).toBeVisible();
  await p.mouse.move(0, 0); // no tooltip left over from the click
  await p.waitForTimeout(2500);
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
  { name: "M-05-download-running-dark", theme: "dark", act: runningDownload },
  { name: "M-06-download-running-light", theme: "light", act: runningDownload },
  // a4-09
  { name: "M-10-zero-models-dark", theme: "dark", scenario: "no-models", act: models },
  // a4-15, a4-16
  { name: "M-11-phone-installed-dark", theme: "dark", viewport: PHONE, act: models },
  { name: "M-12-phone-download-dark", theme: "dark", viewport: PHONE, act: runningDownload },
  // every row's actions control inside its row, at the two widths the e2e pins
  { name: "M-14-installed-1280-dark", theme: "dark", viewport: { width: 1280, height: 800 }, act: models },
  { name: "M-15-installed-360-dark", theme: "dark", viewport: { width: 360, height: 800 }, act: models },
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
        // with no models the composer stays disabled: the shot's own locators wait instead
        if (shot.scenario === undefined) await waitReady(page);
        await shot.act(page);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${shot.name}.png`), animations: "disabled", caret: "hide" });
      });
    });
  }
});

/** Every Settings section at desktop and phone width, dark, named by section. */
const SETTINGS_PAGES: readonly (readonly [string, string, ((page: Page) => Promise<void>)?])[] = [
  ["general", "General"],
  ["library", "Library"],
  [
    "library-with-a-folder",
    "Library",
    async (p) => {
      const folder = path.join(CHECKOUT_CACHE, "e2e-library", "notes");
      mkdirSync(folder, { recursive: true });
      await p.getByRole("button", { name: "Add folder…" }).click();
      await p.getByRole("textbox", { name: "Add a folder path" }).fill(folder);
      await p.getByRole("button", { name: "Add", exact: true }).click();
      await expect(p.locator(".srow.src")).toHaveCount(1);
    },
  ],
  ["tools", "Tools"],
  ["image-generation", "Image generation"],
  [
    "image-generation-on",
    "Image generation",
    async (p) => {
      await p.getByRole("switch", { name: "Generate images" }).click();
      await expect(p.locator(".srow", { hasText: "Not found" })).toBeVisible();
    },
  ],
  ["runtime", "Runtime"],
  ["runtime-confirm", "Runtime", (p) => p.getByRole("button", { name: /^Use .*Ollama…$/ }).click()],
  ["advanced", "Advanced"],
  ["advanced-details", "Advanced", (p) => p.getByText("Details", { exact: true }).click()],
  ["advanced-reset", "Advanced", (p) => p.getByRole("button", { name: "Reset…" }).click()],
  ["shortcuts", "Shortcuts"],
  ["models", "Models"],
];

test.describe("settings sections", () => {
  for (const [file, label, act] of SETTINGS_PAGES) {
    for (const width of [1280, 360]) {
      test.describe(`s1 settings-${file}-${width}`, () => {
        test.use({ viewport: { width, height: 800 }, colorScheme: "dark", comfyUrl: "http://127.0.0.1:9" });
        test("shot", async ({ page, open, seededThread }) => {
          await page.clock.setFixedTime(NOW);
          await open(`#thread=${seededThread ?? ""}`);
          await waitReady(page);
          await settings(label)(page);
          await act?.(page);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(SHOTS_DIR, `settings-${file}-${width}.png`), animations: "disabled", caret: "hide" });
        });
      });
    }
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

// ---------------------------------------------------------------- the phone
// <SHOTS_DIR>/mobile/M-NN-<state>.png at 412x915, scale 2, touch, dark and light
// (M-NN-light-<state>); also at 360x780 (M-NN-narrow-<state>) and at 768x1024 (M-NN-tablet-<state>),
// except the states only a phone has.

interface MobileShot extends Omit<Shot, "light" | "seed"> {
  readonly seed?: "design-code";
  readonly phoneOnly?: boolean;
}

const tap = (sel: string) => (p: Page) => p.locator(sel).first().tap();
const isPhoneWidth = (p: Page) => (p.viewportSize()?.width ?? 0) <= 640;
const threadMenu = (p: Page) => p.locator(isPhoneWidth(p) ? ".hdr-t" : "#moreBtn").first().tap();
const drawer = async (p: Page) => {
  await p.getByRole("button", { name: "Open threads" }).tap();
  await expect(p.locator(".sb .sb-row").first()).toBeInViewport({ ratio: 1 });
};
const phoneSettings = (section?: string) => async (p: Page) => {
  await drawer(p);
  await p.locator(".sb").getByRole("button", { name: "Settings" }).tap();
  if (section === undefined) return;
  if (isPhoneWidth(p)) {
    await p.locator(".set-list").getByRole("button", { name: section }).tap();
    return;
  }
  // a tablet's sections are in the drawer
  await p.getByRole("button", { name: "Open threads" }).tap();
  await p.locator(".snav").getByRole("button", { name: section }).tap();
};

const MOBILE: readonly MobileShot[] = [
  { name: "M-01-thread" },
  { name: "M-02-drawer", act: drawer },
  { name: "M-03-new", start: "new" },
  { name: "M-04-picker", start: "new", act: tap("#modelBtn") },
  {
    name: "M-05-gpu",
    act: async (p) => {
      await threadMenu(p);
      await p.locator("#moreMenu").getByRole("menuitem", { name: "GPU memory" }).tap();
      await expect(p.locator("#fitPanel")).toContainText("Context for this chat");
    },
  },
  { name: "M-06-settings-list", act: phoneSettings() },
  { name: "M-07-settings-models", act: phoneSettings("Models") },
  { name: "M-08-settings-runtime", act: phoneSettings("Runtime") },
  { name: "M-09-firstrun-found", start: "firstrun" },
  { name: "M-10-firstrun-nomodels", scenario: "no-models", start: "firstrun" },
  { name: "M-11-actions-tap", act: tap(".turn.a .md") },
  { name: "M-12-code", seed: "design-code" },
  { name: "M-13-chat-options", act: tap("#optBtn"), phoneOnly: true },
  { name: "M-14-thread-menu", act: threadMenu },
  {
    name: "M-15-model-actions",
    phoneOnly: true,
    act: async (p) => {
      await phoneSettings("Models")(p);
      await p.locator(".mp-kebab").first().tap();
      await expect(p.locator(".mp-menu")).toBeVisible();
    },
  },
  {
    name: "M-16-advanced",
    phoneOnly: true,
    act: async (p) => {
      await phoneSettings("Advanced")(p);
      await expect(p.locator("#gpuMemory .fp-v")).toBeVisible();
    },
  },
  { name: "M-17-settings-list", phoneOnly: true, act: phoneSettings() },
  { name: "M-18-models", phoneOnly: true, act: phoneSettings("Models") },
  { name: "M-19-general", phoneOnly: true, act: phoneSettings("General") },
];

const NARROW = { width: 360, height: 780 };
const TABLET = { width: 768, height: 1024 };

for (const shot of MOBILE) {
  for (const [size, vp] of [["", PHONE], ["narrow-", NARROW], ["tablet-", TABLET]] as const) {
    if (size === "tablet-" && shot.phoneOnly === true) continue;
    for (const theme of ["dark", "light"] as const) {
      const file = shot.name.replace(/^(M-\d+)-/, `$1-${size}${theme === "light" ? "light-" : ""}`);
      test.describe(file, () => {
        test.use({
          viewport: vp,
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
          scenario: shot.scenario ?? "models",
          skipFirstRun: shot.start !== "firstrun",
          colorScheme: theme,
          ...(shot.start === "firstrun" ? { seed: 0 } : shot.seed === undefined ? {} : { seed: shot.seed }),
        });
        test("shot", async ({ page, open, seededThread }) => {
          await page.clock.setFixedTime(NOW);
          await open(shot.start === undefined || shot.start === "thread" ? `#thread=${seededThread ?? ""}` : "");
          if (shot.start === "firstrun") await expect(page.locator(".first").getByRole("heading").first()).toBeVisible();
          else await waitReady(page);
          await shot.act?.(page);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.waitForTimeout(400);
          mkdirSync(path.join(SHOTS_DIR, "mobile"), { recursive: true });
          await page.screenshot({ path: path.join(SHOTS_DIR, "mobile", `${file}.png`), animations: "disabled", caret: "hide" });
        });
      });
    }
  }
}

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
import { type Step, burst } from "./burst.ts";
import { CHECKOUT_CACHE, SHOTS_DIR, appUrl } from "./env.ts";
import { type RuntimeMode, type Scenario, type Seed, expect, listButton, navButton, sendMessage, stack, test, waitReady } from "./fixtures.ts";
import { TRACK } from "./flicker-probe.ts";
import { settled } from "./waits.ts";

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
    await page.getByTestId("settings.shell.back").click();
    await listButton(page, label).click();
    return;
  }
  await navButton(page, label).click();
};

// Models is its own pop-up on a desktop (footer icon) and a Settings section on a phone
const models = async (p: Page) => {
  if ((p.viewportSize()?.width ?? 1440) <= 640) return settings("Models")(p);
  await p.getByTestId("sidebar.foot.models").click();
  await expect(p.getByRole("dialog", { name: "Models" })).toBeVisible();
};

/**
 * A light shot picks Light with the real Theme control, so General shows Light
 * chosen and says so. Where Settings can't be reached (first run, a server that
 * isn't ready) the page can only be asked for the light tokens.
 */
const goLight = async (page: Page, canUseSettings: boolean) => {
  if (!canUseSettings) return page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await settings("General")(page);
  await page.getByTestId("settings.segment.theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
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
      await expect(p.locator("#gpuMemory .fp-v:visible")).toContainText("Should run well");
      await p.mouse.move(1400, 880);
    },
  },
  // the design's state: the user chose the system Ollama and a wrong service holds its port
  { name: "S-12-runtime-wrong", scenario: "wrong-service", runtimeMode: "system" },
  { name: "S-14-firstrun-found", light: "S-66-light-firstrun-found", start: "firstrun" },
  { name: "S-16-firstrun-nomodels", light: "S-76-light-firstrun-nomodels-before", scenario: "no-models", start: "firstrun" },
  { name: "S-17-settings-general", act: settings("General") },
  { name: "S-18-settings-models", light: "S-90-light-settings-models", act: models },
  { name: "S-19-settings-runtime", light: "S-60-light-settings-runtime", act: settings("Runtime") },
  { name: "S-20-settings-tools", act: settings("Tools") },
  { name: "S-22-settings-shortcuts", act: settings("Shortcuts") },
  { name: "S-21-settings-images", act: settings("Image generation") },
  { name: "S-109-settings-library", light: "S-110-light-settings-library", act: settings("Library") },
  { name: "S-23-thread-hover-actions", act: (p) => p.locator(".turn.a").last().locator(".md").hover() },
  { name: "S-24-tool-expanded", act: async (p) => { await p.locator("button.think.fold").first().click(); await p.locator(".wr").first().click(); } },
  { name: "S-25-plus-menu", act: (p) => p.locator("#plusBtn").click() },
  // chat-feel: a reply held mid code block, a code block hovered, the composer Thinking pill hovered
  {
    name: "S-130-stream-held",
    start: "new",
    act: async (p) => {
      await stack.scenario("slow-drip", { holdAfterTokens: 46 });
      await sendMessage(p, "How do I check disk space before a download?");
      await expect(p.locator(".turn.a").last().getByRole("heading", { name: "Steps" })).toBeVisible();
      // the reply is held after its 46th word, the code block's second line: shown once that line is in
      await expect(p.locator(".turn.a").last().locator(".md pre").last()).toContainText("du -sh");
      await settled(p);
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
      await expect(p.locator("#tip")).not.toBeEmpty();
    },
  },
  {
    name: "S-135-picker-context-8k",
    act: async (p) => {
      await p.locator("#modelBtn").click();
      await p.locator('#picker [data-ctx="8192"]').click();
      await p.locator("#modelBtn").click();
      await p.mouse.move(1400, 880);
    },
  },
  {
    name: "S-136-sidebar-thread-menu",
    act: async (p) => {
      const row = p.locator(".sb-row", { hasText: "Fix the backup cron" });
      await row.hover();
      await row.locator(".sb-menu").click();
      await expect(p.locator("#threadMenu")).toBeVisible();
    },
  },
];

const lightName = (s: Shot) => s.light ?? s.name.replace(/^(S-\d+)-/, "$1-light-");

// Settings › Models in the states of the models-a4 design (its a4-NN shot is
// named in the comment): one theme each, some at phone size.
const kebab = (tag: string) => async (p: Page) => {
  await models(p);
  await p.locator(`.mp-row[data-dm="${tag}"]`).getByTestId("models.row-menu.open").click();
};
const TAG = "qwen3.5:4b";
/** Press Download on an offered row, with pulls slowed so the row is still downloading in the shot. */
const runningDownload = (scenario: "models" | "no-models" = "models") => async (p: Page) => {
  await stack.scenario(scenario, { pullTickMs: 1000, pullChunkBytes: 400 * 1024 ** 2 });
  await models(p);
  await p.locator(`.mp-row[data-cat="${TAG}"]`).getByTestId("models.offered.download").click();
  const bar = p.locator(`.mp-row[data-pull="${TAG}"]`).getByRole("progressbar");
  await expect(bar).toBeVisible();
  await p.mouse.move(0, 0); // no tooltip left over from the click
  await expect(bar, "the download has moved").toHaveAttribute("aria-valuenow", /^[1-9]\d*$/);
  await expect(p.locator("#tip.open")).toHaveCount(0);
};
const finishedDownload = async (p: Page) => {
  await models(p);
  await p.locator(`.mp-row[data-cat="${TAG}"]`).getByTestId("models.offered.download").click();
  await expect(p.locator(`.mp-row[data-dm="${TAG}"]`)).toBeVisible({ timeout: 30_000 });
  await p.mouse.move(0, 0);
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
      // the confirm is a dialog inside the Models dialog, so it is named by its test id
      await expect(p.getByTestId("models.remove.dialog")).toBeVisible();
    },
  },
  // a4-05, a4-12: the row Download was pressed on, downloading where it was
  { name: "M-05-download-running-dark", theme: "dark", act: runningDownload() },
  { name: "M-06-download-running-light", theme: "light", act: runningDownload() },
  { name: "M-07-download-finished-dark", theme: "dark", act: finishedDownload },
  // a4-09
  { name: "M-10-zero-models-dark", theme: "dark", scenario: "no-models", act: models },
  { name: "M-08-zero-models-download-running-dark", theme: "dark", scenario: "no-models", act: runningDownload("no-models") },
  { name: "M-09-zero-models-download-finished-dark", theme: "dark", scenario: "no-models", act: finishedDownload },
  // a4-15, a4-16
  { name: "M-11-phone-installed-dark", theme: "dark", viewport: PHONE, act: models },
  { name: "M-12-phone-download-dark", theme: "dark", viewport: PHONE, act: runningDownload() },
  { name: "M-13-phone-zero-models-dark", theme: "dark", viewport: PHONE, scenario: "no-models", act: models },
  // every row's actions control inside its row, at the two widths the e2e pins
  { name: "M-14-installed-1280-dark", theme: "dark", viewport: { width: 1280, height: 800 }, act: models },
  { name: "M-15-installed-360-dark", theme: "dark", viewport: { width: 360, height: 800 }, act: models },
  // a4-14's default dropdown left with the Default card (decision 10)
];

test.describe("models page", () => {
  for (const shot of MODELS_SHOTS) {
    test.describe(shot.name, () => {
      test.use({
        scenario: shot.scenario ?? "models",
        colorScheme: shot.theme,
        ...(shot.viewport ? { viewport: shot.viewport } : {}),
      });
      // Not a regression test: a screenshot tool, run on its own.
      test("shot", async ({ page, open, seededThread }) => {
        await page.clock.setFixedTime(NOW);
        await open(`#thread=${seededThread ?? ""}`);
        // with no models the composer stays disabled: the shot's own locators wait instead
        if (shot.scenario === undefined) await waitReady(page);
        await shot.act(page);
        await settled(page);
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
      await p.getByTestId("settings.library.add-folder").click();
      await p.getByTestId("settings.add-source.path-folder").fill(folder);
      await p.getByTestId("settings.add-source.add-folder").click();
      await expect(p.locator(".srow.src")).toHaveCount(1);
    },
  ],
  ["tools", "Tools"],
  ["image-generation", "Image generation"],
  [
    "image-generation-on",
    "Image generation",
    async (p) => {
      // nothing answers at this address and the app has no engine: Set up images, no switch
      await expect(p.getByText("Set up images").first()).toBeVisible();
      await expect(p.getByTestId("settings.images.enable")).toHaveCount(0);
    },
  ],
  ["runtime", "Runtime"],
  ["runtime-confirm", "Runtime", (p) => p.getByRole("button", { name: /^Use .*Ollama$/ }).click()],
  ["advanced", "Advanced"],
  ["advanced-details", "Advanced", (p) => p.getByText("Details", { exact: true }).click()],
  ["advanced-reset", "Advanced", (p) => p.getByTestId("settings.advanced.reset").click()],
  ["shortcuts", "Shortcuts"],
  ["models", "Models"],
];

test.describe("settings sections", () => {
  for (const [file, label, act] of SETTINGS_PAGES) {
    for (const width of [1280, 360]) {
      test.describe(`s1 settings-${file}-${width}`, () => {
        test.use({ viewport: { width, height: 800 }, colorScheme: "dark", comfyUrl: "http://127.0.0.1:9" });
        // Not a regression test: a screenshot tool, run on its own.
        test("shot", async ({ page, open, seededThread }) => {
          await page.clock.setFixedTime(NOW);
          await open(`#thread=${seededThread ?? ""}`);
          await waitReady(page);
          await settings(label)(page);
          await act?.(page);
          await settled(page);
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
      // Not a regression test: a screenshot tool, run on its own.
      test("shot", async ({ page, open, seededThread }) => {
        await page.clock.setFixedTime(NOW);
        await open(shot.start === undefined || shot.start === "thread" ? `#thread=${seededThread ?? ""}` : "");
        if (shot.start === "firstrun") await expect(page.locator(".first").getByRole("heading").first()).toBeVisible();
        else if (shot.scenario === undefined || shot.scenario === "long-name") await waitReady(page);
        else await expect(page.locator(".banner")).toBeVisible();
        // the app is dark by default
        if (theme === "light") await goLight(page, shot.start !== "firstrun" && (shot.scenario === undefined || shot.scenario === "long-name"));
        await shot.act?.(page);
        // let popovers and fonts settle; animations are frozen below
        await settled(page);
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
const drawer = async (p: Page) => {
  await p.getByTestId("chat.header.open-threads").tap();
  await expect(p.locator(".sb .sb-row").first()).toBeInViewport({ ratio: 1 });
};
const threadMenu = async (p: Page) => {
  await drawer(p);
  await p.locator(".sb-row .sb-menu").first().tap();
};
const phoneSettings = (section?: string) => async (p: Page) => {
  await drawer(p);
  await p.getByTestId("sidebar.foot.settings").tap();
  if (section === undefined) return;
  if (isPhoneWidth(p)) {
    await listButton(p, section).tap();
    return;
  }
  // a tablet's sections are in the drawer
  await p.getByTestId("chat.header.open-threads").tap();
  await navButton(p, section).tap();
};

const MOBILE: readonly MobileShot[] = [
  { name: "M-01-thread" },
  { name: "M-02-drawer", act: drawer },
  { name: "M-03-new", start: "new" },
  { name: "M-04-picker", start: "new", act: tap("#modelBtn") },
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
      await expect(p.locator("#gpuMemory .fp-v:visible")).toBeVisible();
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
        // Not a regression test: a screenshot tool, run on its own.
        test("shot", async ({ page, open, seededThread }) => {
          await page.clock.setFixedTime(NOW);
          await open(shot.start === undefined || shot.start === "thread" ? `#thread=${seededThread ?? ""}` : "");
          if (shot.start === "firstrun") await expect(page.locator(".first").getByRole("heading").first()).toBeVisible();
          else await waitReady(page);
          await shot.act?.(page);
          await settled(page);
          mkdirSync(path.join(SHOTS_DIR, "mobile"), { recursive: true });
          await page.screenshot({ path: path.join(SHOTS_DIR, "mobile", `${file}.png`), animations: "disabled", caret: "hide" });
        });
      });
    }
  }
}

// ------------------------------------------------- the side-by-side kit (GL_E2E_COMPARE=1)
// One scene list another chat app can show too, with the same words typed, at 1440, 1280, 390
// and 360 px, dark and light: <SHOTS_DIR>/compare/still/<scene>--<width>--<theme>.png. Then the
// motions as bursts (burst.ts): <SHOTS_DIR>/compare/burst/<motion>--<width>--dark.{png,json,webm}
// and the frames in a folder of that name. Run alone: `pnpm e2e:shots --grep compare`.

const COMPARE_DIR = path.join(SHOTS_DIR, "compare");
const PROMPT = "How do I check disk space before a download?";
const FIRST_CHAT = "Keep the first chat answering";
const SECOND_CHAT = "Keep the second chat answering too";
const COMPARE_SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;
const phoneSize = (vp: { width: number }) => vp.width <= 640;
const stopButton = (p: Page) => p.getByRole("button", { name: "Stop", exact: true });
/** Sends what is typed: Enter on a computer; on a phone Enter is a new line, so its Send button. */
const submit = async (p: Page) => {
  if (isPhoneWidth(p)) await p.getByTestId("chat.composer.send").click();
  else await p.locator("#ta").press("Enter");
};
const post = async (p: Page, text: string) => {
  await p.locator("#ta").fill(text);
  await submit(p);
};

const newThread = async (p: Page) => {
  await (isPhoneWidth(p) ? p.getByTestId("chat.header.new-thread") : p.getByTestId("sidebar.top.new-thread")).click();
  await expect(p.locator(".turn")).toHaveCount(0);
};
/** A reply that streams to its 46th word, the code block's second line, and holds there. */
const heldReply = async (p: Page) => {
  await stack.scenario("slow-drip", { holdAfterTokens: 46 });
  await post(p, PROMPT);
  await expect(p.locator(".turn.a").last().locator(".md pre").last()).toContainText("du -sh");
};

interface CompareScene {
  readonly name: string;
  readonly seed?: Seed;
  readonly scenario?: Scenario;
  readonly start?: "new" | "thread" | "firstrun";
  readonly act?: (p: Page) => Promise<void>;
}

const COMPARE_SCENES: readonly CompareScene[] = [
  { name: "empty-new-chat" },
  {
    name: "long-reply-code",
    act: async (p) => {
      await stack.scenario("slow-drip", { tokenDelayMs: 0, firstTokenDelayMs: 0 });
      await post(p, PROMPT);
      await expect(p.locator(".turn.a").last().locator(".md table")).toBeVisible();
      await expect(stopButton(p)).toHaveCount(0);
    },
  },
  { name: "model-picker", act: async (p) => { await p.locator("#modelBtn").click(); await expect(p.locator("#picker")).toBeVisible(); } },
  { name: "settings", act: settings("General") },
  { name: "running-reply", act: heldReply },
  {
    name: "two-chats-running",
    act: async (p) => {
      await stack.scenario("slow-drip", { holdAfterTokens: 12 });
      await post(p, FIRST_CHAT);
      await expect(stopButton(p)).toBeVisible();
      await newThread(p);
      await post(p, SECOND_CHAT);
      await expect(stopButton(p)).toBeVisible();
      if (isPhoneWidth(p)) await drawer(p);
      await expect(p.locator(".sb-row").getByLabel("Reply in progress", { exact: true })).toHaveCount(2);
    },
  },
  {
    name: "queued-messages",
    act: async (p) => {
      await heldReply(p);
      await post(p, "And on a second drive?");
      await post(p, "And on a USB stick?");
      await expect(p.locator(".qt-r")).toHaveCount(2);
    },
  },
  // a saved reply with tool steps: the first thought and the first step opened
  { name: "tool-step", seed: "design", start: "thread", act: async (p) => { await p.locator("button.think.fold").first().click(); await p.locator(".wr").first().click(); } },
  {
    name: "error",
    act: async (p) => {
      await stack.scenario("mid-stream-error");
      await post(p, PROMPT);
      await expect(p.getByTestId("chat.reply.failed")).toBeVisible({ timeout: 15_000 });
    },
  },
  { name: "first-run", start: "firstrun" },
];

interface CompareMotion {
  readonly name: string;
  /** Run before the burst starts. */
  readonly before?: (p: Page) => Promise<void>;
  readonly steps: readonly Step[];
}

const COMPARE_MOTIONS: readonly CompareMotion[] = [
  {
    name: "send-to-first-token",
    before: async (p) => { await stack.scenario("slow-drip"); await p.locator("#ta").fill(PROMPT); },
    steps: [async (p) => { await submit(p); await expect(p.locator(".turn.a .md")).not.toBeEmpty(); }],
  },
  {
    name: "thinking-line",
    before: async (p) => { await stack.scenario("slow-drip", { holdThinkingAfterTokens: 14, tokenDelayMs: 70 }); await p.locator("#ta").fill(PROMPT); },
    steps: [async (p) => { await submit(p); await expect(p.locator(".turn.a button.think")).toContainText("Thinking"); }],
  },
  {
    name: "reply-streams-and-ends",
    before: async (p) => {
      await stack.scenario("slow-drip", { tokenDelayMs: 25 });
      await post(p, PROMPT);
      await expect(p.locator(".turn.a .md")).toContainText("Compare the free space");
    },
    steps: [async (p) => { await expect(stopButton(p)).toHaveCount(0, { timeout: 10_000 }); }],
  },
  {
    name: "picker-open-close",
    steps: [
      async (p) => { await p.locator("#modelBtn").click(); await expect(p.locator("#picker")).toBeVisible(); await settled(p); },
      async (p) => { await p.keyboard.press("Escape"); await expect(p.locator("#picker")).toBeHidden(); },
    ],
  },
  {
    name: "popup-open",
    steps: [async (p) => {
      await p.keyboard.press("Control+Comma");
      // a phone's Settings fills the screen, with a way back instead of a frame
      await expect(isPhoneWidth(p) ? p.getByTestId("settings.shell.back") : p.getByRole("dialog", { name: "Settings" })).toBeVisible();
    }],
  },
  {
    name: "queue-row-added-and-sent",
    before: async (p) => { await heldReply(p); await p.locator("#ta").fill("And on a second drive?"); },
    steps: [
      async (p) => { await submit(p); await expect(p.locator(".qt-r")).toHaveCount(1); await settled(p); },
      async (p) => { await p.locator(".qt-r [data-send-now]").click(); await expect(p.locator(".qt-r")).toHaveCount(0); },
    ],
  },
  {
    name: "new-thread-in-sidebar",
    before: async (p) => {
      await stack.scenario("slow-drip", { tokenDelayMs: 0, firstTokenDelayMs: 0 });
      await post(p, PROMPT);
      await expect(stopButton(p)).toHaveCount(0);
    },
    steps: [
      async (p) => { await newThread(p); },
      async (p) => { await post(p, FIRST_CHAT); await expect(p.locator(".turn.u")).toHaveCount(1); },
    ],
  },
  {
    name: "stop",
    before: heldReply,
    steps: [async (p) => { await stopButton(p).click(); await expect(stopButton(p)).toHaveCount(0); }],
  },
];

const COMPARE_TRACK = [...TRACK.split(", "), "#picker", ".qt", ".qt-r", "button.think", ".turn.a .md", "[role=dialog]", ".hdr", "#ta"];
const commit = process.env["GL_E2E_COMMIT"] ?? "unknown";

if (process.env["GL_E2E_COMPARE"] === "1") {
  test.describe("compare stills", () => {
    test.beforeAll(() => mkdirSync(path.join(COMPARE_DIR, "still"), { recursive: true }));
    for (const scene of COMPARE_SCENES) {
      for (const vp of COMPARE_SIZES) {
        for (const theme of ["dark", "light"] as const) {
          const file = `${scene.name}--${vp.width}--${theme}`;
          test.describe(file, () => {
            const phone = phoneSize(vp);
            test.use({
              viewport: vp,
              deviceScaleFactor: phone ? 2 : 1,
              isMobile: phone,
              hasTouch: phone,
              colorScheme: theme,
              scenario: scene.scenario ?? "models",
              skipFirstRun: scene.start !== "firstrun",
              seed: scene.seed ?? 0,
            });
            // Not a regression test: a screenshot tool, run on its own.
            test("shot", async ({ page, open, seededThread }) => {
              await page.clock.setFixedTime(NOW);
              await open(scene.start === "thread" ? `#thread=${seededThread ?? ""}` : "");
              if (scene.start === "firstrun") await expect(page.locator(".first").getByRole("heading").first()).toBeVisible();
              else await waitReady(page);
              // the app keeps its own theme (dark until changed), so light is picked as a person would
              if (theme === "light") {
                await goLight(page, scene.start !== "firstrun");
                const back = page.getByTestId("settings.shell.back");
                if (await back.isVisible()) await back.click();
                if (scene.start !== "firstrun") await expect(page.locator("#ta")).toBeVisible();
              }
              await scene.act?.(page);
              await settled(page);
              await page.screenshot({ path: path.join(COMPARE_DIR, "still", `${file}.png`), animations: "disabled", caret: "hide" });
            });
          });
        }
      }
    }
  });

  test.describe("compare bursts", () => {
    for (const motion of COMPARE_MOTIONS) {
      for (const vp of [COMPARE_SIZES[0], COMPARE_SIZES[2]]) {
        const name = `${motion.name}--${vp.width}--dark`;
        test.describe(name, () => {
          const phone = phoneSize(vp);
          test.use({ seed: 0 });
          // Not a regression test: a recording tool, run on its own. Its own context, since
          // Playwright sets a video only for a whole file.
          test("burst", async ({ browser, seededThread }) => {
            void seededThread; // the stack resets before the page opens
            test.setTimeout(60_000);
            const context = await browser.newContext({
              viewport: vp, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, colorScheme: "dark",
              timezoneId: "America/Chicago", locale: "en-US", recordVideo: { dir: test.info().outputPath("video"), size: vp },
            });
            const page = await context.newPage();
            await page.addInitScript(() => localStorage.setItem("gates-local.first-run-done", "1"));
            await page.goto(appUrl(""));
            await waitReady(page);
            await motion.before?.(page);
            await settled(page);
            const dir = path.join(COMPARE_DIR, "burst");
            const result = await burst(page, { dir, name, track: COMPARE_TRACK, meta: { app: "Gates Local", viewport: `${vp.width}x${vp.height}`, theme: "dark", commit } }, motion.steps);
            test.info().annotations.push({ type: "burst", description: `${result.painted} frames painted, ${result.frames} sampled` });
            const video = page.video();
            await context.close();
            await video?.saveAs(path.join(dir, `${name}.webm`));
          });
        });
      }
    }
  });
}

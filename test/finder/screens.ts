/// <reference lib="dom" />
// The bug finder's walk: the app's screens, the few things a person does on
// each, and the source files each screen depends on. A landing's changed
// files pick its screens (match.ts); the walk (walk.spec.ts) does each step
// with the link slowed and keeps every frame from the action until quiet.
//
// A step names the surface it watches (`root`). Moves, flicker, words said
// twice and cut-off text are looked for inside it. `opens` is the surface's
// first frame when the step opens something: what arrives after that frame
// arrives late. A step without `opens` changes something in place, so what
// it adds is the person's doing and only moves and blinks count.
import type { Page } from "@playwright/test";

/** What a step can use: the page and the walk's own helpers, so this table has no runtime imports. */
export interface Ctx {
  readonly page: Page;
  /** Type into the composer and send with Enter. */
  send(text: string): Promise<void>;
  /** Switch the fake model's behaviour (test/fake-ollama). */
  scenario(name: string, options?: Record<string, number>): Promise<void>;
  /** Let a held fake reply go on. */
  release(): Promise<void>;
  /** A Library file and tools on, so the fake model is offered a tool to call. */
  toolsOn(): Promise<void>;
  /** Image generation on in Settings, against the fake ComfyUI. */
  imagesOn(): Promise<void>;
  /** Wait until the page has nothing in flight. */
  settle(max?: number): Promise<void>;
  /** Wait for a selector to show (default 15 s). */
  shows(selector: string, timeout?: number): Promise<void>;
}

export interface Step {
  readonly name: string;
  /** The surface watched: everything inside it. */
  readonly root: string;
  /** The step opens a surface; its first frame is this selector showing (with these words, when given). */
  readonly opens?: { readonly selector: string; readonly text?: string };
  /** Tracked kinds that may move, come and go here (a reply streaming in), by selector. */
  readonly free?: readonly string[];
  /** Extra boxes to follow on this step, by selector (named in NAMES). */
  readonly track?: readonly string[];
  /** Longest watch after the action, ms (default 6000). */
  readonly max?: number;
  /** Unwatched preparation just before the step. */
  readonly before?: (c: Ctx) => Promise<unknown>;
  readonly act: (c: Ctx) => Promise<unknown>;
}

export interface Screen {
  readonly id: string;
  readonly name: string;
  /** Source globs (repo-relative) this screen depends on. */
  readonly paths: readonly string[];
  /** Threads seeded before the page opens (test/e2e/fixtures.ts Seed). */
  readonly seed?: number | "design" | "usage" | "work-fold";
  readonly viewport?: { readonly width: number; readonly height: number };
  /** First run shows (the walk marks it done otherwise). */
  readonly firstRun?: boolean;
  /** A fake ComfyUI on a GPU for Image mode. */
  readonly comfy?: boolean;
  /** The desktop app's bridge and a stubbed update service whose check finds an update (as updates.spec.ts does). */
  readonly desktopUpdates?: boolean;
  /** The first step is the page load itself, watched from before the app's first script. */
  readonly load?: { readonly name: string; readonly root: string; readonly opens?: { readonly selector: string; readonly text?: string } };
  /** Unwatched setup after the page is ready. */
  readonly setup?: (c: Ctx) => Promise<unknown>;
  readonly steps: readonly Step[];
}

/** Boxes the finder follows besides the probe's own TRACK list, each with a name for the sheet. */
export const NAMES: Readonly<Record<string, string>> = {
  ".cf-r > *": "composer action",
  ".cf-l > *": "composer left control",
  ".composer button.send": "Send",
  ".qt-r": "queued row",
  ".qt": "queue tray",
  ".fold-now": "work chip words",
  ".fold-line:has(.ch-p.on)": "lit work chip",
  ".sb-foot > *": "footer icon",
  ".hdr": "thread header",
  ".hdr h2": "thread title",
  ".dlg": "pop-up",
  ".snav button": "Settings nav item",
  "#modelBtn": "model button",
  ".sb-search": "sidebar search",
};

/** Followed on every step. */
export const FINDER_TRACK = [".cf-r > *", ".cf-l > *", ".composer button.send", ".qt-r", ".qt", ".sb-foot > *", ".hdr", ".dlg", "#modelBtn"];

const WEB = "apps/web/src";
/** Files every screen draws with: a change here walks the core screens, not all of them. */
/** The phone's thread drawer: its rows and its foot slide with it. */
const DRAWER = [".sb-row", ".sb-foot > *"];
const SHARED = [`${WEB}/styles.css`, `${WEB}/ui.tsx`, `${WEB}/icons.tsx`, `${WEB}/App.tsx`, `${WEB}/store.ts`, `${WEB}/main.tsx`, `${WEB}/session/connection.ts`, "packages/contracts/**"];
const STREAM = { holdAfterTokens: 46 };

const openSettings = async (c: Ctx) => { await c.page.keyboard.press("Control+Comma"); await c.shows(".set .set-h h1"); };
const section = (name: string) => ({ selector: ".set-h h1, .mp-head h1", text: name });
const press = (key: string) => (c: Ctx) => c.page.keyboard.press(key);
const click = (selector: string) => (c: Ctx) => c.page.locator(selector).first().click();
/** A reply that is held part way, so Stop and the queue have something to act on. */
/** Until the reply has started and ended: Stop came and went. */
async function untilReplied(c: Ctx, timeout: number): Promise<void> {
  const stop = c.page.locator('.composer [aria-label="Stop"]');
  await stop.first().waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
  await stop.first().waitFor({ state: "detached", timeout });
}

async function heldReply(c: Ctx): Promise<void> {
  await c.scenario("slow-drip", STREAM);
  await c.send("How do I check disk space before a download?");
  await c.shows(".turn.a .md ul li");
}

export const SCREENS: readonly Screen[] = [
  {
    id: "start",
    name: "App start",
    paths: [...SHARED, `${WEB}/screens.tsx`, `${WEB}/screen-loaders.ts`, `${WEB}/session.ts`, `${WEB}/session/server-state.ts`, `${WEB}/Sidebar.tsx`, `${WEB}/Draft*.tsx`, `${WEB}/starter.ts`],
    seed: "design",
    load: { name: "load the app", root: "#app" },
    steps: [],
  },
  {
    id: "first-run",
    name: "First run",
    paths: [`${WEB}/FirstRun.tsx`, `${WEB}/FirstRunShell.tsx`, `${WEB}/starter.ts`],
    seed: 0,
    firstRun: true,
    load: { name: "first run opens", root: ".first", opens: { selector: ".first h1" } },
    steps: [],
  },
  {
    id: "chat",
    name: "Chat",
    paths: [...SHARED, `${WEB}/Thread.tsx`, `${WEB}/markdown.tsx`, `${WEB}/copy.ts`, `${WEB}/reveal.ts`, `${WEB}/paced.ts`, `${WEB}/session/threads.ts`, `${WEB}/session/navigation.ts`, `${WEB}/session/turn.ts`, "apps/server/src/threads/**"],
    seed: "design",
    steps: [
      { name: "open a thread", root: ".main", opens: { selector: ".hdr h2", text: "Fix the backup cron" }, act: (c) => c.page.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click() },
      { name: "switch thread", root: ".main", opens: { selector: ".hdr h2", text: "Whisper latency check" }, act: (c) => c.page.locator(".sb-row").filter({ hasText: "Whisper latency check" }).click() },
      { name: "send a message", root: ".main", free: [".turn"], max: 8000, act: (c) => c.send("What changed since yesterday?") },
    ],
  },
  {
    id: "work-chip",
    name: "A reply that calls tools",
    paths: [`${WEB}/Thread.tsx`, `${WEB}/session/turn.ts`, `${WEB}/session/chat.ts`, "apps/server/src/chat/**", "packages/harness/**"],
    seed: 0,
    setup: (c) => c.toolsOn(),
    steps: [{
      name: "send a message that calls two tools",
      root: ".tl",
      // the reply streams in and the view follows it: only blinks, words and cuts count here
      free: [".turn", "details", ".fold-now", ".cf-r > *", ".composer button.send"],
      track: [".fold-now", ".fold-line:has(.ch-p.on)"],
      max: 15_000,
      before: (c) => c.scenario("slow-drip", { toolCalls: 2, quietToolRounds: 1, tokenDelayMs: 15, firstTokenDelayMs: 900 }),
      // the watch runs until the reply ends: the page is quiet while the model reads a result, so a quiet page is not the end
      act: async (c) => { await c.send("Use a tool to check my notes"); await untilReplied(c, 20_000); },
    }],
  },
  {
    id: "composer",
    name: "Composer",
    paths: [...SHARED, `${WEB}/Composer.tsx`, `${WEB}/composer-press.ts`, `${WEB}/Voice.tsx`, `${WEB}/voice-audio.ts`, `${WEB}/draft*.ts`, `${WEB}/drafts.ts`, `${WEB}/paste.ts`, `${WEB}/file-drop.tsx`, `${WEB}/attachment-images.tsx`, `${WEB}/refused-files.ts`, `${WEB}/session/chat.ts`],
    // in a thread: a new thread's composer moving from the middle to the bottom on its first message is the design
    seed: "design",
    setup: async (c) => { await c.page.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click(); await c.shows(".turn"); await c.settle(); },
    steps: [
      { name: "type a message", root: ".main", act: (c) => c.page.locator("#ta").pressSequentially("Is the backup done?", { delay: 20 }) },
      { name: "send it", root: ".main", free: [".turn"], max: 8000, act: press("Enter") },
      { name: "stop a reply", root: ".main", free: [".turn"], max: 8000, before: heldReply, act: click(".composer button.send") },
    ],
  },
  {
    id: "queue",
    name: "Queue tray",
    paths: [`${WEB}/Composer.tsx`, `${WEB}/session/chat.ts`, `${WEB}/styles.css`, "apps/server/src/chat/**"],
    seed: 0,
    viewport: { width: 1920, height: 1080 },
    setup: heldReply,
    steps: [
      { name: "queue a message", root: ".cw", act: (c) => c.send("And on a second drive?") },
      { name: "edit the queued message", root: ".cw", act: click(".qt-r [data-edit-queued]") },
      { name: "cancel the edit", root: ".cw", act: click('.qt-r [aria-label="Cancel editing"]') },
      { name: "the reply ends and the queued message goes", root: ".cw", max: 12_000, act: (c) => c.release() },
    ],
  },
  {
    id: "sidebar",
    name: "Sidebar",
    paths: [...SHARED, `${WEB}/Sidebar.tsx`, `${WEB}/session/threads.ts`, `${WEB}/session/navigation.ts`, `${WEB}/titlebar.ts`],
    seed: "design",
    steps: [
      { name: "point at Search", root: ".sb", act: (c) => c.page.locator(".sb-search, .sb input[type=search]").first().hover() },
      { name: "search the threads", root: ".sb", free: [".sb-row", ".sb-h"], act: async (c) => { await c.page.locator(".sb input").first().click(); await c.page.keyboard.type("backup", { delay: 20 }); } },
      { name: "clear the search", root: ".sb", free: [".sb-row", ".sb-h"], act: press("Escape") },
      { name: "new thread", root: ".main", act: (c) => c.page.locator(".sb").getByRole("button", { name: /^New thread/ }).first().click() },
    ],
  },
  {
    id: "footer",
    name: "Sidebar footer",
    paths: [`${WEB}/Sidebar.tsx`, `${WEB}/footer-state.ts`, `${WEB}/update-state.ts`, `${WEB}/model-speed.tsx`, `${WEB}/Panel.tsx`, `${WEB}/panel.css`],
    seed: "design",
    steps: [
      { name: "point at each footer icon", root: ".sb-foot", act: async (c) => { for (const b of await c.page.locator(".sb-foot button").all()) { await b.hover(); await c.page.waitForTimeout(120); } } },
      { name: "open Settings from the footer", root: ".set", opens: section("General"), act: (c) => c.page.locator(".sb-foot").getByRole("button", { name: /^Settings/ }).click() },
      { name: "close Settings", root: ".sb", act: press("Escape") },
    ],
  },
  {
    id: "models",
    name: "Models pop-up",
    paths: [`${WEB}/Models.tsx`, `${WEB}/ModelDownloads.tsx`, `${WEB}/models-*.ts`, `${WEB}/session/models.ts`, `${WEB}/Panel.tsx`, `${WEB}/panel.css`, "apps/server/src/runtime/**"],
    seed: "design",
    steps: [
      { name: "open Models", root: ".dlg", opens: { selector: ".dlg-head h2", text: "Models" }, act: (c) => c.page.locator(".sb-foot").getByRole("button", { name: /^Models/ }).click() },
      { name: "Download tab", root: ".dlg", opens: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Download" }, act: (c) => c.page.getByRole("tab", { name: /Download/ }).click() },
      { name: "back to Installed", root: ".dlg", opens: { selector: ".mp-tab[aria-selected=true] .mp-lbl", text: "Installed" }, act: (c) => c.page.getByRole("tab", { name: /Installed/ }).click() },
      { name: "close Models", root: ".main", act: press("Escape") },
    ],
  },
  {
    id: "usage",
    name: "Usage",
    paths: [`${WEB}/Usage.tsx`, `${WEB}/usage-data.ts`, `${WEB}/usage.css`, `${WEB}/session/usage.ts`, `${WEB}/Panel.tsx`, `${WEB}/panel.css`],
    seed: "usage",
    steps: [
      { name: "open Usage", root: '[role=dialog][aria-label="Usage"]', opens: { selector: ".us-chart svg" }, act: click(".sb-foot .usage") },
      { name: "another range", root: "[role=dialog]", act: (c) => c.page.getByRole("group", { name: "Range" }).getByRole("button").last().click() },
      { name: "Speed chart", root: "[role=dialog]", act: (c) => c.page.getByRole("group", { name: "Chart" }).getByRole("button").last().click() },
    ],
  },
  {
    id: "picker",
    name: "Model picker",
    paths: [`${WEB}/Picker.tsx`, `${WEB}/picker-models.ts`, `${WEB}/picker.css`, `${WEB}/pick.ts`, `${WEB}/fit-*.ts`, `${WEB}/FitPanel.tsx`, `${WEB}/session/speed.ts`, "apps/server/src/fit/**"],
    seed: "design",
    steps: [
      { name: "open the picker", root: "#picker", opens: { selector: "#picker.open" }, act: click("#modelBtn") },
      { name: "point at a model", root: "#picker", act: (c) => c.page.locator("#picker .pk-r").nth(1).hover() },
      { name: "close the picker", root: ".main", act: press("Escape") },
    ],
  },
  {
    id: "settings",
    name: "Settings",
    paths: [...SHARED, `${WEB}/Settings.tsx`, `${WEB}/settings-*.ts*`, `${WEB}/Instructions.tsx`, `${WEB}/instruction-draft.ts`, `${WEB}/LibraryImports.tsx`, `${WEB}/library-rows.ts`, `${WEB}/VoiceSettings.tsx`, `${WEB}/FitPanel.tsx`, `${WEB}/session/settings*.ts`, "apps/server/src/settings/**"],
    seed: "design",
    steps: [
      { name: "open Settings", root: ".set", opens: section("General"), act: press("Control+Comma") },
      // Sidebar.tsx SECTIONS, less Models (its own pop-up on a computer)
      ...["Instructions", "Library", "Tools", "Image generation", "Runtime", "Advanced", "Shortcuts"].map((name): Step => ({
        name: `${name} section`,
        root: ".set",
        opens: section(name),
        act: (c) => c.page.locator(".snav").getByRole("button", { name, exact: true }).click(),
      })),
      { name: "General again", root: ".set", opens: section("General"), act: (c) => c.page.locator(".snav").getByRole("button", { name: "General", exact: true }).click() },
    ],
  },
  {
    id: "updates",
    name: "Updates",
    paths: [`${WEB}/Updates.tsx`, `${WEB}/SettingsUpdates.tsx`, `${WEB}/UpdateNote.tsx`, `${WEB}/update-*.ts`, `${WEB}/session/updates.ts`, "apps/server/src/update/**"],
    seed: "design",
    desktopUpdates: true,
    setup: openSettings,
    steps: [
      { name: "check for updates", root: ".set", max: 8000, act: (c) => c.page.locator(".set").getByRole("button", { name: "Check for updates", exact: true }).click() },
    ],
  },
  {
    id: "image",
    name: "Image mode",
    paths: [`${WEB}/ImagePicker.tsx`, `${WEB}/ImageMark.tsx`, `${WEB}/MakerMark.tsx`, `${WEB}/image-*.ts`, `${WEB}/image-picker.css`, `${WEB}/attachment-images.tsx`, "apps/server/src/image/**"],
    seed: 0,
    comfy: true,
    setup: (c) => c.imagesOn(),
    steps: [
      { name: "turn Image on", root: ".main", free: ["#modelBtn"], act: (c) => c.page.getByRole("button", { name: "Image", exact: true }).click() },
      { name: "open the image picker", root: "#imagePicker", opens: { selector: "#imagePicker.open" }, act: click("#modelBtn") },
      { name: "close the image picker", root: ".main", act: press("Escape") },
      // a new thread's composer docks at the bottom on its first message by design; the composer screen watches it in a thread
      { name: "make a picture", root: ".main", free: [".turn", ".composer", ".cf-l > *", ".cf-r > *"], max: 10_000, act: (c) => c.send("A lighthouse on a cliff at dusk") },
    ],
  },
  {
    id: "phone",
    name: "Phone, 390 wide",
    paths: [`${WEB}/styles.css`, `${WEB}/App.tsx`, `${WEB}/Sidebar.tsx`, `${WEB}/Composer.tsx`, `${WEB}/sheet-focus.ts`, `${WEB}/screens.tsx`, `${WEB}/session/navigation.ts`],
    seed: "design",
    viewport: { width: 390, height: 844 },
    steps: [
      // the thread list is a drawer: its rows slide in and out with it
      { name: "open the thread list", root: "#app", free: DRAWER, act: click("#menuBtn") },
      { name: "open a thread", root: "#app", free: DRAWER, opens: { selector: ".hdr h2", text: "Fix the backup cron" }, act: (c) => c.page.locator(".sb-row").filter({ hasText: "Fix the backup cron" }).click() },
      { name: "send a message", root: ".cw", free: [".turn"], max: 8000, act: (c) => c.send("Short answer please") },
      { name: "open Settings", root: "#app", opens: { selector: ".set" }, act: press("Control+Comma") },
    ],
  },
];

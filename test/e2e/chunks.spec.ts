// Production chunk loading: a cold click keeps the real chat until the screen
// is complete; idle warming removes that wait on later visits. No fallback UI.
import type { Page } from "@playwright/test";
import { expect, test, waitReady } from "./fixtures.ts";
import { WEB_ORIGIN } from "./env.ts";

const CHUNKS = /\/assets\/(?:screens|Settings|FirstRun|FitPanel|ModelDownloads)-[^/]+\.js(?:\?.*)?$/;

test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off", trace: process.env["GL_E2E_RECORD"] ? "on" : "retain-on-failure" });

async function capture(page: Page, name: string) {
  // Capture the real settled frame, without disabling or rewriting animations.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

async function observeFirstCover(page: Page) {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const main = document.querySelector("#app .main");
      if (main === null) return;
      (window as unknown as { firstCover: { cover: boolean; inert: boolean } }).firstCover = {
        cover: document.querySelector(".first .fr") !== null,
        inert: main.hasAttribute("inert"),
      };
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

async function expectFirstCover(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { firstCover?: unknown }).firstCover)).toEqual({ cover: true, inert: true });
}

async function holdChunks(page: Page, pattern = CHUNKS) {
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(pattern, async (route) => {
    requested();
    await held;
    await route.continue();
  });
  return { release, started };
}

test.describe("deferred conversation", () => {
  test.use({ seed: 2 });
  test("PL-01: a delayed conversation chunk shows loading after its messages arrive", async ({ page, open, seededThread }) => {
    let readId: unknown;
    let received!: () => void;
    const messages = new Promise<void>((resolve) => { received = resolve; });
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const request = JSON.parse(String(payload)) as { method?: unknown; id?: unknown };
        if (request.method === "threads.get") readId = request.id;
      });
      socket.on("framereceived", ({ payload }) => {
        const response = JSON.parse(String(payload)) as { type?: unknown; id?: unknown; result?: { messages?: unknown } };
        if (response.type === "response" && response.id === readId && Array.isArray(response.result?.messages)) received();
      });
    });
    const chunk = await holdChunks(page, /\/assets\/conversation-[^/]+\.js(?:\?.*)?$/);
    try {
      await open(`#thread=${seededThread ?? ""}`);
      await waitReady(page);
      await chunk.started;
      await messages;
      await capture(page, "conversation-held");
      const status = page.locator(".tl > .col > [data-thread-loading]");
      // turn-shaped placeholders, hidden from assistive tech; the busy timeline says it is loading
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute("data-skel", "");
      await expect(status).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator(".tl")).toHaveAttribute("aria-busy", "true");
      const timeline = await page.locator(".tl").boundingBox();
      const composer = await page.locator(".composer").boundingBox();
      const column = await page.locator(".tl > .col").boundingBox();
      chunk.release();
      await expect(page.locator(".tl .turn")).toHaveCount(2);
      await expect(status).toHaveCount(0);
      expect(await page.locator(".tl").boundingBox()).toEqual(timeline);
      expect(await page.locator(".composer").boundingBox()).toEqual(composer);
      const loadedColumn = await page.locator(".tl > .col").boundingBox();
      expect(loadedColumn).toMatchObject({ x: column?.x, y: column?.y, width: column?.width });
      await capture(page, "conversation-ready");
    } finally {
      chunk.release();
    }
  });
});

for (const width of [1440, 390]) {
  test.describe(`deferred picker CSS at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test("waits for CSS before painting and leaves chat unchanged after closing", async ({ page, open }) => {
      const stylesheet = /\/assets\/picker-[^/]+\.css(?:\?.*)?$/;
      let requested = false;
      page.on("request", request => { if (stylesheet.test(request.url())) requested = true; });
      const css = await holdChunks(page, stylesheet);
      try {
        const warmed = page.waitForResponse(CHUNKS);
        await open();
        await waitReady(page);
        await (await warmed).finished();
        const settingsStyle = () => page.locator(".set").evaluate(root => [root, root.querySelector(".srow"), root.querySelector(".seg2 button")].map(node => {
          if (node === null) throw new Error("General Settings must be complete");
          const style = getComputedStyle(node);
          return [style.display, style.fontSize, style.color, style.padding, style.borderRadius];
        }));
        await page.keyboard.press("Control+Comma");
        await expect(page.locator(".set .seg2").first()).toBeVisible();
        const settingsBefore = await settingsStyle();
        await page.keyboard.press("Escape");
        await waitReady(page);
        const before = await stableChat(page);
        expect(requested, "idle screen warming must not fetch picker CSS").toBe(false);
        await page.locator("#modelBtn").click();
        await css.started;
        await expect(page.locator("#picker")).toHaveCount(0);
        await expect(page.locator("#app")).not.toHaveAttribute("inert");
        await expect(page.locator(".pop-scrim")).toHaveCount(0);
        expect((await stableChat(page)).first).toEqual(before.first);
        await capture(page, "css-held");
        await page.keyboard.press("Escape");
        const loaded = page.waitForResponse(stylesheet);
        css.release();
        await (await loaded).finished();
        await expect(page.locator("#picker")).toHaveCount(0);
        await page.locator("#modelBtn").click();
        await expect(page.locator(".pk-layout")).toHaveCSS("display", "grid");
        await expect(page.locator(".pk-fam").first()).toHaveCSS("width", width <= 640 ? "44px" : "36px");
        await expect(page.locator(".pk-select").first()).toHaveCSS("height", width <= 640 ? "44px" : "34px");
        await capture(page, "css-ready");
        await page.keyboard.press("Escape");
        expect((await stableChat(page)).first).toEqual(before.first);
        await expect(page.locator('link[rel="stylesheet"][href*="picker-"]')).toHaveCount(1);
        await page.keyboard.press("Control+Comma");
        await expect(page.locator(".set .seg2").first()).toBeVisible();
        expect(await settingsStyle()).toEqual(settingsBefore);
      } finally {
        css.release();
      }
    });
  });
}

test.describe("a failed picker asset", () => {
  test.use({ allowedErrors: [[/Failed to load resource/, /Failed to fetch dynamically imported module/, /Importing a module script failed/, /Unable to preload CSS/], { scope: "test" }] });
  for (const asset of ["css", "js"]) {
    test(`a failed ${asset} load offers the same styled reload screen`, async ({ page, open }) => {
      await page.route(new RegExp(`/assets/picker-[^/]+\\.${asset}$`), route => route.fulfill({ status: 404, body: "Not found" }));
      await open();
      await waitReady(page);
      await page.locator("#modelBtn").click();
      await expect(page.locator("#picker").getByRole("alert")).toContainText("This page couldn't load. The app may have updated.");
      await expect(page.locator("#picker").getByRole("button", { name: "Reload", exact: true })).toBeVisible();
      await expect(page.locator("#picker")).toHaveCSS("position", "fixed");
      await capture(page, `failed-${asset}`);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await expect(page.locator("#picker")).toHaveCount(0);
      await expect(page.locator("#modelBtn")).toBeFocused();
    });
  }
});

/** Watch every frame while imports are held, including a single-frame blank or replacement loader. */
async function stableChat(page: Page) {
  return page.evaluate(async () => {
    const selectors = { main: ".main", composer: ".composer", stage: ".stage" };
    const box = (key: keyof typeof selectors) => {
      const r = document.querySelector(selectors[key])?.getBoundingClientRect();
      return r === undefined ? null : [r.x, r.y, r.width, r.height];
    };
    const first = { main: box("main"), composer: box("composer"), stage: box("stage") };
    const frames = [];
    for (let i = 0; i < 12; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({ main: box("main"), composer: box("composer"), stage: box("stage") });
    }
    return { first, frames };
  });
}

for (const width of [1440, 390]) {
  test.describe(`deferred screens at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, seed: 2 });

    for (const section of ["general", "models", "advanced"] as const) {
      test(`a delayed ${section} screen keeps the layout, then opens complete`, async ({ page, open }) => {
        const chunks = await holdChunks(page);
        try {
          await open();
          await waitReady(page);
          // The request proves idle warming runs without first opening any screen.
          await chunks.started;
          const before = await page.locator(".composer").boundingBox();
          await page.keyboard.press("Control+Comma");
          const delayed = await stableChat(page);
          await capture(page, "held");
          expect(delayed.first.composer).not.toBeNull();
          for (const frame of delayed.frames) expect(frame).toEqual(delayed.first);
          expect(await page.locator(".composer").boundingBox()).toEqual(before);
          await expect(page.locator(".set")).toHaveCount(0);
          chunks.release();
          await expect(page.locator(".set")).toBeVisible();
          const label = section === "general" ? "General" : section === "models" ? "Models" : "Advanced";
          if (width <= 640) {
            await page.getByRole("button", { name: "Back to Settings" }).click();
            await page.locator(".set-list").getByRole("button", { name: label }).click();
          } else await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
          const content = section === "models" ? page.locator(".mp") : section === "advanced" ? page.locator("#gpuMemory") : page.getByRole("group", { name: "Theme", exact: true });
          await expect(content).toBeVisible();
          await capture(page, "ready");
          if (section === "models") {
            await page.getByRole("tab", { name: /^Download/ }).click();
            await expect(page.locator(".dlrow").first()).toBeVisible();
            const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
            await row.getByRole("button", { name: "Download", exact: true }).click();
            await expect(row.locator(".badge")).toHaveText("Installed");
          }
          // Every later visit uses the warmed module and renders directly.
          await page.keyboard.press("Escape");
          if (section === "models") await page.keyboard.press("Escape"); // first Escape leaves Download
          await waitReady(page);
          await page.keyboard.press("Control+Comma");
          await expect(page.locator(".set")).toBeVisible();
          await expect(page.getByRole("alert")).toHaveCount(0);
        } finally {
          chunks.release();
        }
      });
    }

    for (const exit of ["Escape", "current thread", "Search", "new thread"] as const) {
      test(`cancel a pending navigation via ${exit} and keep the last destination`, async ({ page, open, seededThread }) => {
        const chunks = await holdChunks(page);
        try {
          await open(`#thread=${seededThread ?? ""}`);
          await waitReady(page);
          await expect(page.locator(".tl .turn")).toHaveCount(2);
          await chunks.started;
          await page.keyboard.press("Control+Comma");
          if (exit === "Escape") await page.keyboard.press("Escape");
          else if (exit === "Search") await page.keyboard.press("Control+k");
          else if (exit === "new thread") await page.keyboard.press("Control+n");
          else {
            if (width <= 640) await page.getByRole("button", { name: "Open threads", exact: true }).click();
            await page.locator(".sb-row").filter({ hasText: "A long thread" }).click();
            await expect(page.locator("#app")).not.toHaveClass(/drawer/);
          }
          const loaded = page.waitForResponse(CHUNKS);
          chunks.release();
          await (await loaded).finished();
          await stableChat(page);
          await expect(page.locator(".set")).toHaveCount(0);
          if (exit === "new thread") await expect(page).not.toHaveURL(/#thread=/);
          else await expect(page).toHaveURL(new RegExp(`#thread=${seededThread}$`));
          if (exit === "Search") await expect(page.locator("#searchIn")).toBeFocused();
          await capture(page, `cancel-${exit.replaceAll(" ", "-")}`);
        } finally {
          chunks.release();
        }
      });
    }

    for (const section of ["general"] as const) {
      for (const submit of ["Enter", "Send"] as const) {
        test(`BG-01: ${submit} during pending ${section} stays in the displayed thread`, async ({ page, open, seededThread }) => {
          const chunks = await holdChunks(page);
          try {
            await open(`#thread=${seededThread ?? ""}`);
            await waitReady(page);
            await expect(page.locator(".tl .turn")).toHaveCount(2);
            await chunks.started;
            await page.keyboard.press("Control+Comma");
            const text = `Keep the current thread: ${section}, ${submit}`;
            await page.locator("#ta").fill(text);
            if (submit === "Enter") await page.locator("#ta").press("Enter");
            else await page.getByRole("button", { name: "Send message", exact: true }).click();
            await expect(page.locator(".turn.u").last()).toContainText(text);
            await expect(page).toHaveURL(new RegExp(`#thread=${seededThread}$`));
            await capture(page, "same-thread");
          } finally {
            chunks.release();
          }
        });
      }
    }
  });
}

test.describe("deferred first run", () => {
  test.use({ skipFirstRun: false });
  test("BG-02: a delayed first run covers an inert app from its first frame", async ({ page, open }) => {
    const chunks = await holdChunks(page);
    try {
      await observeFirstCover(page);
      await open();
      await chunks.started;
      await expectFirstCover(page);
      await expect(page.locator(".first .fr")).toBeVisible();
      await expect(page.locator(".main")).toHaveAttribute("inert", "");
      await expect(page.locator(".sb").locator("..")).toHaveAttribute("inert", "");
      const before = await page.locator(".first").boundingBox();
      await capture(page, "held");
      await page.locator("#ta").evaluate((el) => el.focus());
      await expect(page.locator("#ta")).not.toBeFocused();
      chunks.release();
      await expect(page.getByRole("heading", { name: "Ready to chat" })).toBeVisible();
      await expect(page.locator(".fr-card")).toBeVisible();
      expect(await page.locator(".first").boundingBox()).toEqual(before);
      await capture(page, "ready");
      await page.getByRole("button", { name: "Start chatting" }).click();
      await waitReady(page);
    } finally {
      chunks.release();
    }
  });
});

test("BG-02: No Server covers the app without waiting for a screen import", async ({ page, open }) => {
  void open;
  const chunks = await holdChunks(page);
  try {
    await observeFirstCover(page);
    await page.goto(WEB_ORIGIN);
    await expectFirstCover(page);
    await expect(page.getByRole("heading", { name: "Gates Local can't find its server" })).toBeVisible();
    await expect(page.locator(".first .fr")).toBeVisible();
    await expect(page.locator(".main")).toHaveAttribute("inert", "");
    await capture(page, "no-server");
    await page.locator("#ta").evaluate((el) => el.focus());
    await expect(page.locator("#ta")).not.toBeFocused();
  } finally {
    chunks.release();
  }
});

test.describe("an old tab after an update", () => {
  test.use({ allowedErrors: [[/Failed to load resource/, /Failed to fetch dynamically imported module/, /Importing a module script failed/], { scope: "test" }] });
  test("a missing Settings chunk offers a plain reload and recovers", async ({ page, open }) => {
    const missing = /\/assets\/(?:screens|Settings)-[^/]+\.js$/;
    await page.route(missing, (route) => route.fulfill({ status: 404, body: "Not found" }));
    await open();
    await waitReady(page);
    await page.keyboard.press("Control+Comma");
    const error = page.getByRole("alert");
    await expect(error).toContainText("This page couldn't load. The app may have updated.");
    await expect(page.locator(".main")).toBeVisible();
    await capture(page, "reload");
    await page.unroute(missing);
    await Promise.all([page.waitForEvent("load"), error.getByRole("button", { name: "Reload", exact: true }).click()]);
    await waitReady(page);
    await page.keyboard.press("Control+Comma");
    await expect(page.getByRole("group", { name: "Theme", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await capture(page, "recovered");
  });

});

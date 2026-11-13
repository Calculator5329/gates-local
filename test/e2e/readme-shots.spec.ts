// The README screenshots (`pnpm shots:readme`): the real client on the real
// server and the fake Ollama, written to docs/screenshots/<name>.png at
// 1280x800, scale 1. Demo content only: the neutral threads of seedReadme
// (test/e2e/seed.ts) and three plain curated models, one of them too big for
// the fixture GPU so the picker shows both verdicts. The clock, time zone and
// seeded threads are pinned, animations are disabled and the caret hidden, so
// a rerun gives the same pixels.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { ROOT } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

/** Thu 2026-11-12 14:00 in Chicago (CST, UTC-6), as in shots.spec.ts. */
const NOW = Date.UTC(2026, 10, 12, 20, 0);
const OUT = process.env["GL_README_SHOTS_DIR"] ?? path.join(ROOT, "docs", "screenshots");
const INSTALLED = ["qwen3.5:9b", "gemma4:12b", "mistral-small3.2:24b"];

interface Shot {
  readonly name: string;
  readonly theme: "dark" | "light";
  /** Open on the seeded thread (default) or on first run. */
  readonly start?: "thread" | "firstrun";
  readonly act?: (page: Page) => Promise<void>;
}

const settings = (label: string) => async (page: Page) => {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
};

const SHOTS: readonly Shot[] = [
  { name: "chat", theme: "dark" },
  {
    name: "model-picker",
    theme: "dark",
    act: async (p) => {
      await p.locator("#modelBtn").click();
      const picker = p.locator("#picker");
      await expect(picker.locator('.pk-r[aria-disabled="true"]').first()).toBeVisible();
      // every row's verdict has landed
      await expect(picker.locator(".fit-skel, .pk-cost.skel")).toHaveCount(0);
    },
  },
  { name: "first-run", theme: "dark", start: "firstrun" },
  { name: "settings-library", theme: "dark", act: settings("Library") },
  { name: "chat-light", theme: "light" },
];

test.use({ seed: "readme", seedAt: NOW, installed: INSTALLED, timezoneId: "America/Chicago", locale: "en-US", viewport: { width: 1280, height: 800 } });

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const shot of SHOTS) {
  test.describe(shot.name, () => {
    // first run shows only on an empty store, so its shot seeds nothing
    test.use({ colorScheme: shot.theme, skipFirstRun: shot.start !== "firstrun", ...(shot.start === "firstrun" ? { seed: 0 } : {}) });
    // Not a regression test: takes the README screenshots the owner asked for.
    test("shot", async ({ page, open, seededThread }) => {
      await page.clock.setFixedTime(NOW);
      await open(shot.start === "firstrun" ? "" : `#thread=${seededThread ?? ""}`);
      if (shot.start === "firstrun") {
        await expect(page.locator(".first").getByText("Runs on GPU")).toBeVisible();
      } else {
        await waitReady(page);
        // the composer has no fit chip; with an empty draft nothing on screen
        // waits on the fit, so shoot once the model trigger is named and idle
        await expect(page.locator("#modelBtn")).toContainText("Qwen");
        await expect(page.locator("#modelBtn")).not.toHaveAttribute("aria-busy", "true");
      }
      // the app is dark by default; a light shot asks for the light tokens
      if (shot.theme === "light") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await shot.act?.(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${shot.name}.png`), animations: "disabled", caret: "hide" });
    });
  });
}

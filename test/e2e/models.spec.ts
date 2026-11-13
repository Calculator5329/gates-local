// Journey: Settings › Models. The Installed tab lists what is installed, the
// row menu makes another model the default, and the Download tab is the
// download flow as it always was: progress and Cancel download in the row,
// Installed when it is done, and the model then listed under Installed.
// Everything a row owns stays inside that row, at desktop and phone width.
import type { Page } from "@playwright/test";
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: process.env["GL_E2E_RECORD"] || process.env["GL_FLICKER_MEASURE"] ? "on" : "off" });

test("set a default from the row menu, then download a model into the list", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await openModels(page);

  const installedTab = page.getByRole("tab", { name: /^Installed/ });
  await expect(installedTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".mp-row[data-dm]")).toHaveCount(3);
  await expect(page.locator('.mp-row[data-dm="qwen3.5:9b"] .mp-l1 .mp-chip')).toHaveText("Default");

  // another default, from the row menu
  const gemma = page.locator('.mp-row[data-dm="gemma4:12b"]');
  await gemma.getByRole("button", { name: "More for Gemma 4 12B" }).click();
  await page.getByRole("menuitem", { name: "Use as default" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(gemma.locator(".mp-l1 .mp-chip")).toHaveText("Default");
  await expect(page.getByRole("button", { name: /^Default for new chats:/ })).toHaveAccessibleName("Default for new chats: Gemma 4 12B");

  // download one from the Download tab
  await page.getByRole("tab", { name: /^Download/ }).click();
  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  await row.getByRole("button", { name: "Download", exact: true }).click();
  await expect(row.locator(".badge")).toHaveText("Installed", { timeout: 20_000 });

  await expect(installedTab).toContainText("4");
  await installedTab.click();
  await expect(page.locator('.mp-row[data-dm="qwen3.5:4b"]')).toBeVisible();
});

// The first save of a default is answered with a failure; everything else reaches the server.
const refuseFirstDefaultSave = async (page: Page) => {
  let refused = 0;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === "string" ? (JSON.parse(m) as { type?: string; method?: string; id?: string }) : undefined;
      if (f?.type === "request" && f.method === "settings.update" && m.toString().includes("defaultModel") && refused++ === 0) {
        ws.send(JSON.stringify({ type: "response", id: f.id, ok: false, error: { code: "internal", message: "test: refused by the tap" } }));
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
};

test("a note about a default that was since saved does not come back with a later removal", async ({ page, open }) => {
  await refuseFirstDefaultSave(page);
  await open();
  await waitReady(page);
  await openModels(page);

  // the Remove confirm, inside the Models pop-up (itself a dialog)
  const dialog = page.getByRole("dialog", { name: /^Remove / });
  const note = page.locator(".mp").getByRole("alert");
  await page.getByRole("button", { name: "More for Qwen 3.5 9B" }).click();
  await page.getByRole("menuitem", { name: /^Remove…/ }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(note).toContainText("Qwen 3.5 9B was removed");
  await page.getByRole("button", { name: /^Default for new chats:/ }).click();
  await page.getByRole("option", { name: /Gemma 4 12B/ }).click();
  await expect(note).toHaveCount(0);

  // removing every model that can chat clears the default with no failure at all
  const more = page.locator(".mp-row:not(.emb)").getByRole("button", { name: /^More for/ });
  while ((await more.count()) > 0) {
    await more.first().click();
    await page.getByRole("menuitem", { name: /^Remove…/ }).click();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(note).toHaveCount(0);
});

test("the remove dialog stays until its removal has finished", async ({ page, open }) => {
  let held: (() => void) | undefined;
  await page.routeWebSocket(/127\.0\.0\.1:5286/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (m.toString().includes('"models.remove"')) {
        held = () => server.send(m);
        return;
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await open();
  await waitReady(page);
  await openModels(page);

  await page.getByRole("button", { name: "More for Qwen 3.5 9B" }).click();
  await page.getByRole("menuitem", { name: /^Remove…/ }).click();
  const dialog = page.getByRole("dialog", { name: /^Remove / });
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect.poll(() => held !== undefined).toBe(true);

  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".mp")).toBeVisible();

  held?.();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.mp-row[data-dm="qwen3.5:9b"]')).toHaveCount(0);
});

test("a removal that worked stays done when the new default cannot be saved", async ({ page, open }) => {
  await refuseFirstDefaultSave(page);
  await open();
  await waitReady(page);
  await openModels(page);

  await page.getByRole("button", { name: "More for Qwen 3.5 9B" }).click();
  await page.getByRole("menuitem", { name: /^Remove…/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();

  // the dialog is finished, the row is gone, and the page says what is left to do
  await expect(page.getByRole("dialog", { name: /^Remove / })).toHaveCount(0);
  await expect(page.locator('.mp-row[data-dm="qwen3.5:9b"]')).toHaveCount(0);
  const note = page.locator(".mp").getByRole("alert");
  await expect(note).toContainText("Qwen 3.5 9B was removed");

  // choosing a default settles it
  await page.getByRole("button", { name: /^Default for new chats:/ }).click();
  await page.getByRole("option", { name: /Gemma 4 12B/ }).click();
  await expect(page.locator('.mp-row[data-dm="gemma4:12b"] .mp-l1 .mp-chip')).toHaveText("Default");
  await expect(note).toHaveCount(0);
});

test("a running download shows its detail in the row and on Installed, and Cancel download puts it back", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await stack.scenario("models", { pullTickMs: 1000, pullChunkBytes: 100 * 1024 ** 2 });
  await openModels(page);
  await page.getByRole("tab", { name: /^Download/ }).click();

  const row = page.locator('.dlrow[data-cat="qwen3.5:4b"]');
  await row.getByRole("button", { name: "Download", exact: true }).click();
  // \s: a number stays on the line with its unit (a no-break space)
  const line = /^[\d.]+ of [\d.]+\sGB · \d+\sMB\/s · about .+ left$/;
  await expect(row.locator(".prog-l span")).toHaveText(line, { timeout: 15_000 });
  await expect(row.getByRole("progressbar", { name: "Qwen 3.5 4B download" })).toBeVisible();

  // Installed keeps showing it with its own Cancel download
  await page.getByRole("tab", { name: /^Installed/ }).click();
  const running = page.locator('.mp-row.mp-dling[data-pull="qwen3.5:4b"]');
  await expect(running.locator(".prog-l span")).toHaveText(line);
  await expect(running.getByRole("button", { name: "Cancel download" })).toBeVisible();

  await page.getByRole("tab", { name: /^Download/ }).click();
  await row.getByRole("button", { name: "Cancel download" }).click();
  await expect(row.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expect(row.locator(".prog")).toHaveCount(0);
});

for (const width of [1280, 360]) {
  test.describe(`at ${width} px`, () => {
    test.use({ scenario: "embed-smallest", viewport: { width, height: 800 } });

    test("each installed row keeps its actions control inside the row and does not overflow", async ({ page, open }, info) => {
      await open();
      await waitReady(page);
      await openModels(page);
      const rows = page.locator(".mp-row[data-dm], .mp-row[data-em]");
      await expect(rows).toHaveCount(4);
      // Catalog hydration replaces raw tags with friendly names before we capture them.
      await expect(page.getByRole("button", { name: "More for Qwen 3.5 9B", exact: true })).toHaveCount(1);

      for (const row of await rows.all()) {
        const label = await row.getAttribute("aria-label");
        // found page-wide on purpose: a control moved out of its row must fail on where it is, not on not being found
        const control = page.getByRole("button", { name: `More for ${label}`, exact: true });
        const r = await row.boundingBox();
        const c = await control.boundingBox();
        if (r === null || c === null) throw new Error(`${label}: no box for the row or its actions control`);
        expect(c.y, `${label}: control top inside the row`).toBeGreaterThanOrEqual(r.y);
        expect(c.y + c.height, `${label}: control bottom inside the row`).toBeLessThanOrEqual(r.y + r.height);
        expect(c.x, `${label}: control left inside the row`).toBeGreaterThanOrEqual(r.x);
        expect(c.x + c.width, `${label}: control right inside the row`).toBeLessThanOrEqual(r.x + r.width);
        const { scroll, client } = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        expect(scroll, `${label}: row content fits the row`).toBeLessThanOrEqual(client);
        expect(r.x + r.width, `${label}: row inside the window`).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: info.outputPath("models.png"), animations: "disabled" });
    });
  });
}

// Journeys: an action that fails says so beside the control that ran it, in
// one calm sentence, and a form keeps what was typed until the action works
// (W-07): a Library add with a wrong path, then a settings save and a model
// removal while the server is restarting.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { CHECKOUT_CACHE } from "./env.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

const section = async (page: Page, label: string) => {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
};

/** No "!", no "Oops": one sentence that ends in a full stop. */
const calm = (text: string | null) => {
  expect(text).not.toMatch(/!|oops/i);
  expect(text?.trim()).toMatch(/^Couldn't [^.]+\.$/);
};

test("a Library add with a wrong path keeps the form, says why, and works once the path is right", async ({ page, open }) => {
  const real = path.join(CHECKOUT_CACHE, "e2e-library", "notes");
  mkdirSync(real, { recursive: true });
  const wrong = path.join(CHECKOUT_CACHE, "e2e-library", "not-there");
  await open();
  await waitReady(page);
  await section(page, "Library");
  await page.getByRole("button", { name: "Add folder…" }).click();
  const input = page.getByRole("textbox", { name: "Add a folder path" });
  await input.fill(wrong);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Couldn't add this folder because nothing is at that path; check it and try again.");
  calm(await alert.textContent());
  await expect(input).toHaveValue(wrong);

  await input.fill(real);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(input).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // the new source's row, by its label (the folder name), with its own actions
  await expect(page.locator(".srow", { has: page.locator(".badge", { hasText: "read-only" }) }).locator(".sl b")).toHaveText("notes");
});

test.describe("while the server is down", () => {
  // the browser logs each refused WebSocket attempt while the server is down
  test.use({ allowedErrors: [/WebSocket connection to .* failed/] });

  test("a theme save and a model removal each say they couldn't, and nothing changes", async ({ page, open }) => {
    await open();
    await waitReady(page);
    await section(page, "General");
    const theme = page.getByRole("group", { name: "Theme" });
    await expect(theme.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

    const restart = stack.restart(4000);
    // Settings has no banner; the sidebar footer says it
    await expect(page.locator(".sb-foot .rt")).toContainText("Reconnecting");
    await theme.getByRole("button", { name: "Light" }).click();
    const saved = page.getByRole("alert");
    await expect(saved).toHaveText("Couldn't save the theme because Gates Local isn't connected; try again once it reconnects.");
    calm(await saved.textContent());
    await expect(theme.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

    await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
    const remove = page.getByRole("button", { name: /^Remove / }).first();
    const label = (await remove.getAttribute("aria-label")) ?? "";
    await remove.click();
    const removed = page.getByRole("alert");
    await expect(removed).toHaveText(/^Couldn't remove \S+ because Gates Local isn't connected; try again once it reconnects\.$/);
    calm(await removed.textContent());
    await restart;
    // back online (a healthy runtime has no footer row, and only the runtime row has a dot), the model is still there
    await expect(page.locator(".sb-foot .rt .dot")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole("button", { name: label })).toHaveCount(1);
  });
});

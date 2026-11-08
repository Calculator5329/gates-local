/// <reference lib="dom" />
// Journeys from Ethan's second pass: a long model name never pushes the
// composer's controls out, an 8k context, a toolbar that holds still while a
// model loads, and the thread menu on right-click with GPU memory in it.
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

test("the picker offers 8k; an 8k turn sends num_ctx 8192", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.locator("#modelBtn").click();
  const ctx = page.locator("#picker").getByRole("radiogroup", { name: "Context" });
  await expect(ctx.getByRole("radio")).toHaveText(["8k", "16k", "32k", "64k"]);
  // the default stays 16k
  await expect(ctx.getByRole("radio", { name: "16k" })).toHaveAttribute("aria-checked", "true");
  await ctx.getByRole("radio", { name: "8k" }).click();
  await expect(ctx.getByRole("radio", { name: "8k" })).toHaveAttribute("aria-checked", "true");
  await expect(ctx.getByRole("radio", { name: "8k" }).locator(".vd.gpu")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await sendMessage(page, "A small context");
  await expect(page.locator(".turn.a").last()).toHaveClass(/\bdone\b/, { timeout: 15_000 });
  const state = (await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { requests: { path: string; body: { options?: { num_ctx?: number } } }[] };
  expect(state.requests.findLast((r) => r.path === "/api/chat")?.body.options?.num_ctx).toBe(8192);
});

test("Settings > Models offers 8k as the default context", async ({ page, open }) => {
  await open();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  const seg = page.locator(".set").getByRole("group", { name: "Context window" });
  await expect(seg.getByRole("button")).toHaveText(["8k", "16k", "32k", "64k"]);
  await seg.getByRole("button", { name: "8k" }).click();
  await expect(seg.getByRole("button", { name: "8k" })).toHaveAttribute("aria-pressed", "true");
  // the saved default survives a reload
  await page.reload();
  await waitReady(page);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.locator(".set").getByRole("group", { name: "Context window" }).getByRole("button", { name: "8k" })).toHaveAttribute("aria-pressed", "true");
});

/// <reference lib="dom" />
import { expect, test, waitReady } from "./fixtures.ts";

test.use({ seed: "design", video: "on" });

test("failed thread actions keep the saved title, conversation and row position", async ({ page, open, seededThread }, testInfo) => {
  const refused = new Set(["threads.rename", "threads.delete"]);
  await page.routeWebSocket(/.*/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(frame => {
      const request = JSON.parse(String(frame)) as { type?: string; id?: string; method?: string };
      if (request.type === "request" && refused.has(request.method ?? "")) {
        ws.send(JSON.stringify({ type: "response", id: request.id, ok: false, error: { code: "internal", message: "action refused" } }));
      } else server.send(frame);
    });
    server.onMessage(frame => ws.send(frame));
  });
  await open(`#thread=${seededThread ?? ""}`);
  await waitReady(page);
  const title = "Library: Effect Schema books";
  const row = page.locator(".sb-row").filter({ has: page.locator(".t", { hasText: title }) });
  await expect(page.locator(".hdr h2")).toHaveText(title);
  const before = await row.boundingBox();
  const ids = await page.locator(".sb-row").evaluateAll(rows => rows.map(element => element.getAttribute("data-thread")));
  await page.screenshot({ path: testInfo.outputPath("before.png") });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Thread title" });
  await input.fill("An unsaved title");
  await input.press("Enter");
  await expect.soft(page.locator(".c-note")).toHaveText("Couldn't rename this conversation because Gates Local refused it (action refused); try again.");
  await expect(page.locator(".hdr h2")).toHaveText(title);
  await expect(row).toBeVisible();
  expect(await row.boundingBox()).toEqual(before);

  refused.delete("threads.rename");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await input.fill("Saved title");
  await input.press("Enter");
  await expect(page.locator(".hdr h2")).toHaveText("Saved title");
  await expect.soft(page.locator(".c-note")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("after-rename-retry.png") });
  const renamed = page.locator(".sb-row").filter({ hasText: "Saved title" });
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete thread", exact: true }).click();
  await expect.soft(page.locator(".c-note")).toHaveText("Couldn't delete this conversation because Gates Local refused it (action refused); try again.");
  await expect.soft(renamed).toBeVisible();
  expect.soft(await page.locator(".sb-row").evaluateAll(rows => rows.map(element => element.getAttribute("data-thread")))).toEqual(ids);
  expect(await renamed.boundingBox()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath("after-failed-delete.png") });

  refused.clear();
  await renamed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete thread", exact: true }).click();
  await expect(renamed).toHaveCount(0);
  await expect(page.locator(".c-note")).toHaveCount(0);
  await page.reload();
  await waitReady(page);
  await expect(renamed).toHaveCount(0);
});

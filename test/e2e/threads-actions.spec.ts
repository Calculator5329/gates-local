import { readFile } from "node:fs/promises";
import { expect, test, waitReady } from "./fixtures.ts";
import { INSTALLED, SMALL, configure, finished, release, start, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure" });

test("rename and export while streaming preserve the running request and its final words", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.locator(".sb-row.on .t").hover();
  await page.locator(".sb-row.on .sb-menu").click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Thread title" }).fill("Renamed while running");
  await page.getByRole("textbox", { name: "Thread title" }).press("Enter");
  await expect(page.locator(".sb-row.on")).toContainText("Renamed while running");
  await page.locator(".sb-row.on .t").hover();
  await page.locator(".sb-row.on .sb-menu").click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export as Markdown" }).click();
  const download = await downloading;
  const file = await download.path();
  expect(file).not.toBeNull();
  const text = await readFile(file ?? "", "utf8");
  expect(text).toContain("# Renamed while running"); expect(text).toContain("alpha");
  // Export is of saved messages; the in-flight answer has not been saved yet.
  expect(text).not.toContain("Reply 1 for alpha");
  expect((await state()).turns).toHaveLength(1);
  expect((await state()).turns[0]?.endedAt).toBeUndefined();
  await release("alpha"); await finished(page, "alpha");
});

test("delete a running thread cancels only its request and never sends its queued message", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.locator("#ta").fill("must not send"); await page.locator("#ta").press("Enter");
  await expect(page.locator(".qt-r")).toHaveCount(1);
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta", SMALL[1]); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.locator(".sb-row", { hasText: "alpha" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await expect(page.locator(".sb-row", { hasText: "alpha" })).toHaveCount(0);
  await expect.poll(async () => (await state()).turns[0]?.outcome).toBe("cancelled");
  expect((await state()).turns[1]?.endedAt).toBeUndefined();
  await page.locator(".sb-row", { hasText: "beta" }).click();
  await release("beta"); await finished(page, "beta");
  expect((await state()).turns.map((t) => t.prompt)).toEqual(["alpha", "beta"]);
});

test("Retry after returning to a stopped thread leaves the other thread running", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta", SMALL[1]); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.locator(".sb-row", { hasText: "alpha" }).click();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await expect.poll(async () => (await state()).turns.filter((t) => t.prompt === "alpha").length).toBe(2);
  await expect(page.locator(".turn.a:not(.done) .md p")).toHaveCount(3);
  expect((await state()).turns.find((t) => t.prompt === "beta")?.endedAt).toBeUndefined();
  // Regenerate from an interrupted row replaces the stopped partial.
  await release("alpha"); await finished(page, "alpha");
  await expect(page.locator(".turn.a.interrupted")).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(1);
  await page.locator(".sb-row", { hasText: "beta" }).click();
  await release("beta"); await finished(page, "beta");
});

test("runtime switch while two threads run stops both with their partial words and a reason", async ({ page, open }) => {
  await open(); await waitReady(page);
  await configure({ holdAfterTokens: 28 });
  await start(page, "alpha"); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.getByRole("button", { name: "New thread" }).click();
  await start(page, "beta", SMALL[1]); await expect(page.locator(".turn.a .md p")).toHaveCount(3);
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: "Runtime", exact: true }).click();
  await page.getByRole("button", { name: "Use Gates Local's Ollama", exact: true }).click();
  await expect(page.getByRole("group", { name: "Confirm switch" })).toContainText(/model in use/i);
  // The E2E stack pins both runtime addresses to the fake and disables install
  // and start. This changes the real server's runtime mode, never a real service.
  await page.getByRole("button", { name: "Install and switch", exact: true }).click();
  await expect.poll(async () => (await state()).turns.every((t) => t.outcome === "cancelled")).toBe(true);
  await page.getByRole("button", { name: "Back to chat", exact: true }).click();
  for (const prompt of ["alpha", "beta"]) {
    await page.locator(".sb-row", { hasText: prompt }).click();
    await expect(page.locator(".stop-note")).toHaveText("Stopped when the Ollama runtime changed. Its text is kept here and excluded from later model prompts.");
    await expect(page.locator(".turn.a.interrupted .md")).toContainText(`Reply 1 for ${prompt}.`);
  }
  expect((await state()).turns).toHaveLength(2);
});

/// <reference lib="dom" />
// Settings row 13 (owner 2026-11-13: "All of these work and are hooked in right?"): the Library
// says only what is true. It reaches a chat only while Tools are on, and a cloned repository is a
// copy made once, not a folder the model sees change.
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { createClient } from "@gates-local/contracts";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

async function section(page: Page, label: string) {
  if (!(await page.locator(".snav").isVisible())) await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator(".set h1").first()).toHaveText(label);
}

/** Back to the chat, ask the fake model to use a tool on the source named `label`; the reply quotes what the tool returned (fake-ollama libraryRead). */
async function askAbout(page: Page, label: string) {
  await page.keyboard.press("Escape"); await waitReady(page);
  await sendMessage(page, `Use a tool to look in ${label}`);
  return page.locator(".turn.a").last();
}

/** Clone the fixture repository from Settings › Library; resolves to its label. */
async function cloneDocs(page: Page) {
  await section(page, "Library");
  await page.getByRole("textbox", { name: "Public GitHub repository URL" }).fill("https://github.com/example/docs");
  await page.getByRole("button", { name: "Clone", exact: true }).click();
  const row = page.locator(".srow", { hasText: "Copied from example/docs" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  return (await row.locator("b").innerText()).trim();
}

// Item 4: every kind the Library holds reaches the model, and the answer uses what it read.
test.describe("the model reads each kind of Library source and the reply uses it", () => {
  test.skip(process.platform !== "linux", "a database is read with the Linux shell tool");

  test("a sample database", async ({ page, open }) => {
    await open(); await waitReady(page);
    await section(page, "Library");
    const row = page.locator('[data-db="sample:chinook"]');
    await row.locator(".fill-btn").click();
    await expect(row.getByRole("button", { name: "Remove Chinook" })).toBeVisible({ timeout: 15_000 });
    const reply = await askAbout(page, "Chinook");
    await expect(reply).toContainText("From Chinook:", { timeout: 15_000 });
    await expect(reply).toContainText("albums");
  });

  test("a database of your own", async ({ page, open }, info) => {
    const file = info.outputPath("planets.db");
    const db = new DatabaseSync(file); db.exec("CREATE TABLE planets (name TEXT); INSERT INTO planets VALUES ('Mars');"); db.close();
    await open(); await waitReady(page);
    const server = new URL(page.url()).searchParams.get("server");
    if (!server) throw new Error("No test server URL");
    const client = createClient(new WebSocket(server));
    try { await client.call("sources.add", { kind: "sqlite", path: file, label: "Planets" }); } finally { client.close(); }
    await section(page, "Library");
    await expect(page.locator(".srow", { hasText: "Planets" })).toBeVisible();
    const reply = await askAbout(page, "Planets");
    await expect(reply).toContainText("From Planets:", { timeout: 15_000 });
    await expect(reply).toContainText("planets");
  });

  test("a cloned repository", async ({ page, open }) => {
    await open(); await waitReady(page);
    const label = await cloneDocs(page);
    const reply = await askAbout(page, label);
    await expect(reply).toContainText(`From ${label}:`, { timeout: 15_000 });
    await expect(reply).toContainText("A small public documentation fixture");
  });
});

test("the Library's head says nothing while Tools are on, and plainly when they are off", async ({ page, open }) => {
  await open(); await waitReady(page);
  await section(page, "Library");
  const head = page.locator(".set-h p");
  // the old subtitle said "every chat", which was false with Tools off (audit W07/M04: no subtitle at all)
  await expect(head).toHaveCount(0);
  await section(page, "Tools");
  const master = page.getByRole("switch", { name: "Let the model use tools" });
  await master.click(); await expect(master).toHaveAttribute("aria-checked", "false");
  await section(page, "Library");
  await expect(head).toContainText("Tools are off, so no chat reads these.");
  await head.getByRole("button", { name: "Turn on Tools" }).click();
  await expect(page.locator(".set h1").first()).toHaveText("Tools");
  await expect(master).toHaveAttribute("aria-checked", "false");
});

test("a cloned repository says it is a copy, from where and when, apart from the folders the model sees change", async ({ page, open }) => {
  await open(); await waitReady(page);
  await section(page, "Library");
  await page.getByRole("textbox", { name: "Public GitHub repository URL" }).fill("https://github.com/example/docs");
  await page.getByRole("button", { name: "Clone", exact: true }).click();
  const when = await page.evaluate(() => new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const copy = page.locator(".srow", { hasText: `Copied from example/docs on ${when}` });
  await expect(copy).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".set")).not.toContainText("Public GitHub repository");
  // the copy's row says it is there; the URL row does not say it again
  await expect(page.getByText("Ready in Library")).toHaveCount(0);
  // the folders' group, which the model sees change, does not hold it
  const folders = page.locator(".grp", { has: page.getByText("Files and folders", { exact: true }) });
  await expect(folders.locator(".srow", { hasText: "Copied from" })).toHaveCount(0);
});

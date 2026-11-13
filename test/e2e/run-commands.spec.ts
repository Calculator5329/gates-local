/// <reference lib="dom" />
// Journey (settings row 14, 2026-11-13): Settings › Tools said Run commands "Ready" with Tools
// on, but no command ran. Ready now follows the server's sandbox probe, a real command run in
// the sandbox. Here the stand-in machine has no systemd user session, so the probe fails:
// Settings names what is missing, the model is not offered the shell, and the chat says why the
// Library's database went unread.
import type { Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, test, waitReady } from "./fixtures.ts";

type ChatBody = { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] };
async function chatBodies(): Promise<ChatBody[]> {
  const state = await (await fetch(`${FAKE_URL}/__fake/state`)).json() as { requests: { path: string; body: ChatBody }[] };
  // Only the tool turn's requests: a title request carries no tools.
  return state.requests.filter(r => r.path === "/api/chat" && r.body.tools !== undefined).map(r => r.body);
}

/** Open a Settings section by the nav (desktop width). */
async function section(page: Page, label: string) {
  await page.keyboard.press("Control+Comma");
  await page.locator(".snav").getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator(".set h1").first()).toHaveText(label);
}

/** Download the Chinook sample into the Library (the fixture file has one table). */
async function addSample(page: Page) {
  await section(page, "Library");
  const row = page.locator('[data-db="sample:chinook"]');
  await row.locator(".fill-btn").click();
  await expect(row.getByRole("button", { name: "Remove Chinook" })).toBeVisible({ timeout: 15_000 });
  return row;
}

test.skip(process.platform !== "linux", "Run commands is the Linux shell tool");

test.describe("with no working sandbox on this machine", () => {
  test.use({ sandbox: "off" });

  test("Run commands says what is missing, the model gets no shell, and the chat says why", async ({ page, open }) => {
    await open();
    await waitReady(page);
    const row = await addSample(page);
    await section(page, "Tools");
    const run = page.locator(".set").locator(".srow", { hasText: "Run commands" });
    await expect(run).toContainText("Needs a systemd user session");
    await expect(run).not.toContainText("Ready");
    await expect(run).toHaveClass(/\bdim\b/);

    // A question about the database: the turn goes with tools, but not the shell.
    await section(page, "Library");
    await row.locator(".db-open").click();
    await row.locator(".db-q").first().click();
    const reply = page.locator(".turn.a").last();
    await expect(reply).toContainText("Run commands is off on this machine (needs a systemd user session), so databases in your Library can't be read");
    const body = (await chatBodies()).at(-1)!;
    expect(body.tools?.map(t => t.function.name)).toEqual(["read"]);
    expect(body.messages[0]!.content).toContain("Run commands is off on this machine");
  });
});

test("with a working sandbox, Run commands is Ready and the model gets the shell", async ({ page, open }) => {
  await open();
  await waitReady(page);
  const row = await addSample(page);
  await section(page, "Tools");
  await expect(page.locator(".set").locator(".srow", { hasText: "Run commands" })).toContainText("Ready");
  await section(page, "Library");
  await row.locator(".db-open").click();
  await row.locator(".db-q").first().click();
  await expect(page.locator(".turn.a").last()).toBeVisible();
  await expect.poll(async () => (await chatBodies()).at(-1)?.tools?.map(t => t.function.name)).toEqual(["read", "shell"]);
  await expect(page.locator(".turn.a").last()).not.toContainText("Run commands is off");
});

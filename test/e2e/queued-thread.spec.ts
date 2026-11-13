/// <reference lib="dom" />
// Chat row 23, a bug that happened (2026-11-13): thread A was replying on a crowded GPU; the
// owner sent a message in a new thread B. The server admits B's reply only once A's cold load
// lets go of the load gate, and saved B's question 3 min 7 s after B was made. The client gave
// chat.send the 30 s every call gets, dropped B's send and later met it again as a stranger's
// reply. The owner: "tool call does not show during it only shows after. queued thread didn't
// work and working one did not stay most recent".
import { writeFile } from "node:fs/promises";
import { createClient } from "@gates-local/contracts";
import type { Page, TestInfo } from "@playwright/test";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";
import { INSTALLED, configure, finished, pick, release, shot, state } from "./threads-support.ts";

test.use({ installed: INSTALLED, screenshot: "only-on-failure" });

/** A Library file and tools on, so the fake model is offered a tool to call (its read of ~/docs fails). */
async function libraryOn(page: Page, info: TestInfo): Promise<void> {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  const file = info.outputPath("notes.md");
  await writeFile(file, "# Notes\n\nNothing to see.\n");
  await client.call("sources.add", { kind: "file", path: file });
  await client.call("settings.update", { tools: true });
}

const B = "Use a tool for beta";
const MODEL = "gemma4:12b";
const rows = (page: Page) => page.locator(".sb-row").allInnerTexts();

// Guards a shipped bug fix (chat row 23): a send that waited past 30 s behind another reply was dropped.
test("a new thread's send that waits over 30 s behind another reply stays sent, sits under it, and shows its tool call live", async ({ page, open }, info) => {
  test.setTimeout(150_000);
  await open(); await waitReady(page);
  await libraryOn(page, info);
  // picking warms the model; configure then empties the fake GPU, so A's send is a cold load,
  // which holds the load gate until A's first token, 45 s away. B takes the same model, one
  // the fake offers native tool calls.
  await pick(page, MODEL);
  await expect.poll(async () => (await state()).loaded.map((m) => m.name)).toContain(MODEL);
  await configure({ prompts: { alpha: { firstTokenDelayMs: 45_000 }, [B]: { toolCalls: 1, quietToolRounds: 1, holdAfterTokens: 5 } } });
  await sendMessage(page, "alpha");
  await expect.poll(async () => (await state()).turns.some((t) => t.prompt === "alpha")).toBe(true);
  await page.getByRole("button", { name: "New thread" }).click();
  await sendMessage(page, B);
  // the thread at work stays on top; the new one waits under it
  // soft: a wrong order still lets the 30 s part below be seen
  await expect.soft.poll(async () => (await rows(page)).map((r) => r.split("\n")[0])).toEqual(["alpha", B]);
  await expect(page.locator(".sb-row", { hasText: B }).locator(".live")).toHaveCount(1);
  // past the 30 s every other call gets: still sent, nothing said, the composer still empty
  await page.waitForTimeout(33_000);
  await expect(page.locator(".c-note")).toHaveCount(0);
  await expect(page.locator("#ta")).toHaveValue("");
  expect.soft((await rows(page)).map((r) => r.split("\n")[0])).toEqual(["alpha", B]);
  expect((await state()).turns.some((t) => t.prompt === B), "B's send is still waiting to be admitted").toBe(false);
  await shot(page, "queued-thread-waiting");
  // A's first token opens the gate; B's call shows while its reply is still being written
  const reply = page.locator(".turn.a").last();
  await expect(reply.locator("button.think")).toHaveAccessibleName(/1 tool call\b/, { timeout: 30_000 });
  // the round after the call, still being written
  expect((await state()).turns.findLast((t) => t.prompt === B)?.endedAt).toBeUndefined();
  await shot(page, "queued-thread-tool-live");
  await release(B);
  await finished(page, B);
  await expect(page.locator(".c-note")).toHaveCount(0);
  await expect(page.locator(".turn.u")).toHaveCount(1);
});

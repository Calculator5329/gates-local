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
const loaded = async () => (await state()).loaded.map((m) => m.name);

// Guards a shipped bug fix (chat row 23): a send that waited past 30 s behind another reply was dropped.
test("a new thread's send that waits over 30 s behind another reply stays sent, sits under it, and shows its tool call live", async ({ page, open }, info) => {
  test.setTimeout(150_000);
  await open(); await waitReady(page);
  await libraryOn(page, info);
  // A's send has to be a cold load: that is what holds the load gate until A's first token,
  // 45 s away. Picking warms the model, and so does the first key typed (chat row 39), at most
  // once a minute for a model. So A's words go in first, and the fake GPU is emptied once that
  // load has landed: nothing loads the model again before the send. B takes the same model, one
  // the fake offers native tool calls.
  const scenario = { prompts: { alpha: { firstTokenDelayMs: 45_000 }, [B]: { toolCalls: 1, quietToolRounds: 1, holdAfterTokens: 5 } } };
  await pick(page, MODEL);
  await expect.poll(loaded).toContain(MODEL);
  await configure(scenario);
  await page.locator("#ta").fill("alpha");
  await expect.poll(loaded, "the first key typed loads the model").toContain(MODEL);
  await configure(scenario);
  expect(await loaded(), "the send finds the fake GPU empty").not.toContain(MODEL);
  await page.locator("#ta").press("Enter");
  await expect.poll(async () => (await state()).turns.some((t) => t.prompt === "alpha")).toBe(true);
  await page.getByTestId("sidebar.top.new-thread").click();
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

const THINKER = "qwen3.5:9b";
/** The running reply's live line. */
const live = (page: Page) => page.locator(".turn.a").last().locator(".think.run");
/** The whole seconds on the live line. */
const liveSecs = async (page: Page) => Number.parseInt(await live(page).locator(".lv-t").innerText(), 10);
/** What a window says about the chat: the question asked, the reply's stage, and each waiting row with its state. */
const said = async (page: Page) => ({
  asked: await page.locator(".turn.u .bubble").allInnerTexts(),
  stage: (await live(page).locator(".lv-w").innerText()).trim(),
  waiting: await page.locator(".qt-r").evaluateAll((trays) => trays.map((r) => [r.querySelector(".qt-t")?.textContent ?? "", r.querySelector(".qt-s")?.textContent ?? ""])),
});
const SAID = { asked: ["alpha"], stage: "Thinking", waiting: [["beta", ""], ["gamma", "On hold"]] };

// Guards the reload rule: a reload and a second window read the reply and the waiting messages from the server's records, with no new word needed.
test("a thinking reply and two waiting messages, one on hold, read the same after a reload and in a second window", async ({ page, open, context }) => {
  test.setTimeout(90_000);
  await open(); await waitReady(page);
  await pick(page, THINKER);
  // the model stops inside its thinking and stays there: nothing new arrives until the release below
  await configure({ holdThinkingAfterTokens: 6 });
  await sendMessage(page, "alpha");
  await expect(live(page).locator(".lv-w")).toHaveText("Thinking");
  await sendMessage(page, "beta");
  await expect(page.locator(".qt-r")).toHaveCount(1);
  await sendMessage(page, "gamma");
  await expect(page.locator(".qt-r")).toHaveCount(2);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  const gamma = (await client.call("queue.list", {})).find((q) => q.text === "gamma");
  if (gamma === undefined) throw new Error("gamma is not waiting on the server");
  expect((await client.call("reply.hold", { id: gamma.id })).answer).toBe("done");
  await expect.poll(() => said(page)).toEqual(SAID);
  // a clock that has run a while, so one that starts again from nothing after the reload is seen
  await expect.poll(() => liveSecs(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  const before = await liveSecs(page);
  const words = (await state()).turns.find((t) => t.prompt === "alpha");

  await page.reload(); await waitReady(page);
  await expect.poll(() => said(page), "the reloaded window").toEqual(SAID);
  expect(await liveSecs(page), "the clock went on from the server's time").toBeGreaterThanOrEqual(before);

  const other = await context.newPage();
  await other.goto(page.url());
  await waitReady(other);
  await expect.poll(() => said(other), "a second window").toEqual(SAID);
  await expect.poll(async () => Math.abs((await liveSecs(other)) - (await liveSecs(page))), "both windows show the same seconds").toBeLessThanOrEqual(1);
  expect(await liveSecs(other)).toBeGreaterThanOrEqual(before);
  expect((await state()).turns.find((t) => t.prompt === "alpha"), "the model said nothing new in between").toEqual(words);

  // both windows still follow the reply to its end
  await release("alpha");
  await expect(page.locator(".turn.a").first()).toHaveClass(/\bdone\b/, { timeout: 30_000 });
  await expect(other.locator(".turn.a").first()).toHaveClass(/\bdone\b/, { timeout: 30_000 });
  await other.close();
});

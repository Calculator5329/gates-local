// The owner's rulings of 2026-11-20 on watching a Measure run: the run is a chat in the chat pane,
// each check a question whose answer streams as plain text and is drawn as markdown once it is
// whole, its grade line only after; a pinned sidebar row while it goes; Stop keeps no score; a
// score opens its run's chat, finished, with the parts table on top, and so does an old measure
// that has no chat kept.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelMeasure } from "@gates-local/contracts";
import { CASES } from "../../apps/server/src/measure/cases.ts";
import { WRONG } from "../fake-ollama/measure-reply.ts";
import { findFakeModel } from "../fake-ollama/models.ts";
import { CONTROL_URL, FAKE_URL } from "./env.ts";
import { expect, openModels, stack, test, waitReady } from "./fixtures.ts";

const INSTALLED = ["qwen3.5:9b", "gemma4:12b"];
// why: the fake holds the run's first answer of more than a word after its first word (measureHold)
const HELD = CASES.map((c) => ({ id: c.id, answer: WRONG[c.id] ?? c.reference.answer })).find((c) => (c.answer.match(/\s*\S+/g) ?? []).length > 1)!;

// why: the oldest kind of measure: no version, eight checks of tools and a database, no chat kept
const oldMeasure = (): ModelMeasure => ({
  model: "gemma4:12b", digest: findFakeModel("gemma4:12b")!.digest, at: Date.UTC(2026, 6, 1), numCtx: 4096, tokensPerSecond: 31.5, score: 75,
  checks: [
    { id: "tools-none", kind: "tools", ok: true, needs: "391, with no tool call", reply: "391", tokens: 4, ms: 900 },
    { id: "tools-read", kind: "tools", ok: true, reply: "The first item is to water the ferns.", calls: ['read {"path":"~/notes/todo.txt"} → water the ferns'] },
    { id: "tools-list", kind: "tools", ok: true, reply: "There are four files." },
    { id: "tools-write", kind: "tools", ok: false, why: "Wrote nothing.", reply: "Done." },
    { id: "sql-count", kind: "sql", ok: true, reply: "12 orders." },
    { id: "sql-top", kind: "sql", ok: true, reply: "Mara Lind spent the most." },
    { id: "sql-sum", kind: "sql", ok: true, reply: "The total is 310." },
    { id: "sql-join", kind: "sql", ok: false, why: "Named the wrong city.", reply: "Oslo." },
  ],
});

/** A fresh stack with the old measure on disk, as a build before kept chats left it. */
async function resetWithOldMeasure(): Promise<void> {
  const r = await fetch(`${CONTROL_URL}/reset`, { method: "POST", body: JSON.stringify({ scenario: "measure", installed: INSTALLED, loadDelayMs: 3000, measureHold: 1 }) });
  if (!r.ok) throw new Error(`reset: ${r.status} ${await r.text()}`);
  const { dataDir } = (await r.json()) as { dataDir: string };
  writeFileSync(path.join(dataDir, "measures.json"), JSON.stringify({ version: 1, measures: [oldMeasure()] }));
}

test("a Measure run is a chat you watch, Stop keeps no score, and a score opens its finished chat, an old one too", async ({ page, open }, info) => {
  test.setTimeout(120_000);
  test.info().annotations.push({ type: "budget", description: "the fake holds the model's load for 3 s twice, so the run is seen loading and stopped, and one run goes to the end between" });
  await resetWithOldMeasure();
  await open();
  await waitReady(page);
  await openModels(page);
  const chat = page.getByTestId("measure.chat");
  const strip = page.getByTestId("measure.chat.strip");
  const pinned = page.getByTestId("sidebar.measure.open");
  const score = page.getByTestId("settings.models.score-qwen3-5-9b");

  // 1, 2: Measure starts the run, and Settings closes onto its chat
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  await expect(chat).toBeVisible();
  await expect(page.getByTestId("settings.models.measure-qwen3-5-9b")).toBeHidden();
  await expect(page.getByTestId("measure.chat.title")).toHaveText(/^Measuring /);
  // 3: the first step loads the model
  await expect(strip.locator(".mc-n")).toHaveText("Loading model");
  // 6: the pinned row stands at the top of the list while the run goes
  await expect(pinned).toBeVisible();
  await expect(pinned).toContainText(`/${CASES.length}`);

  // 4: the held answer is plain text while it streams, and its check has no grade line yet
  const held = page.locator(`[data-testid="measure.chat.turn"][data-check="${HELD.id}"]`);
  const first = HELD.answer.match(/\s*\S+/)![0].trim();
  await expect(held.getByTestId("measure.chat.plain")).toHaveText(first, { timeout: 30_000 });
  // 5: a grade line comes only after the answer
  await expect(held.getByTestId("measure.chat.grade")).toHaveCount(0);
  await expect(page.getByTestId("measure.chat.at")).toHaveText(/^\w+ · \d+ of \d+$/);
  await page.screenshot({ path: info.outputPath("measure-chat-live.png"), animations: "disabled" });
  await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
  await expect(held.getByTestId("measure.chat.grade")).toBeVisible();
  await expect(held.getByTestId("measure.chat.plain")).toHaveCount(0);
  await expect(held.locator(".md")).toBeVisible();

  // 7: Stop keeps no score; the chat says so, and the pinned row goes
  await page.getByTestId("measure.chat.stop").click();
  await expect(strip).toContainText("Stopped. No score kept");
  await expect(page.getByTestId("measure.chat.stop")).toHaveCount(0);
  await expect(pinned).toHaveCount(0);
  await openModels(page);
  await expect(score).toHaveCount(0);
  await expect(page.getByTestId("settings.models.measure-qwen3-5-9b")).toHaveAttribute("aria-label", /^Measure /);

  // 8: a run to the end turns its chat finished; the score opens that chat, parts table on top
  await stack.scenario("measure", { installed: INSTALLED });
  await page.getByTestId("settings.models.measure-qwen3-5-9b").click();
  await expect(page.getByTestId("measure.chat.score")).toBeVisible({ timeout: 60_000 });
  await expect(strip).toHaveCount(0);
  await expect(pinned).toHaveCount(0);
  await openModels(page);
  await expect(score).toHaveText("90");
  await score.click();
  await expect(chat).toBeVisible();
  // the chat opens on its score, at the top
  await expect(page.getByTestId("measure.chat.score")).toBeInViewport();
  await expect(page.getByTestId("models.measure.part-pages")).toContainText("2/3");
  await expect(page.getByTestId("measure.chat.turn")).toHaveCount(CASES.length);
  await expect(held.locator(".md")).toBeVisible();
  await expect(held.getByTestId("measure.chat.grade")).toBeVisible();
  await expect(page.getByTestId("measure.chat.title")).not.toHaveText(/^Measuring /);
  await page.screenshot({ path: info.outputPath("measure-chat-finished.png"), animations: "disabled" });

  // 7, again: a run stopped while its model loads leaves the score it had
  await stack.scenario("measure", { installed: INSTALLED, loadDelayMs: 3000 });
  await openModels(page);
  const row = page.locator('.mp-card .mp-row[data-dm="qwen3.5:9b"]');
  await row.getByTestId("models.row-menu.open").click();
  await row.getByRole("menu").getByTestId("models.row-menu.measure").click();
  await expect(strip.locator(".mc-n")).toHaveText("Loading model");
  await page.getByTestId("measure.chat.stop").click();
  await expect(strip).toContainText("Stopped. No score kept; the last one stays.");
  await openModels(page);
  await expect(score).toHaveText("90");

  // 9: an old measure with no chat kept opens in the same layout, its question from today's check
  await page.getByTestId("settings.models.score-gemma4-12b").click();
  await expect(page.getByTestId("models.measure.older")).toBeVisible();
  await expect(page.getByTestId("measure.chat.turn")).toHaveCount(8);
  const none = page.locator('[data-testid="measure.chat.turn"][data-check="tools-none"]');
  await expect(none).toContainText("391");
  await expect(page.locator(".turn.u .bubble").first()).toHaveText(CASES.find((c) => c.id === "tools-none")!.prompt);
  await expect(strip).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("measure-chat-old.png"), animations: "disabled" });
});

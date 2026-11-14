// WIN-MEM-02 and WIN-MEM-07 (docs/evidence/windows-low-memory-bug-report.md): a model refused for
// memory left a red sentence and no way on, and the open picker hid it while its context column
// showed another row's numbers. Now the note offers what runs instead, from the reading that refused
// (one click makes the change and sends the waiting words), and the picker names whose numbers it
// shows and marks a model that cannot run now.
//
// The machine: a 10 GB card with the fake's resident programs on it (5.35 GiB usable once the app's
// own model leaves) and a 6.4 GiB computer: system memory is judged by what the computer has, less a
// 1 GiB reserve and the 2 GiB margin, so 3.4 GiB is usable for spill (fit.ts cardRamBytes). Together
// 8.75 GiB. By the server's estimate Gemma 4 12B needs 9.85 GiB at 8k, more than that at every
// context offered, so the other installed model that runs is offered (Qwen 3.5 4B, 5.28 GiB at 16k,
// on the card alone); Qwen 3.5 9B is refused at 16k (9.10) and runs at 8k (8.35) only partly in
// system memory. On an 11 GiB computer (8 GiB of spill) every one of them runs.
import type { Page } from "@playwright/test";
import { FAKE_URL } from "./env.ts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

const INSTALLED = ["gemma4:12b", "qwen3.5:9b", "qwen3.5:4b"];

async function smallMachine(): Promise<void> {
  await stack.scenario("models", { installed: INSTALLED });
  await stack.computer(6.4);
  await stack.gpu(0, 10171);
}

/** The fake's chat requests, newest last. */
async function turns(): Promise<{ model: string; numCtx: number; prompt: string }[]> {
  return ((await (await fetch(`${FAKE_URL}/__fake/state`)).json()) as { turns: { model: string; numCtx: number; prompt: string }[] }).turns;
}

async function pick(page: Page, tag: string): Promise<void> {
  await page.locator("#modelBtn").click();
  await page.locator(`#picker .pk-r[data-m="${tag}"] .pk-select`).click();
  await expect(page.locator("#picker")).toBeHidden();
}

/** The changed part outlined, then the shot. */
async function shot(page: Page, path: string, ...outlined: string[]): Promise<void> {
  await page.mouse.move(0, 0);
  const style = await page.addStyleTag({ content: `${outlined.join(",")}{outline:2px solid #f5a524 !important;outline-offset:2px}` });
  await page.screenshot({ path, animations: "disabled" });
  await style.evaluate((el) => el.parentNode?.removeChild(el));
}

const NOTE = '[data-testid="chat.composer.notice"]';

test.beforeEach(async ({ page, open }) => {
  await smallMachine();
  await open();
  await waitReady(page);
});

test("WIN-MEM-02: no context of the picked model fits: the note offers the installed model that does, and one click sends", async ({ page }, info) => {
  await page.locator("#ta").fill("What is a context window?");
  await pick(page, "gemma4:12b");
  const note = page.getByTestId("chat.composer.notice");
  await expect(note).toContainText("Gemma 4 12B");
  await shot(page, info.outputPath("note-other-model.png"), NOTE);
  const other = note.getByTestId("chat.composer.offer-model");
  await expect(other).toContainText("Qwen 3.5 4B");
  // its default context fits on the GPU: nothing said about speed, and no context of Gemma to offer
  await expect(note.getByTestId("chat.composer.offer-context")).toHaveCount(0);
  await expect(page.getByTestId("chat.composer.offer-slower")).toHaveCount(0);
  await other.click();
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await turns()).at(-1)).toMatchObject({ model: "qwen3.5:4b", numCtx: 16384 });
  await expect(page.locator("#modelBtn")).toContainText("Qwen 3.5 4B");
  await expect(note).toHaveCount(0);
});

test("WIN-MEM-02: a smaller context runs, partly in system memory: the note offers it, says slower once, and the send runs", async ({ page }, info) => {
  await page.locator("#ta").fill("Summarise this thread");
  await pick(page, "qwen3.5:9b");
  const note = page.getByTestId("chat.composer.notice");
  await expect(note).toContainText("Qwen 3.5 9B");
  await shot(page, info.outputPath("note-smaller-context.png"), NOTE);
  const smaller = note.getByTestId("chat.composer.offer-context");
  await expect(smaller).toContainText("8k");
  await expect(note.getByTestId("chat.composer.offer-model")).toHaveCount(0);
  // slower, said once on the whole page
  await expect(page.getByTestId("chat.composer.offer-slower")).toHaveCount(1);
  await expect(smaller.getByTestId("chat.composer.offer-slower")).toHaveCount(1);
  await smaller.click();
  await expect(page.locator(".turn.a")).toHaveCount(1);
  await expect(page.locator(".writing")).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await turns()).at(-1)).toMatchObject({ model: "qwen3.5:9b", numCtx: 8192 });
  await expect(page.locator("#modelBtn")).toContainText("8k");
  await expect(note).toHaveCount(0);
});

test("WIN-MEM-07: the picker names whose numbers it shows, tells the selected row from the highlighted one, marks what cannot run now, and leaves the note in view", async ({ page }, info) => {
  await page.locator("#ta").fill("Hello");
  await pick(page, "gemma4:12b");
  const note = page.getByTestId("chat.composer.notice");
  await expect(note).toBeVisible();
  await page.locator("#modelBtn").click();
  const picker = page.locator("#picker");
  await expect(picker).toBeVisible();
  // the tester's view: Gemma selected, the pointer on Qwen 3.5 4B
  await page.locator('#picker .pk-r[data-m="qwen3.5:4b"]').hover();
  await page.waitForTimeout(150);
  await shot(page, info.outputPath("picker.png"), "#picker .pk-context-head", '#picker .pk-r[data-m="gemma4:12b"]', NOTE);
  const head = picker.getByTestId("models.picker.context-for");
  await expect(head).toHaveText("Qwen 3.5 4B");
  await expect(head.locator(".maker-mark")).toHaveCount(1);
  const gemma = picker.locator('.pk-r[data-m="gemma4:12b"]');
  const qwen = picker.locator('.pk-r[data-m="qwen3.5:4b"]');
  await expect(gemma).toHaveClass(/\bsel\b/);
  await expect(qwen).toHaveClass(/\bhl\b/);
  // told apart at a glance: the two rows do not look the same
  const look = (row: typeof gemma) => row.evaluate((el) => { const s = getComputedStyle(el); return `${s.backgroundColor}|${s.boxShadow}`; });
  expect(await look(gemma)).not.toBe(await look(qwen));
  // one mark each: the check is the selection, the fill is the highlight
  await expect(gemma.locator('use[href="#i-check"]')).toHaveCount(1);
  await expect(qwen.locator('use[href="#i-check"]')).toHaveCount(0);
  // Gemma cannot run here now, which is what a send would say
  await expect(gemma.getByTestId("models.picker.need")).toHaveClass(/\bnow\b/);
  await expect(qwen.getByTestId("models.picker.need")).not.toHaveClass(/\bnow\b/);
  // the note is not under the picker, whichever way it opened
  const box = await picker.boundingBox(), noteBox = await note.boundingBox();
  expect(box && noteBox && (box.y + box.height <= noteBox.y + 0.5 || box.y >= noteBox.y + noteBox.height - 0.5)).toBe(true);
  // back on the selected row, the column is Gemma's
  await page.locator('#picker .pk-r[data-m="gemma4:12b"]').hover();
  await expect(head).toHaveText("Gemma 4 12B");
});

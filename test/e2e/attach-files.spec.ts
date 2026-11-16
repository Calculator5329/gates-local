/// <reference lib="dom" />
// Chat row 3, the owner's pick: a file that is not an image attaches by path.
// The server keeps a copy, the message names it, the model opens it with its
// read tool by its label, the chip comes back after a reload, and deleting the
// thread removes the copy.
import { createClient } from "@gates-local/contracts";
import type { Page } from "@playwright/test";
import { expect, sendMessage, test, waitReady } from "./fixtures.ts";

const WORDS = "The meeting moved to the lighthouse.";

function client(page: Page) {
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  return createClient(new WebSocket(server));
}

/** A file dropped on the window from outside, as a file manager would. */
async function drop(page: Page, name: string, text: string): Promise<void> {
  await page.evaluate(file => {
    const data = new DataTransfer();
    data.items.add(new File([file.text], file.name, { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { name, text });
}

// Guards the owner's pick for chat row 3 (2026-11-11): attach a file by path, the model reads it with its tools.
test("a dropped text file is read by the model by its name, survives a reload, and goes with its thread", async ({ page, open }) => {
  await open(); await waitReady(page);
  const rpc = client(page);
  try {
    await rpc.call("settings.update", { tools: true });
    await drop(page, "notes.txt", WORDS);
    const chip = page.getByTestId("chat.composer.form").getByTestId("chat.attachment.file");
    await expect(chip).toContainText("notes.txt");
    await expect(chip).toContainText(`${WORDS.length} B`);

    await sendMessage(page, "What does it say?");
    await expect(chip).toHaveCount(0);
    const reply = page.getByTestId("chat.reply.turn").last();
    const fold = reply.getByTestId("chat.fold.toggle");
    await expect(fold).toHaveAttribute("aria-label", /\b1 tool call\b/);
    await fold.click();
    const call = reply.locator("[data-tool-row]").first();
    await expect(call.locator(".wr-h")).toHaveText("Read notes.txt");
    await call.locator(".wr-line").click();
    await expect(call.locator(".wr-body")).toContainText(WORDS);

    const threadId = decodeURIComponent(/#thread=(.+)$/.exec(page.url())?.[1] ?? "");
    if (!threadId) throw new Error("No thread in the address");
    const [file] = (await rpc.call("threads.get", { threadId })).messages.flatMap(m => m.files ?? []);
    if (!file) throw new Error("The message did not keep its file");

    await page.reload(); await waitReady(page);
    await expect(page.getByTestId("chat.user-message.turn").getByTestId("chat.attachment.file")).toContainText("notes.txt");

    await page.locator(".sb-row.on").click({ button: "right" });
    await page.getByTestId("sidebar.thread-menu.delete").click();
    await expect.poll(async () => (await rpc.call("threads.list", {})).some(t => t.id === threadId)).toBe(false);
    // the server's copy is gone: a message naming it is refused, not sent; Send answers at once, and the refusal is the turn's end (chat row 32)
    const other = await rpc.call("threads.create", {});
    const model = (await rpc.call("models.list", {})).models.find(m => m.capabilities?.includes("completion"))!.name;
    const ends = new Map<string, string>();
    rpc.subscribe("reply.changed", c => { if (c.kind === "is" && c.reply.threadId === other.id && c.reply.stage === "held" && c.reply.held.why === "refused") ends.set(c.reply.id, c.reply.held.message); });
    await rpc.call("reply.send", { id: "again", threadId: other.id, messageId: "again", text: "again", model, numCtx: 4096, files: [file] });
    await expect.poll(() => [...ends.values()]).toEqual([expect.stringContaining("notes.txt is no longer attached")]);
    expect((await rpc.call("threads.get", { threadId: other.id })).messages).toEqual([]);
  } finally { rpc.close(); }
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOor6//DwAFewJ94ITM6gAAAABJRU5ErkJggg==";

async function chooseFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await page.locator("#plusBtn").click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#plusMenu [data-attach]").click();
  await (await chooser).setFiles(files);
}

// Guards the owner's ask: images and files can be attached to a message.
test("Attach a file opens the chooser; an image becomes a chip and a document attaches by its name", async ({ page, open }) => {
  await open(); await waitReady(page);
  await chooseFiles(page, [{ name: "shot.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") }]);
  await expect(page.locator(".att img")).toHaveCount(1);
  // Since "Attach any file" a document is kept and named on a chip, not refused.
  await chooseFiles(page, [{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("some notes\n") }]);
  const chip = page.locator(".att [data-testid='chat.attachment.file']");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("notes.txt");
  await chip.getByRole("button", { name: "Remove notes.txt" }).click();
  await expect(chip).toHaveCount(0);
  // The image is a draft attachment like a pasted one: it survives a reload.
  await page.reload(); await waitReady(page);
  await expect(page.locator(".att img")).toHaveCount(1);
});

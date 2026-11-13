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
    const chip = page.locator(".composer [data-testid=attached-file]");
    await expect(chip).toContainText("notes.txt");
    await expect(chip).toContainText(`${WORDS.length} B`);

    await sendMessage(page, "What does it say?");
    await expect(chip).toHaveCount(0);
    const reply = page.locator(".turn.a").last();
    const fold = reply.locator("button.think.fold");
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
    await expect(page.locator(".turn.u [data-testid=attached-file]")).toContainText("notes.txt");

    await page.locator(".sb-row.on").click({ button: "right" });
    await page.locator("#threadMenu").getByRole("menuitem", { name: "Delete thread" }).click();
    await expect.poll(async () => (await rpc.call("threads.list", {})).some(t => t.id === threadId)).toBe(false);
    // the server's copy is gone: a message naming it is refused, not sent
    const other = await rpc.call("threads.create", {});
    const model = (await rpc.call("models.list", {})).find(m => m.capabilities?.includes("completion"))!.name;
    await expect(rpc.call("chat.send", { threadId: other.id, content: "again", model, numCtx: 4096, files: [file] })).rejects.toThrow("notes.txt is no longer attached");
  } finally { rpc.close(); }
});

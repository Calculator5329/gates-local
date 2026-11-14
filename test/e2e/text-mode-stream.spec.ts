/// <reference lib="dom" />
// A model with no tool calling of its own writes its calls as text. With something in the
// Library its reply was shown only once it was whole: a long wait, then the whole answer at
// once. Its first words now show while the rest is still coming.
import { writeFile } from "node:fs/promises";
import { createClient } from "@gates-local/contracts";
import { FAKE_URL } from "./env.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

const MODEL = "mid-chat:32k"; // completion only: no tool calling

test("a model with no tool calling shows its first words before its reply ends, with the Library in use", async ({ page, open }, info) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await stack.reset("slow-drip", 0, undefined, "system", [MODEL]);
  // the reply stops after its first words until the test lets it go on
  await stack.scenario("slow-drip", { installed: [MODEL], firstTokenDelayMs: 0, holdAfterTokens: 12 });
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  try {
    const file = info.outputPath("notes.txt");
    await writeFile(file, "Disk notes: keep 20 GB free.\n");
    await client.call("sources.add", { kind: "file", path: file });
    await client.call("settings.update", { tools: true });
    await sendMessage(page, "How do I check free disk space?");
    const reply = page.locator(".turn.a .md").last();
    await expect(reply).toContainText("Here is how to check the free disk space");
    // still being written: Stop is up and the end of the reply has not come
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(reply).not.toContainText("Steps");
    await page.screenshot({ path: info.outputPath("streaming.png"), animations: "disabled" });
    await fetch(`${FAKE_URL}/__fake/release`, { method: "POST", body: "{}" });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(reply).toContainText("Steps");
    await expect(reply.locator("pre")).toContainText("df -h /");
    await page.screenshot({ path: info.outputPath("done.png"), animations: "disabled" });
  } finally { client.close(); }
});

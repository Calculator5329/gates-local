import { writeFile } from "node:fs/promises";
import { createClient } from "@gates-local/contracts";
import { fakeComfy } from "./fake-comfy.ts";
import { expect, sendMessage, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "on" });
for (const [mode, model] of [["native", "qwen3.5:9b"], ["text", "mid-chat:32k"]] as const) {
  test(`fabricated image claims retain the report and true card but invented links stay inert (${mode})`, async ({ page, open }, info) => {
    const comfy = await fakeComfy();
    let client: ReturnType<typeof createClient> | undefined;
    const remote: string[] = [];
    page.on("request", req => { if (/https:\/\/(invented|person|tool)\.example/.test(req.url())) remote.push(req.url()); });
    try {
      await stack.reset("image-claims", 0, undefined, "system", [model], comfy.url);
      await stack.scenario("image-claims", { installed: [model], firstTokenDelayMs: 0, holdAfterTokens: mode === "native" ? 1 : 0 });
      await open(); await waitReady(page);
      const server = new URL(page.url()).searchParams.get("server");
      if (!server) throw new Error("No test server");
      client = createClient(new WebSocket(server));
      const file = info.outputPath("report.txt");
      await writeFile(file, "The report total is 42. Source: https://tool.example/report\n");
      await client.call("sources.add", { kind: "file", path: file });
      await client.call("settings.update", { imageGen: true, tools: true });
      await page.getByRole("button", { name: "Image", exact: true }).click();
      await sendMessage(page, "Tell me the report total and draw a ship; https://person.example/brief");
      const reply = page.locator(".turn.a .md").last();
      const card = page.locator("[data-image-job]");
      let originalCard: Awaited<ReturnType<typeof card.elementHandle>>;
      const check = async () => {
        await expect(reply).toContainText("The report total is 42.");
        await expect(reply).toContainText("Your image is ready");
        await expect(reply).toContainText("Download");
        await expect(reply.locator('a[href^="https://invented.example"]')).toHaveCount(0);
        await expect(reply.locator("img")).toHaveCount(0);
        await expect(reply.getByRole("link", { name: "Person", exact: true })).toHaveAttribute("href", "https://person.example/brief");
        await expect(reply.getByRole("link", { name: "Report", exact: true })).toHaveAttribute("href", "https://tool.example/report");
        await expect(card).toHaveCount(1);
        await expect(card).toContainText(/Waiting for the GPU|Making image/);
        await expect(card).toBeVisible();
      };
      if (mode === "native") {
        await check();
        originalCard = await card.elementHandle();
        await expect(page.locator(".turn.a:not(.done) .md")).toBeVisible();
        await page.screenshot({ path: info.outputPath("streaming.png"), animations: "disabled" });
        await stack.scenario("image-claims", { installed: [model], firstTokenDelayMs: 0, holdAfterTokens: 0 });
      }
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await check();
      if (mode === "native") expect(await originalCard!.evaluate(el => el.isConnected), "the image card survives report completion").toBe(true);
      await page.screenshot({ path: info.outputPath("saved.png"), animations: "disabled" });
      await page.reload(); await waitReady(page);
      await check();
      await page.screenshot({ path: info.outputPath("reloaded.png"), animations: "disabled" });
      expect(remote).toEqual([]);
    } finally { client?.close(); await comfy.close(); }
  });
}

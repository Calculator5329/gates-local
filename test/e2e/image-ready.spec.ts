// The 0.2.2 release check: with image generation on, the page was not ready
// within 5 s after a reload, because the first load waited for ComfyUI's status
// and setups, and a ComfyUI that is slow or does not answer holds those reads
// for its whole request timeout. The page is ready without them now; they land
// when ComfyUI answers.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@gates-local/contracts";
import { expect, stack, test, waitReady } from "./fixtures.ts";

test.use({ video: "off" });

/** A ComfyUI address that takes every request and never answers it. */
let silent: Server;
let url = "";
test.beforeEach(async () => {
  silent = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});
test.afterEach(async () => {
  silent.closeAllConnections();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
});

// Guards a shipped bug fix: with image generation on, the page waited on ComfyUI before it was ready.
test("with image generation on, the page is ready within 5 s while ComfyUI does not answer", async ({ page, open }) => {
  await stack.reset("models", 0, undefined, "system", undefined, url);
  await open(); await waitReady(page);
  const server = new URL(page.url()).searchParams.get("server");
  if (!server) throw new Error("No test server");
  const client = createClient(new WebSocket(server));
  try { await client.call("settings.update", { imageGen: true }); }
  finally { client.close(); }
  await page.reload();
  await expect(page.locator("#app[data-ready]"), "ready without waiting for ComfyUI").toBeAttached({ timeout: 5_000 });
  await waitReady(page);
});

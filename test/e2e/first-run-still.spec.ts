/// <reference lib="dom" />
// Journey: the first window holds still. Its heading sits at one height through every state of a
// fresh start (looking for Ollama, nothing found, Ollama downloading, Ollama ready with no model,
// the first model downloading, the model ready); what changes below it changes in place.
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, stack, test } from "./fixtures.ts";

test.use({ scenario: "no-models", skipFirstRun: false, video: "off" });

type Status = Record<string, unknown>;
const isRuntime = (v: unknown): v is Status => typeof v === "object" && v !== null && "baseUrl" in v && "state" in v;
const GIB = 1024 ** 3;
const looking = (r: Status): Status => ({ ...r, state: "starting", owner: "none", detail: "Looking for Ollama." });

/** The runtime the page sees: a fake state of our choosing, or the server's own once `real` is called. */
async function runtime(page: Page) {
  let socket: WebSocketRoute | undefined;
  let real: Status | undefined;
  let fake: ((r: Status) => Status) | undefined = looking;
  await page.routeWebSocket(/\/\?token=/, (ws) => {
    socket = ws;
    const server = ws.connectToServer();
    ws.onMessage((raw) => server.send(raw));
    server.onMessage((raw) => {
      if (typeof raw !== "string") return ws.send(raw);
      const m = JSON.parse(raw) as { result?: unknown; payload?: unknown };
      if (isRuntime(m.result)) real = m.result;
      if (isRuntime(m.payload)) real = m.payload;
      if (fake !== undefined && isRuntime(m.result)) return ws.send(JSON.stringify({ ...m, result: fake(m.result) }));
      if (fake !== undefined && isRuntime(m.payload)) return ws.send(JSON.stringify({ ...m, payload: fake(m.payload) }));
      ws.send(raw);
    });
  });
  const push = (payload: Status) => {
    if (socket === undefined) throw new Error("socket not ready");
    socket.send(JSON.stringify({ type: "push", channel: "runtime.changed", payload }));
  };
  return {
    set(next: (r: Status) => Status) {
      if (real === undefined) throw new Error("no runtime status read yet");
      fake = next;
      push(next(real));
    },
    real() {
      if (real === undefined) throw new Error("no runtime status read yet");
      fake = undefined;
      push(real);
    },
  };
}

const missing = (r: Status): Status => ({ ...r, state: "missing", owner: "none", detail: "No Ollama found." });
const installing = (r: Status): Status => ({
  ...r,
  state: "installing",
  owner: "app",
  detail: "Installing Ollama.",
  install: { receivedBytes: Math.round(0.2 * GIB), totalBytes: Math.round(1.4 * GIB), bytesPerSecond: 40_000_000, diskBytes: Math.round(2.4 * GIB) },
});

for (const [w, h, tag] of [[1280, 800, "desk"], [390, 844, "phone"]] as const) {
  test.describe(`at ${tag}`, () => {
    test.use({ viewport: { width: w, height: h } });

    // Guards a bug seen on a fresh install: the first window was centred, so its heading jumped between states.
    test("the first window's heading stays at one height through a fresh start", async ({ page, open }, info) => {
      const rt = await runtime(page);
      // the first model downloads slowly enough to be seen (about 9 s for 6.1 GB)
      await stack.scenario("no-models", { pullTickMs: 400 });
      await open();
      const heading = page.locator(".fr h1");
      const tops: Record<string, number> = {};
      const at = async (state: string, title: string) => {
        await expect(heading).toHaveText(title);
        await page.mouse.move(2, 2);
        tops[state] = (await heading.boundingBox())?.y ?? Number.NaN;
        await page.screenshot({ path: info.outputPath(`${state}-${tag}.png`) });
      };
      await at("looking", "Starting up");
      rt.set(missing);
      await at("nothing-found", "Ollama isn't installed");
      rt.set(installing);
      await at("fetching-runtime", "Getting the chat engine ready");
      rt.real();
      await at("runtime-ready", "Download your first model");
      await page.getByRole("button", { name: "Download and start" }).click();
      await at("model-downloading", "Downloading your first model");
      await expect(heading).toHaveText("Ready to chat", { timeout: 30_000 });
      await at("model-ready", "Ready to chat");
      await info.attach("heading tops", { body: JSON.stringify(tops, null, 2), contentType: "application/json" });
      const first = tops["looking"] ?? Number.NaN;
      const moved = Object.fromEntries(Object.entries(tops).filter(([, y]) => Math.abs(y - first) > 0.5));
      expect(moved, `heading tops by state: ${JSON.stringify(tops)}`).toEqual({});
    });
  });
}

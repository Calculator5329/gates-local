import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createSources } from "../sources/index.ts";
import { openThreadStore } from "../threads/store.ts";
import { PAGE_RULE, condensePages, pageStandIn } from "./pages.ts";
import { sendStarted } from "./send-started.ts";
import { estimateTokens } from "./window.ts";

const page = (title: string, body = "<p>x</p>") => `<!doctype html>\n<html><head><title>${title}</title></head><body>${body}</body></html>`;
const block = (code: string) => `\`\`\`html\n${code}\n\`\`\``;
const a = (content: string) => ({ role: "assistant" as const, content });
const u = (content: string) => ({ role: "user" as const, content });

it("keeps only the newest page in full; older versions become one line each", () => {
  const v1 = page("Loan calculator", "<p>one</p>");
  const v2 = page("Loan calculator", "<p>two</p>");
  const v3 = page("Loan calculator", "<p>three</p>");
  const sent = condensePages([
    u("make me a loan calculator"), a(`Here it is.\n\n${block(v1)}\n\nEnjoy.`),
    u("make the rate a slider"), a(`Done.\n\n${block(v2)}`),
    u("show the total interest too"), a(`Added.\n\n${block(v3)}`),
    u("thanks"),
  ]);
  expect(sent.map((m) => m.content)).toEqual([
    "make me a loan calculator", `Here it is.\n\n${pageStandIn("Loan calculator")}\n\nEnjoy.`,
    "make the rate a slider", `Done.\n\n${pageStandIn("Loan calculator")}`,
    "show the total interest too", `Added.\n\n${block(v3)}`,
    "thanks",
  ]);
});

it("two pages in the newest reply: the last is the newest, the one before it a stand-in", () => {
  const [m] = condensePages([a(`${block(page("A"))}\n\n${block(page("B"))}`)]);
  expect(m!.content).toBe(`${pageStandIn("A")}\n\n${block(page("B"))}`);
});

it("an unclosed block, a snippet and a user's pasted page are left as they are", () => {
  const messages = [u(block(page("Mine"))), a(block("<div>snippet</div>")), a(`\`\`\`html\n${page("Cut")}`)];
  expect(condensePages(messages)).toEqual(messages);
});

it("a thread with one page sends it whole", () => {
  const messages = [u("make a page"), a(block(page("Only")))];
  expect(condensePages(messages)).toEqual(messages);
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

it("a chat turn sends the model the newest page in full and the older one as a stand-in, while the thread keeps both", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "gl-pages-"));
  dirs.push(root);
  const replies = [`Here.\n\n${block(page("Loan", "<p>one</p>"))}`, `Done.\n\n${block(page("Loan", "<p>two</p>"))}`, "ok"];
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/ps") return Response.json({ models: [{ name: "m", model: "m", size: 1000, size_vram: 1000, context_length: 16384, expires_at: "later", digest: "d" }] });
    if (pathname === "/api/tags") return Response.json({ models: [] });
    if (pathname !== "/api/chat") throw new Error(`unexpected ${pathname}`);
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ message: { content: replies[bodies.length - 1] }, done: true }) + "\n");
  }));
  const store = openThreadStore(path.join(root, "threads.db"));
  const app = createApp({ store, sources: createSources({ dataDir: path.join(root, "data") }), think: true, toolsEnabled: () => false,
    runtime: { status: () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), baseUrl: () => "http://fake", onChange: () => () => {}, ensure: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }), lookIfDown: async () => ({ state: "ready", owner: "external", baseUrl: "http://fake" }) },
    catalog: { current: () => [], refresh: async () => ({ models: [], changed: false }), onChange: () => () => {}, stop: () => {} },
    push: () => {}, fit: { runNvidiaSmi: async args => args[0]?.startsWith("--query-gpu") ? "16384, 1024, 15360\n" : "", readMeminfo: async () => "MemAvailable: 32000000 kB\n" },
  });
  try {
    const thread = store.createThread();
    for (const content of ["make a loan page", "make the rate a slider", "thanks"]) {
      await sendStarted(app, { threadId: thread.id, content, model: "m", numCtx: 16384, think: false }, { clientId: 1 });
      await vi.waitFor(() => expect(app.activeTurns()).toBe(0));
    }
    expect(bodies[2]!.messages.map((m) => m.content)).toEqual([
      "make a loan page", `Here.\n\n${pageStandIn("Loan")}`,
      "make the rate a slider", replies[1],
      "thanks",
    ]);
    expect(store.getThread(thread.id).messages.map((m) => m.content)).toEqual(["make a loan page", replies[0], "make the rate a slider", replies[1], "thanks", "ok"]);
  } finally { await app.shutdown(); store.close(); }
});

it("the standing rule stays short", () => {
  // what every chat turn pays for it
  expect(estimateTokens(PAGE_RULE)).toBeLessThanOrEqual(64);
});

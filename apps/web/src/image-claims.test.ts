import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTools, runLoop, type ToolStep } from "../../../packages/harness/src/index.ts";
import type { Message } from "@gates-local/contracts";
import { openThreadStore } from "../../server/src/threads/store.ts";
import { setState, type State } from "./store.ts";

vi.mock("./store.ts", async (original) => {
  const actual = await original<typeof import("./store.ts")>();
  return { ...actual, useStore: <T,>(selector: (s: State) => T) => selector(actual.getState()) };
});
vi.mock("./session.ts", () => ({ cancelImage: vi.fn(), retryImage: vi.fn(), reloadThread: vi.fn(), retry: vi.fn(), fileUrl: () => "/files/image.png" }));
afterEach(() => { setState({ turns: {}, messages: {}, threadId: null }); vi.unstubAllGlobals(); });
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true })); });

const FOLLOWUP = "The report total is 42.\n\nYour image is ready: [Download](https://invented.example/ship.png).\n\n![Ship](https://invented.example/ship.png)\n\nhttps://invented.example/raw\n\n[Person](https://person.example/brief) and [Report](https://tool.example/report).\n\n[Echo](https://untrusted.example/from-model)";

describe("fabricated mixed-image follow-ups", () => {
  it.each(["streaming", "completion", "saved"])("keeps a mixed report's image card and inert invented link at %s", async (stage) => {
    vi.stubGlobal("window", {});
    const { Timeline } = await import("./Thread.tsx");
    const threadId = "mixed";
    const image: Message = { id: "ship", threadId, role: "assistant", createdAt: 1, content: "a ship", imageJob: { jobId: "ship", threadId, state: "queued" } };
    const tools: ToolStep[] = [{ callId: "image", name: "image", state: "done", summary: "Image queued", links: [] }];
    const text = "The report total is 42. [Download](https://invented.example/ship.png) **more";
    const live = { gen: 1, threadId, turnId: "turn", model: "model", startedAt: 1, thinking: "", text, tools, pendingUser: null };
    const saved: Message = { id: "answer", threadId, role: "assistant", createdAt: 2, content: text, tools };
    const check = () => {
      const html = renderToStaticMarkup(createElement(Timeline, { threadId }));
      expect(html).toContain('data-image-job="queued"');
      expect(html).toContain("The report total is 42.");
      expect(html).not.toContain('href="https://invented.example/ship.png"');
      expect(html).not.toContain("data-tool-row");
    };
    setState({ threadId, messages: { [threadId]: [image] }, turns: { [threadId]: live } });
    if (stage !== "streaming") setState({ turns: {}, messages: { [threadId]: [image, saved] } });
    if (stage === "saved") setState({ messages: { [threadId]: structuredClone([image, saved]) } });
    check();
  });
  it("renders a saved pre-provenance image turn exactly as the old renderer did", async () => {
    vi.stubGlobal("window", {});
    const { Timeline } = await import("./Thread.tsx");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "image-claims-legacy-")), "threads.sqlite");
    let store = openThreadStore(file);
    try {
      const thread = store.createThread();
      store.saveImageJob({ jobId: "ship", threadId: thread.id, state: "queued" }, "a ship");
      // The saved shape before URL provenance was added: neither step has links metadata.
      store.appendMessage({ threadId: thread.id, role: "assistant", content: "The report total is 42: [Report](https://tool.example/report).\n\n![Ship](https://invented.example/ship.png)", tools: [
        { callId: "image", name: "image", state: "done", summary: "Image queued" },
        { callId: "read", name: "read", state: "done", summary: "Read the report" },
      ] });
      store.close(); store = openThreadStore(file);
      const messages = store.getThread(thread.id).messages;
      expect(messages.at(-1)?.tools?.every(step => step.links === undefined)).toBe(true);
      setState({ threadId: thread.id, messages: { [thread.id]: messages } });
      const html = renderToStaticMarkup(createElement(Timeline, { threadId: thread.id }));
      // Exact reply body produced by the cdda4a8 renderer for this saved content.
      expect(html.match(/<div class="md">.*?<\/div>/s)?.[0]).toBe('<div class="md"><p>The report total is 42: <a href="https://tool.example/report" target="_blank" rel="noreferrer noopener">Report</a>.</p><p>Ship</p></div>');
      expect(html).toContain("Waiting for the GPU");
    } finally { store.close(); }
  });
  it("leaves ordinary replies clickable even when an earlier image job is in the thread", async () => {
    vi.stubGlobal("window", {});
    const { Timeline } = await import("./Thread.tsx");
    const base = { threadId: "thread", role: "assistant" as const, createdAt: 1 };
    setState({ threadId: "thread", messages: { thread: [
      { ...base, id: "ship", content: "a ship", imageJob: { jobId: "ship", threadId: "thread", state: "queued" } },
      { ...base, id: "ordinary", content: FOLLOWUP },
    ] } });
    const html = renderToStaticMarkup(createElement(Timeline, { threadId: "thread" }));
    expect(html).toContain('href="https://invented.example/ship.png"');
    expect(html).toContain("Waiting for the GPU");
  });
  it.each([true, false])("keeps the answer and true card while invented links stay inert, live, saved and reloaded (native %s)", async (native) => {
    vi.stubGlobal("window", {});
    const { Timeline } = await import("./Thread.tsx");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "image-claims-")), "threads.sqlite");
    let store = openThreadStore(file);
    const thread = store.createThread();
    store.appendMessage({ threadId: thread.id, role: "user", content: "Tell me the report total and draw a ship; https://person.example/brief" });
    store.appendMessage({ threadId: thread.id, role: "assistant", content: "An old model invented https://untrusted.example/from-model" });
    const tools = createTools({ sources: [], image: true, queueImage: async () => {
      store.saveImageJob({ jobId: "ship", threadId: thread.id, state: "queued" }, "a ship");
      return { jobId: "ship" };
    } });
    const steps: ToolStep[] = [];
    let round = 0, text = "", liveChecks = 0;
    const check = () => {
      const html = renderToStaticMarkup(createElement(Timeline, { threadId: thread.id }));
      const reply = html.split('aria-label="Reply"').find(part => part.includes("The report total is 42.")) ?? "";
      expect(html).toContain("Waiting for the GPU");
      expect(reply).toContain("The report total is 42.");
      expect(reply).toContain("Your image is ready");
      expect(reply).not.toMatch(/href="https:\/\/(invented|untrusted)\.example/);
      expect(reply).not.toContain("<img");
      expect(reply).toContain('href="https://person.example/brief"');
      expect(reply).toContain('href="https://tool.example/report"');
    };
    const calls = [{ name: "image", arguments: { prompt: "a ship" } }, { name: "read", arguments: { path: "report", url: "https://invented.example/ship.png" } }];
    try {
      for await (const event of runLoop({ messages: [], native, signal: new AbortController().signal,
        execute: (call, signal) => call.name === "image" ? tools.execute(call, signal) : Promise.resolve({ output: "The report total is 42. Source: https://tool.example/report", summary: "Read the report" }),
        stream: async function* () {
          round++;
          const content = round === 1 ? (native ? "" : calls.map(call => `<tool_call>${JSON.stringify(call)}</tool_call>`).join("")) : FOLLOWUP;
          if (round > 1) yield { type: "delta", text: content };
          yield { type: "complete", content, calls: round === 1 && native ? calls : [], stopReason: "stop" };
        },
      })) {
        if (event.type === "tool") { const i = steps.findIndex(s => s.callId === event.step.callId); if (i < 0) steps.push(event.step); else steps[i] = event.step; }
        if (event.type === "delta") {
          text += event.text;
          setState({ threadId: thread.id, messages: { [thread.id]: store.getThread(thread.id).messages }, turns: { [thread.id]: { gen: 1, threadId: thread.id, turnId: "turn", model: "model", startedAt: 1, thinking: "", text, tools: [...steps], pendingUser: null } } });
          if (text.includes("[Echo]")) { check(); liveChecks++; }
        }
        if (event.type === "complete") store.appendMessage({ threadId: thread.id, role: "assistant", content: event.content, tools: event.tools });
      }
      expect(liveChecks).toBeGreaterThan(0);
      setState({ turns: {}, messages: { [thread.id]: store.getThread(thread.id).messages } }); check();
      store.appendMessage({ threadId: thread.id, role: "user", content: "Look up the next report" });
      store.appendMessage({ threadId: thread.id, role: "assistant", content: "The later lookup succeeded.", tools: [
        { callId: "later-read", name: "read", state: "done", summary: "Read the next report", links: ["https://invented.example/ship.png"] },
      ] });
      setState({ messages: { [thread.id]: store.getThread(thread.id).messages } }); check();
      store.close(); store = openThreadStore(file);
      setState({ messages: { [thread.id]: store.getThread(thread.id).messages } }); check();
    } finally { store.close(); }
  });
});

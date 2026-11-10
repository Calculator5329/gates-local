// Render the real composer over the store, without a browser. Interaction,
// focus, geometry and double-click checks also live in composer-action.spec.ts.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveTurn, State } from "./store.ts";
import { clearDraft, replaceDraft } from "./drafts.ts";

const device = vi.hoisted(() => ({ touch: false }));
vi.mock("./store.ts", async (original) => {
  const store = await original<typeof import("./store.ts")>();
  return { ...store, useStore: <T,>(selector: (s: State) => T): T => selector(store.getState()) };
});
vi.mock("./session.ts", () => ({
  ...Object.fromEntries(["cancelQueuedEdit", "cancelStopAsk", "confirmStopAsk", "editQueued", "ensureFit", "openSettings", "pickModel", "pull", "removeQueued", "send", "sendQueuedNow", "setContext", "stop", "recheckRuntime"].map((name) => [name, vi.fn()])),
  firstPull: () => undefined,
  queueReason: () => null,
}));
vi.mock("./FitPanel.tsx", () => ({ openFit: vi.fn() }));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: vi.fn() }));
vi.mock("./ui.tsx", async (original) => ({ ...await original<typeof import("./ui.tsx")>(), useMedia: () => device.touch, isTouch: () => device.touch }));

const { Composer } = await import("./Composer.tsx");
const { getState, setState } = await import("./store.ts");
const initial = getState();
afterEach(() => { clearDraft("thread"); clearDraft(null); setState(initial); device.touch = false; });
function setFixture(patch: Partial<State> & { draft?: string }) {
  const { draft = "", ...state } = patch;
  setState(state);
  replaceDraft(state.threadId ?? null, { text: draft });
}

const ready: State = {
  ...initial,
  conn: { kind: "open" },
  runtime: { state: "ready", owner: "external", baseUrl: "http://127.0.0.1:5288", version: "test" },
  models: [{ name: "qwen3.5:9b", digest: "test", sizeBytes: 1, modifiedAt: "", capabilities: ["completion", "thinking"] }],
  model: "qwen3.5:9b",
  view: "thread",
  threadId: "thread",
};
const live: LiveTurn = { gen: 1, threadId: "thread", turnId: "turn", model: "qwen3.5:9b", startedAt: 0, thinking: "", text: "Reply", tools: [], pendingUser: null };
const turns = { thread: live };
const states: readonly [string, Partial<State> & { draft?: string }, string, string?][] = [
  ["idle", {}, "Send message"],
  ["typing", { draft: "hello" }, "Send message"],
  ["running", { turns }, "Stop"],
  ["running with a draft", { turns, draft: "next" }, "Stop", "Queue message"],
  ["editing a queued message", { turns, editingQueued: "queued", draft: "edited" }, "Update queued message"],
  ["editing an empty queued message", { turns, editingQueued: "queued" }, "Update queued message"],
  ["stopped", { turns: { thread: { ...live, end: { kind: "stopped", secs: 1 } } } }, "Send message"],
  ["failed", { turns: { thread: { ...live, end: { kind: "error", code: "internal", message: "Failed" } } } }, "Send message"],
  ["another chat running", { turns: { other: { ...live, threadId: "other" } } }, "Send message"],
  ["disconnected", { conn: { kind: "down", since: 0 } }, "Send message"],
  ["no model", { models: [], model: undefined }, "Send message"],
  ["installing", { runtime: { state: "installing", owner: "app", baseUrl: "http://127.0.0.1:5288" } }, "Send message"],
  ["memory refused", { draft: "Too big", fits: { "qwen3.5:9b@16384": { model: "qwen3.5:9b", numCtx: 16384, freeVramBytes: 0, needVramBytes: 2 ** 30, spillRamBytes: 0, shortfallBytes: 2 ** 30, verdict: "refuse", source: "estimate", measuredAt: 0 } } }, "Send message"],
];

describe("the composer's primary action", () => {
  for (const touch of [false, true]) {
    it(`keeps a separate Stop available without replacing the ${touch ? "touch queue" : "queued edit"} action`, () => {
      device.touch = touch;
      setFixture({ ...ready, turns, draft: "Keep this draft", editingQueued: touch ? null : "queued" });
      const html = renderToStaticMarkup(createElement(Composer));
      expect(html.match(/<button\b[^>]*aria-label="Stop reply"[^>]*>/g) ?? []).toHaveLength(1);
    });
  }
  for (const touch of [false, true]) {
    for (const [name, patch, keyboardLabel, touchLabel = keyboardLabel] of states) {
      it(`has exactly one button.send when ${name}, ${touch ? "touch" : "keyboard"}`, () => {
        device.touch = touch;
        setFixture({ ...ready, ...patch });
        const html = renderToStaticMarkup(createElement(Composer));
        const actions = html.match(/<button\b[^>]*class="send(?: [^"]*)?"[^>]*>/g) ?? [];
        expect(actions, "one primary slot in every state").toHaveLength(1);
        expect(actions[0]).toContain(`aria-label="${touch ? touchLabel : keyboardLabel}"`);
        expect(actions[0], "inactivity must not remove native keyboard focus").not.toMatch(/\sdisabled="/);
        if (keyboardLabel === "Stop" && !touch) expect(actions[0]).toContain("Enter queues");
        if (touch) expect(actions[0]).not.toContain("(Enter)");
        if (name === "memory refused") {
          expect(actions[0]).toContain('aria-disabled="true"');
          expect(actions[0]).toContain("not enough memory at 16k");
          expect(actions[0]).toContain("Settings › Advanced");
        }
      });
    }
  }
});

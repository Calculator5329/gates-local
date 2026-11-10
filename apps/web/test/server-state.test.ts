// Diagnostic probes for the synchronous seam; the unchanged production replays gate behavior.
import { expect, it, vi } from "vitest";
import { createServerState } from "../src/session/server-state.ts";
import { draftView } from "./draft-view.ts";

it("applies receipts and nested projections before the caller continues, without an extra publication", async () => {
  vi.resetModules();
  const store = await import("../src/store.ts");
  const applyServerEvent = createServerState(store.getState, store.setState);
  const trace: string[] = [];
  const off = store.subscribe(() => trace.push(`publish:${store.getState().runtime?.state ?? "none"}`));
  try {
    applyServerEvent(() => {
      trace.push("receipt");
      applyServerEvent({ runtime: { state: "missing", owner: "none", baseUrl: "http://runtime.invalid" } });
      trace.push("accepted");
    });
    trace.push("continuation");
    expect(trace).toEqual(["receipt", "publish:missing", "accepted", "continuation"]);
    await Promise.resolve();
    expect(trace).toEqual(["receipt", "publish:missing", "accepted", "continuation"]);
  } finally { off(); }
});

async function updaterTrace(routed: boolean) {
    vi.resetModules();
    const store = await import("../src/store.ts");
    const drafts = await import("../src/drafts.ts");
    store.setState({ threadId: "thread" });
    const apply = routed ? createServerState(store.getState, store.setState) : store.setState;
    const trace: string[] = [];
    const off = store.subscribe(() => { const state = draftView(store, drafts); trace.push(`${state.draft}:${state.notice}`); });
    try {
      apply({});
      apply(() => {
        const state = draftView(store, drafts);
        drafts.replaceDraft("thread", { text: "newer local text" });
        store.setState({ notice: null });
        return { notice: state.draft === "" ? "read before the nested write" : "wrong input" };
      });
      return trace;
    } finally { off(); }
}

it("preserves empty publications and reentrant store updater behavior", async () => {
  const original = await updaterTrace(false);
  expect(original).toEqual([":null", "newer local text:null", "newer local text:read before the nested write"]);
  expect(await updaterTrace(true)).toEqual(original);
});

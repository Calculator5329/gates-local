// Diagnostic probes for the synchronous seam; the unchanged production replays gate behavior.
import { expect, it, vi } from "vitest";
import { createServerState } from "../src/session/server-state.ts";

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
    const apply = routed ? createServerState(store.getState, store.setState) : store.setState;
    const trace: string[] = [];
    const off = store.subscribe(() => trace.push(`${store.getState().draft}:${store.getState().notice}`));
    try {
      apply({});
      apply(state => {
        store.setState({ draft: "newer local text" });
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserReactHook, costRows, counterRows, emptyNetwork, frameBytes, hotSpots, metricDelta, snapshot } from "./counters.ts";

interface TestFiber { tag: number; flags: number; alternate: TestFiber | null; child: TestFiber | null; sibling: TestFiber | null }
interface TestHook { onCommitFiberRoot(id: number, root: { current: TestFiber }): void; inject(renderer: unknown): number; supportsFiber: boolean }
interface TestWindow { __REACT_DEVTOOLS_GLOBAL_HOOK__: TestHook; perfReact: { commits: number; renders: number } }

const FUNCTION = 0, HOST = 5, RENDERED = 1, SKIPPED = 0;
function fiber(tag: number, flags: number, child: TestFiber | null = null, sibling: TestFiber | null = null, alternate: TestFiber | null = null): TestFiber {
  return { tag, flags, child, sibling, alternate };
}
function installHook(): { hook: TestHook; perfReact: TestWindow["perfReact"] } {
  const target: Partial<TestWindow> = {};
  vi.stubGlobal("window", target);
  browserReactHook();
  const hook = target["__REACT_DEVTOOLS_GLOBAL_HOOK__"], perfReact = target.perfReact;
  if (!hook || !perfReact) throw new Error("The hook did not install");
  return { hook, perfReact };
}
function frame(functionName: string, url: string, lineNumber: number) { return { functionName, url, lineNumber }; }

afterEach(() => { vi.unstubAllGlobals(); });

describe("metricDelta", () => {
  it("subtracts the earlier reading", () => {
    expect(metricDelta(snapshot([{ name: "LayoutCount", value: 10 }]), snapshot([{ name: "LayoutCount", value: 13 }]), "LayoutCount")).toBe(3);
  });

  it("takes the later reading whole after a navigation restarts the counter", () => {
    expect(metricDelta(snapshot([{ name: "LayoutCount", value: 40 }]), snapshot([{ name: "LayoutCount", value: 7 }]), "LayoutCount")).toBe(7);
  });

  it("names a metric the browser did not report", () => {
    expect(() => metricDelta(snapshot([]), snapshot([]), "ThreadTime")).toThrow("Browser did not report ThreadTime");
  });
});

describe("costRows", () => {
  const names = ["ThreadTime", "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"];

  it("reports durations in milliseconds and counts as counts", () => {
    const before = snapshot(names.map(name => ({ name, value: 1 })));
    const after = snapshot(names.map(name => ({ name, value: name.endsWith("Count") ? 4 : 1.25 })));
    const rows = costRows("open", before, after);
    expect(rows.map(row => row.action)).toEqual(["open.cpu-thread", "open.cpu-task", "open.cpu-script", "open.cpu-layout", "open.cpu-style", "open.layouts", "open.style-recalcs"]);
    expect(rows[0]).toEqual({ action: "open.cpu-thread", unit: "ms", value: 250 });
    expect(rows[5]).toEqual({ action: "open.layouts", unit: "count", value: 3 });
  });
});

describe("counterRows", () => {
  it("reports react work between two readings and the network tally", () => {
    const rows = counterRows("open", { before: { commits: 2, renders: 10 }, after: { commits: 5, renders: 31 } }, { ...emptyNetwork(), requests: 4, wsIn: 3 }, 900);
    expect(Object.fromEntries(rows.map(row => [row.action, row.value]))).toEqual({
      "open.react-commits": 3, "open.react-renders": 21, "open.requests": 4, "open.bytes": 0,
      "open.ws-in": 3, "open.ws-out": 0, "open.ws-bytes": 0, "open.dom-elements": 900,
    });
    expect(rows.every(row => row.unit === "count")).toBe(true);
  });
});

describe("frameBytes", () => {
  it("counts a text frame in UTF-8 bytes, not string code units", () => {
    // é is two bytes and ✓ three, so seven code units are ten bytes.
    expect(frameBytes(1, "héllo ✓")).toBe(10);
  });

  it("counts a binary frame as the bytes its base64 payload decodes to", () => {
    expect(frameBytes(2, Buffer.from([1, 2, 3, 4, 5]).toString("base64"))).toBe(5);
  });
});

describe("browserReactHook", () => {
  it("counts one commit and each component that rendered", () => {
    const page = installHook();
    const leaf = fiber(FUNCTION, RENDERED);
    const host = fiber(HOST, RENDERED, leaf);
    const root = fiber(3, SKIPPED, fiber(FUNCTION, RENDERED, host));
    page.hook.onCommitFiberRoot(1, { current: root });
    expect(page.perfReact).toEqual({ commits: 1, renders: 2 });
  });

  it("does not count a subtree React reused from the previous tree", () => {
    const page = installHook();
    const reused = fiber(FUNCTION, RENDERED);
    const previous = fiber(FUNCTION, SKIPPED, reused);
    const current = fiber(FUNCTION, SKIPPED, reused, null, previous);
    page.hook.onCommitFiberRoot(1, { current: fiber(3, SKIPPED, current) });
    expect(page.perfReact).toEqual({ commits: 1, renders: 0 });
  });

  it("walks siblings of a component that rendered", () => {
    const page = installHook();
    const second = fiber(FUNCTION, RENDERED);
    const first = fiber(FUNCTION, RENDERED, null, second);
    page.hook.onCommitFiberRoot(1, { current: fiber(3, SKIPPED, first) });
    expect(page.perfReact.renders).toBe(2);
  });

  it("answers the calls React makes while it starts", () => {
    const { hook } = installHook();
    expect(hook.supportsFiber).toBe(true);
    expect(hook.inject({})).toBe(1);
  });
});

describe("hotSpots", () => {
  it("ranks functions by time spent in them and leaves out idle", () => {
    const spots = hotSpots({
      nodes: [{ id: 1, callFrame: frame("(idle)", "", -1) }, { id: 2, callFrame: frame("render", "http://host/assets/app.js", 9) }, { id: 3, callFrame: frame("", "http://host/assets/app.js", 40) }],
      samples: [1, 2, 3, 2],
      timeDeltas: [9000, 2000, 1000, 3000],
    });
    expect(spots).toEqual([{ name: "render app.js:10", selfMs: 5 }, { name: "(anonymous) app.js:41", selfMs: 1 }]);
  });

  it("copes with a profile that has no samples", () => {
    expect(hotSpots({ nodes: [] })).toEqual([]);
  });
});

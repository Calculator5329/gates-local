// Exercise rendered handlers without a browser; final layout and native focus have E2E coverage.
// Every pick is decided by the server's fit table: the row at the context the
// model really runs at, and nothing else (no catalog report, no held answer).
import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, phone: false, root: undefined as unknown,
  states: [] as unknown[], cursor: 0, refs: 0, refValues: [] as { current: unknown }[],
  pick: vi.fn(), context: vi.fn(), close: vi.fn(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined, useLayoutEffect: () => undefined,
  useState: (initial: unknown) => {
    const i = probe.cursor++;
    if (!(i in probe.states)) probe.states[i] = typeof initial === "function" ? initial() : initial;
    return [probe.states[i], (next: unknown) => { probe.states[i] = typeof next === "function" ? next(probe.states[i]) : next; }];
  },
  useRef: (initial: unknown) => {
    const i = probe.refs++;
    return probe.refValues[i] ??= { current: i === 0 ? probe.root : initial };
  },
}));
vi.mock("./store.ts", () => ({
  NA: "na", chatReady: () => true, getState: () => probe.state,
  useStore: (select: (s: unknown) => unknown) => select(probe.state), setState: vi.fn(), streamingHere: () => false,
}));
vi.mock("./session.ts", () => ({ pickModel: probe.pick, setContext: probe.context }));
vi.mock("./Sidebar.tsx", () => ({ focusComposer: vi.fn() }));
vi.mock("./ui.tsx", async original => ({
  ...await original<typeof import("./ui.tsx")>(), useMedia: () => probe.phone, isPhone: () => probe.phone,
  isTouch: () => false, closePop: probe.close, closeTip: vi.fn(), place: vi.fn(),
}));
vi.stubGlobal("window", { innerWidth: 412 });
const { Picker } = await import("./Picker.tsx");
const { onKey } = await import("./App.tsx");

function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function find(tree: unknown, match: (p: Record<string, unknown>) => boolean) {
  const node = nodes(tree).find(n => match(n.props));
  if (!node) throw new Error("Expected rendered control");
  return node;
}
function call(node: ReactElement<Record<string, unknown>>, handler: string, event?: unknown) {
  const fn = node.props[handler];
  if (typeof fn !== "function") throw new Error(`Missing ${handler}`);
  fn(event);
}
function render() { probe.cursor = 0; probe.refs = 0; return Picker(); }
const control = (inert: boolean) => ({ tabIndex: 0, getClientRects: () => [{}], closest: () => inert ? {} : null, focus: vi.fn() });
const tag = "capped-chat:8k", gib = 1024 ** 3;
const fit = (verdict: "fits" | "refuse", numCtx = 8192, stops: readonly string[] = []) =>
  ({ model: tag, numCtx, verdict, needVramBytes: 20 * gib, freeVramBytes: 12 * gib, spillRamBytes: 0, source: "estimate", stops });
let seq = 0;
/** The server pushes a table of these rows. */
const table = (...rows: readonly object[]) => {
  probe.state.fitTable = { reading: { boot: "b", seq: ++seq, measuredAt: seq }, memory: { kind: "gpu", freeBytes: 12 * gib, usableBytes: 12 * gib }, rows };
};
const advice = (tree: unknown) => find(find(tree, p => p["data-ctx"] === 8192), p => "v" in p).props["v"];
const select = (tree: unknown, name = tag) => find(find(tree, p => p["data-m"] === name), p => p.className === "pk-select");
const useAt = () => find(render(), p => p.className === "pk-detail" && String(p.children).startsWith("Use at"));

beforeEach(() => {
  vi.clearAllMocks(); probe.phone = false; probe.states = []; probe.root = undefined; probe.refValues = [];
  probe.state = { pop: { id: "picker", kb: true, ready: true }, unavailable: {}, model: "other:1b", numCtx: 16384,
    models: [{ name: tag, maxContext: 8192, sizeBytes: gib, capabilities: ["completion"] }],
    catalog: [], fitTable: undefined, pulls: {}, gpu: { vendor: "nvidia", freeBytes: 12 * gib } };
});

/** Every model row and context row, each with its accessible and native state and its look. */
const rowStates = (tree: unknown) => [
  ...nodes(tree).filter(n => n.props["role"] === "option").map(n => ({ key: `row ${String(n.props["data-m"])}`, aria: n.props["aria-disabled"], busy: n.props["aria-busy"], native: undefined })),
  ...nodes(tree).filter(n => n.props["role"] === "radio").map(n => ({ key: `context ${String(n.props["data-ctx"])}`, aria: n.props["aria-disabled"], busy: n.props["aria-busy"], native: n.props["disabled"] })),
];
// An empty table (built before the runtime was up) or an unreadable one reads as no table.
const noAnswer = { "no table": () => undefined, "an empty table": () => table(), "an unreadable table": () => { table(); (probe.state.fitTable as { memory: unknown }).memory = { kind: "unreadable", detail: "x" }; } };
for (const [what, set] of Object.entries(noAnswer)) {
  it(`with ${what}, every row and context row says it cannot be picked yet, keeps its look and focus, and a choice applies nothing`, () => {
    set();
    const tree = render();
    const rows = rowStates(tree);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.aria, `${r.key} is aria-disabled`).toBe(true);
    // native disabled greys a context row (:disabled); only the capped sizes have it, as after the table
    expect(rows.filter(r => r.native === true).map(r => r.key)).toEqual(["context 16384", "context 32768", "context 65536"].filter(k => rows.some(r => r.key === k)));
    expect(rows.find(r => r.key === `row ${tag}`)?.busy).toBe(true);
    expect(rows.find(r => r.key === "context 8192")?.busy).toBe(true);
    call(select(tree), "onClick");
    call(find(tree, p => p["data-ctx"] === 8192), "onClick");
    expect(probe.pick).not.toHaveBeenCalled();
    expect(probe.context).not.toHaveBeenCalled();
  });
}

it("the same row is pickable in the frame the table arrives, with no remount", () => {
  const before = render();
  const row = () => find(render(), p => p["data-m"] === tag);
  expect(find(before, p => p["data-m"] === tag).props["aria-disabled"]).toBe(true);
  const kept = probe.states.slice();
  table(fit("fits"));
  const now = row();
  // the component's own state carried over: the same mount, the next frame
  expect(probe.states).toEqual(kept);
  expect(now.key).toBe(tag);
  expect(now.props["aria-disabled"]).toBe(false);
  expect(now.props["aria-busy"]).toBeUndefined();
  expect(find(render(), p => p["data-ctx"] === 8192).props["aria-disabled"]).toBe(false);
  call(select(render()), "onClick");
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(8192);
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  expect(probe.close).toHaveBeenCalledTimes(1);
});

it("a pushed table replaces the shown fit in place, a refusal included", () => {
  probe.state.model = tag;
  probe.state.numCtx = 8192;
  table(fit("fits"));
  expect(advice(render())).toMatchObject({ k: "gpu" });
  table(fit("refuse"));
  expect(advice(render())).toMatchObject({ k: "no" });
});

it("PK-01: a refused capped row cannot be chosen", () => {
  table(fit("refuse", 16384), fit("refuse"));
  const tree = render();
  expect(find(tree, p => p["data-m"] === tag).props["aria-disabled"]).toBe(true);
  call(select(tree), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  expect(probe.context).not.toHaveBeenCalled();
  expect(probe.close).not.toHaveBeenCalled();
});

it("PK-01: the effective-context refusal wins over a fitting requested-context row", () => {
  table(fit("fits", 16384), fit("refuse"));
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(true);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-01: a fitting effective-context row permits the pick at the cap", () => {
  table(fit("refuse", 16384), fit("fits"));
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(false);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.context).toHaveBeenCalledWith(8192);
  expect(probe.pick).toHaveBeenCalledWith(tag);
});

it.each(["refused", "missing"])("PK-01: a non-enumerated cap's %s 48k row cannot fall through to a fitting 32k row", status => {
  probe.state.numCtx = 65536;
  probe.state.models = [{ name: tag, maxContext: 49152, capabilities: ["completion"] }];
  table(fit("fits", 32768), ...(status === "refused" ? [fit("refuse", 49152)] : []));
  const row = find(render(), p => p["data-m"] === tag);
  // a refused row and a row the table has no reading for ("–") both say they cannot be chosen
  expect(row.props["aria-disabled"]).toBe(true);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-01: a fitting 48k cap uses that row while retaining the valid 64k preference", () => {
  probe.state.numCtx = 65536;
  probe.state.models = [{ name: tag, maxContext: 49152, capabilities: ["completion"] }];
  table(fit("refuse", 32768), fit("fits", 49152));
  call(select(render()), "onClick");
  expect(probe.context).toHaveBeenCalledWith(65536);
  expect(probe.pick).toHaveBeenCalledWith(tag);
});

it("a row that runs once another chat stops can be chosen, and says so", () => {
  table(fit("refuse", 8192, ["busy:1b"]));
  const tree = render();
  expect(find(tree, p => p["data-m"] === tag).props["aria-disabled"]).toBe(false);
  // the row's words for a screen reader say what the pick costs, not "not enough memory"
  const facts = find(find(tree, p => p["data-m"] === tag), p => p.className === "vh" && String(p["id"]).startsWith("pk-facts-"));
  expect(String(facts.props["children"])).toContain("sending stops another chat first");
  call(select(tree), "onClick");
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(8192);
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  expect(probe.close).toHaveBeenCalledTimes(1);
});

it("a size click commits from the table's row for that size", () => {
  probe.state.models = [{ name: tag, maxContext: 131072, capabilities: ["completion"] }];
  table(fit("fits", 16384), fit("fits", 65536));
  const pressed = find(render(), p => p["data-ctx"] === 65536);
  expect(pressed.props["aria-disabled"]).toBe(false);
  call(pressed, "onClick");
  expect(probe.context).toHaveBeenCalledWith(65536);
  expect(probe.pick).toHaveBeenCalledWith(tag);
  expect(probe.close).toHaveBeenCalledTimes(1);
});

it.each([8192, 16384])("a catalog report at %d cannot authorize a pick the table has no row for", numCtx => {
  probe.state.numCtx = 8192;
  probe.state.catalog = [{ name: tag, label: "Local model", fit: { ...fit("fits", numCtx), measuredAt: 0 } }];
  table();
  call(select(render()), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it.each(["1", "Enter"])("keyboard %s picks from the table, and nothing without a row", key => {
  const press = () => call(find(render(), p => p.id === "pkSearch"), "onKeyDown", { key, ctrlKey: key === "1", preventDefault: vi.fn() });
  press();
  expect(probe.pick).not.toHaveBeenCalled();
  table(fit("fits"));
  press();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
});

it("typing in the search clears the keyboard's highlight and closes the tip the highlight opened", async () => {
  const { closeTip } = await import("./ui.tsx");
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => { f(); return 0; });
  call(find(render(), p => p.id === "pkSearch"), "onKeyDown", { key: "ArrowDown", preventDefault: vi.fn() });
  expect(find(render(), p => p.id === "pkSearch").props["aria-activedescendant"], "the arrow highlighted a row").toBe("pk-opt-0");
  vi.mocked(closeTip).mockClear();
  call(find(render(), p => p.id === "pkSearch"), "onChange", { target: { value: "c" } });
  expect(find(render(), p => p.id === "pkSearch").props["aria-activedescendant"]).toBeUndefined();
  expect(closeTip).toHaveBeenCalled();
});

it.each([false, true])("Use at on a sub-8k cap picks from the table's row at the cap on phone %s", phone => {
  probe.phone = phone;
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
  probe.state.models = [{ name: tag, maxContext: 2048, capabilities: ["completion"] }];
  expect(useAt().props.disabled).toBe(true);
  table(fit("fits", 2048));
  call(useAt(), "onClick");
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
});

it("a completed pull keeps its disabled 100% row until the installed list arrives", () => {
  probe.state.models = [];
  probe.state.pulls = { [tag]: { name: tag, state: "done", completedBytes: 100, totalBytes: 100 } };
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(true);
  expect(find(row, p => String(p.className).startsWith("pk-v")).props.children).toBe("100%");
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-01: a newer table's refusal overrides the fit an older render showed", () => {
  table(fit("fits"));
  const row = find(render(), p => p["data-m"] === tag);
  table(fit("refuse"));
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-04: a capped context remains disabled in both native and accessible state", () => {
  table(fit("fits"));
  const radio = find(render(), p => p["data-ctx"] === 32768);
  expect(radio.props.disabled).toBe(true);
  expect(radio.props["aria-disabled"]).toBe(true);
});

it("PK-03: hosted quantizations have different visible and accessible selection names", () => {
  const base = "hf.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
  probe.state.models = ["Q4_K_M", "Q8_0"].map(q => ({ name: `${base}:${q}`, capabilities: ["completion"] }));
  const buttons = nodes(render()).filter(n => n.props.className === "pk-select");
  const names = buttons.map(b => b.props["aria-label"]);
  expect(new Set(names).size).toBe(2);
  for (const suffix of ["Q4_K_M", "Q8_0"]) {
    const button = buttons.find(b => String(b.props["aria-label"]).includes(suffix));
    expect(button).toBeDefined();
    const visible = button && nodes(button).find(n => n.props.className === "pk-variant");
    expect(visible, "quantization stays outside the ellipsized base name").toBeDefined();
    expect(visible?.props.children).toBe(suffix);
  }
});

it.each(["failed pull", "embedding"])("PK-03: a hidden %s does not dirty an ordinary model name", hidden => {
  const base = "hf.co/someone/gemma-4-26B-A4B-it-GGUF";
  probe.state.models = [{ name: `${base}:Q4_K_M`, capabilities: ["completion"] }, ...(hidden === "embedding" ? [{ name: `${base}:Q8_0`, capabilities: ["embedding"] }] : [])];
  if (hidden === "failed pull") probe.state.pulls = { other: { name: `${base}:Q8_0`, state: "error" } };
  const button = find(render(), p => p.className === "pk-select");
  expect(button.props["aria-label"]).toBe("Gemma 4 26B A4B it (someone)");
});

for (const owner of ["picker", "app"] as const) {
  it(`PK-04: ${owner} wraps from Download to Back, skipping the inert maker rail`, () => {
    probe.phone = true; probe.states = ["", "all", null, false, "context", []];
    const rail = control(true), back = control(false), download = control(false);
    const root = { querySelectorAll: () => [rail, back, download], contains: () => true };
    probe.root = root;
    vi.stubGlobal("document", { activeElement: download, getElementById: () => root });
    const event = { key: "Tab", shiftKey: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn() };
    if (owner === "picker") call(find(render(), p => p.id === "picker"), "onKeyDown", event);
    else onKey(event);
    expect(back.focus).toHaveBeenCalledTimes(1);
    expect(rail.focus).not.toHaveBeenCalled();
  });
}

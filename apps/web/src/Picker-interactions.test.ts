// Exercise rendered handlers without a browser; final layout and native focus have E2E coverage.
import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, phone: false, root: undefined as unknown,
  states: [] as unknown[], cursor: 0, refs: 0, refValues: [] as { current: unknown }[], effects: [] as (() => unknown)[],
  pick: vi.fn(), context: vi.fn(), ensure: vi.fn(), close: vi.fn(),
  stale: new Set<unknown>(), held: new Set<unknown>(),
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { probe.effects.push(effect); }, useLayoutEffect: () => undefined,
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
  NA: "na", chatReady: () => true, fitKey: (m: string, c: number) => `${m}@${c}`, getState: () => probe.state,
  useStore: (select: (s: unknown) => unknown) => select(probe.state), setState: vi.fn(), streamingHere: () => false,
}));
vi.mock("./session.ts", () => ({ ensureFit: probe.ensure, pickModel: probe.pick, setContext: probe.context, currentFit: (r: unknown) => probe.stale.has(r) ? undefined : r,
  fitIsCurrent: (r: unknown) => r !== undefined && r !== "error" && !probe.stale.has(r) && !probe.held.has(r) && Object.values(probe.state.fits ?? {}).includes(r) }));
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
function render() { probe.cursor = 0; probe.refs = 0; probe.effects = []; return Picker(); }
function settle() { render(); for (const effect of probe.effects) effect(); }
const control = (inert: boolean) => ({ tabIndex: 0, getClientRects: () => [{}], closest: () => inert ? {} : null, focus: vi.fn() });
const tag = "capped-chat:8k", gib = 1024 ** 3;
const fit = (verdict: "fits" | "refuse", numCtx = 8192) => ({ model: tag, numCtx, verdict, needVramBytes: 20 * gib, freeVramBytes: 12 * gib, spillRamBytes: 0, source: "estimate", measuredAt: 0 });

beforeEach(() => {
  probe.stale.clear();
  probe.held.clear();
  vi.clearAllMocks(); probe.phone = false; probe.states = []; probe.root = undefined; probe.refValues = [];
  probe.state = { pop: { id: "picker", kb: true, ready: true }, unavailable: {}, model: "other:1b", numCtx: 16384,
    models: [{ name: tag, maxContext: 8192, sizeBytes: gib, capabilities: ["completion"] }],
    catalog: [], fits: {}, pulls: {}, stopFrees: {}, gpu: { vendor: "nvidia", freeBytes: 12 * gib } };
});

it("PK-01: clicking a refused capped row while its effective-context check is pending cannot choose it", () => {
  probe.state.fits = { [`${tag}@16384`]: fit("refuse"), [`${tag}@8192`]: fit("refuse") };
  let tree = render();
  expect(find(tree, p => p["data-m"] === tag).props["aria-disabled"]).toBe(true);
  // A refresh has invalidated the effective check; its second response has not arrived.
  probe.state.fits = { [`${tag}@16384`]: fit("refuse") };
  tree = render();
  const row = find(tree, p => p["data-m"] === tag);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  expect(probe.context).not.toHaveBeenCalled();
  expect(probe.close).not.toHaveBeenCalled();
});

it("PK-01: the effective-context refusal wins over a stale fitting requested-context report", () => {
  probe.state.fits = { [`${tag}@16384`]: fit("fits"), [`${tag}@8192`]: fit("refuse") };
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(true);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-01: a completed effective-context check permits the same row and click", () => {
  probe.state.fits = { [`${tag}@16384`]: fit("refuse"), [`${tag}@8192`]: fit("fits") };
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(false);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.context).toHaveBeenCalledWith(8192);
  expect(probe.pick).toHaveBeenCalledWith(tag);
});

it.each(["refused", "pending"])("PK-01: a non-enumerated cap's %s 48k check cannot fall through to a fitting 32k check", status => {
  probe.state.numCtx = 65536;
  probe.state.models = [{ name: tag, maxContext: 49152, capabilities: ["completion"] }];
  probe.state.fits = { [`${tag}@32768`]: fit("fits", 32768), ...(status === "refused" ? { [`${tag}@49152`]: fit("refuse", 49152) } : {}) };
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(status === "refused");
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-01: a fitting 48k cap uses that check while retaining the valid 64k preference", () => {
  probe.state.numCtx = 65536;
  probe.state.models = [{ name: tag, maxContext: 49152, capabilities: ["completion"] }];
  probe.state.fits = { [`${tag}@32768`]: fit("refuse", 32768), [`${tag}@49152`]: fit("fits", 49152) };
  const row = find(render(), p => p["data-m"] === tag);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.context).toHaveBeenCalledWith(65536);
  expect(probe.pick).toHaveBeenCalledWith(tag);
});

it("PK-01: the displayed completed fit waits during a same-key refresh", () => {
  const cached = fit("fits");
  probe.state.fits = { [`${tag}@8192`]: cached };
  const row = find(render(), p => p["data-m"] === tag);
  probe.held.add(cached);
  probe.state.fits = {};
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
});

it.each([false, true])("a row can choose a model that fits after stopping another reply (pending %s)", pending => {
  if (!pending) {
    probe.state.fits = { [`${tag}@8192`]: fit("refuse") };
    probe.state.stopFrees = { [`${tag}@8192`]: true };
  }
  const row = find(render(), p => p["data-m"] === tag);
  call(find(row, p => p.className === "pk-select"), "onClick");
  if (pending) {
    expect(probe.pick).not.toHaveBeenCalled();
    probe.state.fits = { [`${tag}@8192`]: fit("refuse") };
    probe.state.stopFrees = { [`${tag}@8192`]: true };
    settle();
  }
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(8192);
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  expect(probe.close).toHaveBeenCalledTimes(1);
});

it("a size click waits, then commits when a refresh rerenders between pointer press and click", () => {
  probe.state.models = [{ name: tag, maxContext: 131072, capabilities: ["completion"] }];
  probe.state.fits = { [`${tag}@16384`]: fit("fits", 16384), [`${tag}@65536`]: fit("fits", 65536) };
  const pressed = find(render(), p => p["data-ctx"] === 65536);
  expect(pressed.props["aria-disabled"]).toBe(false);
  // The trace shows an enabled 64k control at pointer input, then a GPU update
  // clears fits and React replaces its click handler before the click finishes.
  for (const r of Object.values(probe.state.fits ?? {})) probe.held.add(r);
  probe.state.fits = {};
  const clicked = find(render(), p => p["data-ctx"] === 65536);
  call(clicked, "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@65536`]: fit("fits", 65536) };
  settle();
  expect(probe.context).toHaveBeenCalledWith(65536);
  expect(probe.pick).toHaveBeenCalledWith(tag);
  expect(probe.close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("an explicit failed check blocks an older fitting choice (rerender %s)", rerender => {
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  const old = render();
  probe.state.fits = { [`${tag}@8192`]: "error" };
  const row = find(rerender ? render() : old, p => p["data-m"] === tag);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("a matching catalog check waits, then picks after its first current answer", () => {
  probe.state.numCtx = 8192;
  probe.state.catalog = [{ name: tag, label: "Local model", fit: fit("fits") }];
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(false);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
});

it.each(["held", "stale"] as const)("a %s row click waits for the current answer and preserves the 64k preference on a 48k cap", status => {
  probe.state.numCtx = 65536;
  probe.state.models = [{ name: tag, maxContext: 49152, capabilities: ["completion"] }];
  const cached = fit("fits", 49152);
  probe.state.fits = { [`${tag}@49152`]: cached };
  probe[status].add(cached);
  call(find(find(render(), p => p["data-m"] === tag), p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  expect(find(render(), p => p["data-m"] === tag).props["aria-busy"]).toBe(true);
  expect(probe.ensure).toHaveBeenCalledWith(tag, 49152);
  probe.state.fits = { [`${tag}@49152`]: fit("fits", 49152) };
  settle(); settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(65536);
});

it.each(["refuse", "error", "close"])("a pending row is cancelled by %s before a later fit", result => {
  call(find(find(render(), p => p["data-m"] === tag), p => p.className === "pk-select"), "onClick");
  expect(find(render(), p => p["data-m"] === tag).props["aria-busy"]).toBe(true);
  if (result === "close") probe.state.pop = null;
  else probe.state.fits = { [`${tag}@8192`]: result === "error" ? "error" : fit("refuse") };
  settle();
  if (result === "refuse") expect(find(render(), p => p["data-m"] === tag).props.className).toContain(" dis");
  probe.state.pop = { id: "picker", kb: true, ready: true };
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
});

it.each(["1", "Enter"])("keyboard %s waits for a current answer instead of dropping the pick", key => {
  call(find(render(), p => p.id === "pkSearch"), "onKeyDown", { key, ctrlKey: key === "1", preventDefault: vi.fn() });
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
});

it.each(["fits", "catalog"])("PK-01: a stale %s report cannot pick, and a size waits for its fresh answer", source => {
  probe.state.numCtx = 8192;
  const cached = fit("fits");
  if (source === "fits") probe.state.fits = { [`${tag}@8192`]: cached };
  else probe.state.catalog = [{ name: tag, label: "Local model", fit: cached }];
  probe.stale.add(cached);
  const row = find(render(), p => p["data-m"] === tag);
  expect(row.props["aria-disabled"]).toBe(false);
  expect(row.props["aria-busy"]).toBe(true);
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  call(find(render(), p => p["data-ctx"] === 8192), "onClick");
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
  expect(probe.close).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(8192);
});

it.each([false, true])("Use at on a sub-8k cap waits for the current check on phone %s", phone => {
  probe.phone = phone;
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => cb());
  probe.state.models = [{ name: tag, maxContext: 2048, capabilities: ["completion"] }];
  const cached = fit("fits", 2048);
  probe.state.fits = { [`${tag}@2048`]: cached };
  probe.held.add(cached);
  call(find(render(), p => p.className === "pk-detail" && String(p.children).startsWith("Use at")), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@2048`]: fit("fits", 2048) };
  settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
});

it("a newer row replaces the pending row before the older answer arrives", () => {
  const other = "other-chat:8k";
  probe.state.models = [{ name: tag, maxContext: 8192, capabilities: ["completion"] }, { name: other, maxContext: 8192, capabilities: ["completion"] }];
  for (const name of [tag, other]) call(find(find(render(), p => p["data-m"] === name), p => p.className === "pk-select"), "onClick");
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${other}@8192`]: { ...fit("fits"), model: other } };
  settle();
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(other);
});

it.each(["refuse", "error"] as const)("PK-02: a later fit commits only the promised retry after %s", result => {
  call(find(render(), p => p["data-ctx"] === 8192), "onClick");
  probe.state.fits = { [`${tag}@8192`]: result === "error" ? "error" : fit("refuse") };
  settle();
  expect(find(render(), p => p.role === "status").props.children).toContain(result === "error" ? "retry" : "Choose another size");
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  if (result === "error") expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  else {
    expect(probe.pick).not.toHaveBeenCalled();
    expect(probe.close).not.toHaveBeenCalled();
    expect(nodes(render()).some(node => node.props.role === "status")).toBe(false);
  }
});

it("a catalog check at a different context cannot authorize the choice", () => {
  probe.state.numCtx = 8192;
  probe.state.catalog = [{ name: tag, label: "Local model", fit: fit("fits", 16384) }];
  call(find(find(render(), p => p["data-m"] === tag), p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
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

it("PK-01: a new refusal still overrides an older displayed fit", () => {
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  const row = find(render(), p => p["data-m"] === tag);
  probe.state.fits = { [`${tag}@8192`]: fit("refuse") };
  call(find(row, p => p.className === "pk-select"), "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-04: a pending context remains focusable and accepts a choice without applying it yet", () => {
  const radio = find(render(), p => p["data-ctx"] === 8192);
  expect(radio.props.disabled).toBe(false);
  expect(radio.props["aria-disabled"]).toBe(false);
  call(radio, "onClick");
  expect(probe.pick).not.toHaveBeenCalled();
});

it("Enter's 8k activation stays visible while its first check is pending, then commits once it fits", () => {
  const radio = find(render(), p => p["data-ctx"] === 8192);
  call(radio, "onClick"); // Native Enter activates this same button handler.
  expect(probe.pick).not.toHaveBeenCalled();
  const waiting = find(render(), p => p.id === "picker");
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  const answered = find(render(), p => p.id === "picker");
  expect(answered.props["aria-busy"]).toBe(true); // Protect the choice until its commit effect finishes too.
  for (const effect of probe.effects) effect();
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(8192);
  expect(probe.pick).toHaveBeenCalledExactlyOnceWith(tag);
  expect(probe.close).toHaveBeenCalledTimes(1);
  expect(waiting.props["aria-busy"]).toBe(true);
  expect(find(waiting, p => p["data-ctx"] === 8192).props["aria-busy"]).toBe(true);
  expect(find(waiting, p => p.role === "status").props.children).toBe("Choosing 8k. Checking memory…");
  expect(probe.ensure).toHaveBeenCalledWith(tag, 8192);
  settle();
  expect(probe.pick).toHaveBeenCalledTimes(1);
});

it.each(["refuse", "error"] as const)("the pending 8k choice remains explained when its check returns %s", result => {
  call(find(render(), p => p["data-ctx"] === 8192), "onClick");
  probe.state.fits = { [`${tag}@8192`]: result === "error" ? "error" : { ...fit("refuse"), source: "measured" } };
  // Even a blocking-chat hint must not turn a measured refusal into a pending auto-commit.
  probe.state.stopFrees = { [`${tag}@8192`]: true };
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
  expect(probe.context).not.toHaveBeenCalled();
  expect(probe.close).not.toHaveBeenCalled();
  const message = find(render(), p => p.role === "status").props.children;
  expect(message).toBe(result === "error" ? "Couldn't check 8k. Your choice is kept while we retry." : "8k needs more memory. Choose another size.");
});

it("closing the picker cancels a pending choice before its fit result arrives", () => {
  call(find(render(), p => p["data-ctx"] === 8192), "onClick");
  probe.state.pop = null;
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
});

it("a newer pending context replaces the old choice, even if the old answer arrives first", () => {
  probe.state.models = [{ name: tag, maxContext: 65536, capabilities: ["completion"] }];
  call(find(render(), p => p["data-ctx"] === 8192), "onClick");
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  const answered = render(), effects = probe.effects;
  // Replace the choice before the old render's ready-to-commit effect runs.
  call(find(answered, p => p["data-ctx"] === 32768), "onClick");
  for (const effect of effects) effect();
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
  probe.state.fits = { [`${tag}@32768`]: fit("fits", 32768) };
  settle();
  expect(probe.context).toHaveBeenCalledExactlyOnceWith(32768);
});

it("Back cancels the pending context before a late successful check", () => {
  call(find(render(), p => p["data-ctx"] === 8192), "onClick");
  call(find(render(), p => p.className === "pk-back"), "onClick", { detail: 0 });
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
  settle();
  expect(probe.pick).not.toHaveBeenCalled();
});

it("PK-04: a capped context remains disabled in both native and accessible state", () => {
  probe.state.fits = { [`${tag}@8192`]: fit("fits") };
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
  const base = "hf.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
  probe.state.models = [{ name: `${base}:Q4_K_M`, capabilities: ["completion"] }, ...(hidden === "embedding" ? [{ name: `${base}:Q8_0`, capabilities: ["embedding"] }] : [])];
  if (hidden === "failed pull") probe.state.pulls = { other: { name: `${base}:Q8_0`, state: "error" } };
  const button = find(render(), p => p.className === "pk-select");
  expect(button.props["aria-label"]).toBe("Gemma 4 26B ultra-uncensored (llmfan46)");
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

import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A small hook host exercises the actual component's handlers across unmount
// and remount. The browser journey covers the same navigation with real React.
const host = vi.hoisted(() => ({
  slots: [] as unknown[], at: 0, mark: 0, fresh: true, cleanups: [] as (() => void)[], request: vi.fn(), start: vi.fn(),
  rt: "ready", state: {} as Record<string, unknown>,
}));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial?: unknown) => {
      const at = host.at++;
      if (host.fresh || !(at in host.slots)) host.slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [host.slots[at], (value: unknown) => { host.slots[at] = typeof value === "function" ? (value as (old: unknown) => unknown)(host.slots[at]) : value; }];
    },
    useRef: (initial: unknown) => {
      const at = host.at++;
      if (host.fresh || !(at in host.slots)) host.slots[at] = { current: initial };
      return host.slots[at];
    },
    useEffect: (effect: () => (() => void) | undefined) => { if (host.fresh) { const done = effect(); if (done) host.cleanups.push(done); } },
  };
});
vi.mock("../src/session.ts", () => ({ libraryRequest: host.request, applyServerEvent: (run: () => void) => run(), settingsReads: { imports: () => undefined, keepImports: () => {} }, refreshSource: vi.fn(), removeSource: vi.fn() }));
vi.mock("../src/store.ts", () => ({ NA: "na", useStore: (select: (s: unknown) => unknown) => select(host.state) }));
vi.mock("../src/Banner.tsx", () => ({ rtOf: () => host.rt }));
vi.mock("../src/starter.ts", () => ({ askWith: host.start }));
import LibraryImports, { MIN_FILL_MS } from "../src/LibraryImports.tsx";
import { PathText } from "../src/settings-controls.tsx";

type Props = { children?: ReactNode; onClick?: (event?: { detail: number }) => void; onChange?: (event: { target: { value: string } }) => void; disabled?: boolean; "aria-label"?: string; "data-tip"?: string; className?: string; path?: string };
function leaveSettings() {
  for (const cleanup of host.cleanups.splice(0)) cleanup();
  host.slots = []; host.at = 0; host.fresh = true;
}
function render() { host.at = 0; const tree = LibraryImports({ add: null, clone: true }); host.fresh = false; host.mark = host.at; return tree; }
function all(tree: ReactNode, match: (type: unknown, props: Props) => boolean) {
  const found: Props[] = [];
  host.at = host.mark;
  const visit = (node: ReactNode) => Children.forEach(node, child => {
    if (!isValidElement<Props>(child)) return;
    // The download button is a component of its own with its own hooks; the walk looks at what it draws.
    if (typeof child.type === "function" && child.type.name === "FillButton") { visit((child.type as (props: Props) => ReactNode)(child.props)); return; }
    if (match(child.type, child.props)) found.push(child.props);
    if (child.props.children) visit(child.props.children);
  });
  visit(tree); return found;
}
function find(tree: ReactNode, type: string, text?: string) {
  const found = all(tree, (t, p) => t === type && (text === undefined || p.children === text || p["aria-label"] === text))[0];
  if (!found) throw new Error(`Missing ${type} ${text ?? ""}`); return found;
}
const text = (node: ReactNode): string => {
  let out = "";
  Children.forEach(node, child => { if (typeof child === "string" || typeof child === "number") out += String(child); else if (isValidElement<Props>(child)) out += text(child.props.children); });
  return out;
};
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

const SAMPLE = { id: "chinook", label: "Chinook", description: "A music store", sizeBytes: 1000, url: "https://example.test/chinook.db", license: "MIT", licenseUrl: "https://example.test/LICENSE", tables: [{ name: "albums", rows: 347 }], questions: ["Which artist has the most albums?", "q2", "q3", "q4"] };
const COPY = { id: "copy", kind: "sqlite", label: "Chinook", path: "/library/chinook.db", addedAt: 1, state: "ready", managed: { kind: "sample", key: "chinook" }, tables: [{ name: "albums", rows: 347 }] };
let jobs: unknown[] = [];
// The fill is timed from performance.now(); the tests move that clock by hand.
let now = 0;
let clock: { mockRestore: () => void };
beforeEach(() => {
  jobs = [];
  now = 0;
  clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  host.rt = "ready";
  host.state = { sources: [], settings: { tools: true }, models: [{ name: "chat", capabilities: ["completion", "tools"] }], unavailable: {} };
  host.request.mockImplementation(async (method: string) => method === "sources.imports" ? { samples: [SAMPLE], jobs } : { id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "downloading", bytes: 0, total: 1000 });
});
afterEach(() => { leaveSettings(); host.request.mockReset(); host.start.mockReset(); clock.mockRestore(); });

it.each(["cancelled", "error"] as const)("Retry after leaving Library and returning uses the %s job's repository (DG-02)", async state => {
  const url = "https://github.com/example/docs";
  let repoJobs: { id: string; kind: "repository"; key: string; label: string; state: string; bytes: number }[] = [];
  host.request.mockImplementation(async (method: string, params: { url?: string }) => {
    if (method === "sources.imports") return { samples: [], jobs: repoJobs };
    repoJobs = [{ id: "job", kind: "repository", key: params.url ?? "", label: "example/docs", state: "cloning", bytes: 0 }];
    return repoJobs[0];
  });
  find(render(), "input").onChange!({ target: { value: url } });
  find(render(), "button", "Clone").onClick!();
  await Promise.resolve(); await Promise.resolve();
  leaveSettings(); repoJobs = [{ ...repoJobs[0]!, state }];
  render(); await Promise.resolve(); await Promise.resolve();
  find(render(), "button", "Retry").onClick!();
  expect(host.request).toHaveBeenLastCalledWith("sources.clone", { url });
  leaveSettings(); repoJobs = [{ ...repoJobs[0]!, state }];
  render(); await Promise.resolve(); await Promise.resolve();
  const other = "https://github.com/example/other";
  find(render(), "input").onChange!({ target: { value: other } });
  find(render(), "button", "Clone").onClick!();
  expect(host.request).toHaveBeenLastCalledWith("sources.clone", { url: other });
});

it("Download in a sample's row asks the server for that sample", async () => {
  render(); await settle();
  find(render(), "button", "Download Chinook").onClick!();
  expect(host.request).toHaveBeenLastCalledWith("sources.downloadSample", { id: "chinook" });
});

// The server keeps a finished job; once its database is removed the slot is the sample again, not a full button.
it("a sample whose finished download was removed offers Download again", async () => {
  jobs = [{ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "ready", bytes: 1000, total: 1000, sourceId: "copy" }];
  render(); await settle();
  expect(text(find(render(), "button", "Download Chinook").children)).toBe("Download");
});

it("the filling button shows the percent and cancels when pressed", async () => {
  jobs = [{ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "downloading", bytes: 420, total: 1000 }];
  render(); await settle();
  // First seen now: the fill starts empty and takes MIN_FILL_MS to reach full, never ahead of what is really downloaded.
  expect(text(find(render(), "button", "Cancel download, 0% done").children)).toBe("0%");
  now += MIN_FILL_MS / 4;
  expect(text(find(render(), "button", "Cancel download, 25% done").children)).toBe("25%");
  now += MIN_FILL_MS;
  const fill = find(render(), "button", "Cancel download, 42% done");
  expect(text(fill.children)).toBe("42%");
  // Enter and Space press a button with detail 0.
  fill.onClick!({ detail: 0 });
  expect(host.request).toHaveBeenLastCalledWith("sources.cancelImport", { id: "job-1" });
});

// A double click is two click events, the second with detail 2; the server answers the first well inside that interval.
it("a double click on Download starts it and does not cancel it", async () => {
  render(); await settle();
  find(render(), "button", "Download Chinook").onClick!({ detail: 1 });
  jobs = [{ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "downloading", bytes: 0, total: 1000 }];
  await settle();
  const second = all(render(), (t, p) => t === "button" && (p.className ?? "").includes("fill-btn"))[0]!;
  expect(second["aria-label"]).toBe("Cancel download, 0% done");
  second.onClick!({ detail: 2 });
  expect(host.request.mock.calls.map(c => c[0]).filter(m => m !== "sources.imports")).toEqual(["sources.downloadSample"]);
});

it("a downloaded sample's question starts a new chat with its words", async () => {
  host.state = { ...host.state, sources: [COPY] };
  render(); await settle();
  all(render(), (_, p) => p.className?.startsWith("db-open") === true)[0]!.onClick!();
  const ask = all(render(), (t, p) => t === "button" && p.className === "db-q")[0]!;
  expect(ask.disabled).toBe(false);
  expect(text(ask.children)).toBe("Which artist has the most albums?");
  ask.onClick!();
  // The chat has no other way to know which database the question is about.
  expect(host.start).toHaveBeenCalledWith("In Chinook: Which artist has the most albums?");
});

const OWN = { id: "own", kind: "sqlite", label: "shop", path: "/data/shops/2026/shop.db", addedAt: 1, state: "ready", snapshotAt: Date.UTC(2026, 10, 3, 12), tables: [{ name: "orders", rows: 12 }] };

it("an own database's Refresh is named in one word, as an icon-only button is (decision 19)", async () => {
  host.state = { ...host.state, sources: [OWN] };
  render(); await settle();
  expect(find(render(), "button", "Refresh shop")["data-tip"]).toBe("Refresh");
});

it("a database past 500 tables says how many it has, not how many are listed", async () => {
  const tables = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, rows: 0 }));
  host.state = { ...host.state, sources: [{ ...OWN, tables, tableCount: 812, sizeBytes: 2048 }] };
  render(); await settle();
  const row = all(render(), (_, p) => (p as { "data-db"?: string })["data-db"] === "db:own")[0]!;
  expect(text(all(row.children, (_, p) => p.className === "sl")[0]!.children)).toBe("shop812 tables · 2 KB");
});

it("a virtual table is named without a count", async () => {
  host.state = { ...host.state, sources: [{ ...OWN, tables: [{ name: "docs" }, { name: "orders", rows: 12 }] }] };
  render(); await settle();
  const row = () => all(render(), (_, p) => (p as { "data-db"?: string })["data-db"] === "db:own")[0]!;
  all(row().children, (_, p) => p.className === "db-open")[0]!.onClick!();
  expect(all(row().children, (_, p) => p.className === "db-t").map(p => text(p.children))).toEqual(["docs", "orders 12"]);
  expect(text(all(row().children, (_, p) => p.className === "sl")[0]!.children)).toBe("shop2 tables");
});

it("an opened own database shows its path first, on one line", async () => {
  host.state = { ...host.state, sources: [OWN] };
  render(); await settle();
  const row = () => all(render(), (_, p) => (p as { "data-db"?: string })["data-db"] === "db:own")[0]!;
  all(row().children, (_, p) => p.className === "db-open")[0]!.onClick!();
  const more = all(row().children, (_, p) => p.className === "db-more")[0]!;
  const first = Children.toArray(more.children).find(isValidElement) as { props: Props } | undefined;
  expect(first?.props.className).toBe("d db-path");
  const path = Children.toArray(first?.props.children).find(isValidElement) as { type: unknown; props: Props } | undefined;
  expect(path?.type).toBe(PathText);
  expect(path?.props.path).toBe("/data/shops/2026/shop.db");
});

it("with tools off a question sends nothing and says why", async () => {
  host.state = { ...host.state, sources: [COPY], settings: { tools: false } };
  render(); await settle();
  all(render(), (_, p) => p.className?.startsWith("db-open") === true)[0]!.onClick!();
  const tree = render();
  const ask = all(tree, (t, p) => t === "button" && p.className === "db-q");
  expect(ask).toHaveLength(4);
  expect(ask.every(b => b.disabled === true)).toBe(true);
  expect(all(tree, (_, p) => p.className === "d db-why").map(p => text(p.children))).toEqual(["Needs tools turned on, in Tools."]);
  // A disabled button never fires in a browser; even if it did, no chat is started.
  ask[0]!.onClick!();
  expect(host.start).not.toHaveBeenCalled();
});

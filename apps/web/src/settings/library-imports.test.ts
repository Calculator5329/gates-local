import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A small hook host exercises the actual component's handlers across unmount
// and remount. The browser journey covers the same navigation with real React.
const host = vi.hoisted(() => ({
  slots: [] as unknown[], at: 0, mark: 0, fresh: true, cleanups: [] as (() => void)[], request: vi.fn(), start: vi.fn(), retry: vi.fn(),
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
vi.mock("../lib/session/index.ts", () => ({ libraryRequest: host.request, applyServerEvent: (run: () => void) => run(), refreshSource: vi.fn(), removeSource: vi.fn(), retryImports: host.retry }));
vi.mock("../lib/store/store.ts", () => ({ NA: "na", useStore: (select: (s: unknown) => unknown) => select(host.state) }));
vi.mock("../runtime/words.tsx", () => ({ rtOf: () => host.rt }));
vi.mock("../composer/starter.ts", () => ({ askWith: host.start }));
import LibraryImports, { MIN_FILL_MS } from "./LibraryImports.tsx";
import { PathText } from "../lib/ui/settings-controls.tsx";
import { fileSize } from "../lib/words/format.ts";

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
  // The store as the server's sources.imports pushes keep it: whatever the jobs are now.
  host.state = { sources: [], settings: { tools: true }, models: [{ name: "chat", capabilities: ["completion", "tools"] }], unavailable: {}, get sourceImports() { return { samples: [SAMPLE], jobs }; } };
  host.request.mockImplementation(async () => ({ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "downloading", bytes: 0, total: 1000 }));
});
afterEach(() => { leaveSettings(); host.request.mockReset(); host.start.mockReset(); host.retry.mockReset(); clock.mockRestore(); });

// Guards the app's rule that every dead end names its cause and has a way forward: with no poll, a
// failed read of the samples stays failed until the person retries it.
it("a samples read that failed says so on its row with a Retry that reads them again", () => {
  Object.defineProperty(host.state, "sourceImports", { get: () => "na" });
  const tree = render();
  const row = all(tree, (_type, props) => (props as { err?: unknown }).err === "Couldn't read the available samples.");
  expect(row, "the failure is said on its own row").toHaveLength(1);
  expect(all(tree, (_type, props) => (props as { "aria-hidden"?: unknown })["aria-hidden"] === "true" && props.className === "srow db-row"), "no placeholder rows wait for a read that is not coming").toHaveLength(0);
  find(tree, "button", "Retry").onClick!();
  expect(host.retry).toHaveBeenCalledTimes(1);
  expect(host.request, "the Retry reads; it starts nothing").not.toHaveBeenCalled();
});

it.each(["cancelled", "error"] as const)("Retry after leaving Library and returning uses the %s job's repository (DG-02)", async state => {
  const url = "https://github.com/example/docs";
  let repoJobs: { id: string; kind: "repository"; key: string; label: string; state: string; bytes: number }[] = [];
  Object.defineProperty(host.state, "sourceImports", { get: () => ({ samples: [], jobs: repoJobs }) });
  host.request.mockImplementation(async (_method: string, params: { url?: string }) => {
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

it("Settings opened before the samples are read draws the four usual sample rows as placeholders", () => {
  Object.defineProperty(host.state, "sourceImports", { get: () => undefined });
  const skeleton = all(render(), (_, p) => (p as { "aria-hidden"?: unknown })["aria-hidden"] === "true" && p.className === "srow db-row");
  expect(skeleton).toHaveLength(4);
});

it("a sample's Source link is its repository at the pinned commit, beside its licence", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const pinned = { ...SAMPLE, url: `https://raw.githubusercontent.com/example/chinook-db/${sha}/data/chinook.db` };
  Object.defineProperty(host.state, "sourceImports", { get: () => ({ samples: [pinned], jobs }) });
  render(); await settle();
  all(render(), (_, p) => p.className?.startsWith("db-open") === true)[0]!.onClick!();
  const links = all(render(), (t) => t === "a") as (Props & { href?: string })[];
  expect(links.map(l => [text(l.children), l.href])).toEqual([["MIT", "https://example.test/LICENSE"], ["Source", `https://github.com/example/chinook-db/tree/${sha}`]]);
});

const ownDbLine = (src: object) => {
  host.state = { ...host.state, sources: [{ ...OWN, ...src }] };
  leaveSettings(); render();
  const row = all(render(), (_, p) => (p as { "data-db"?: string })["data-db"] === "db:own")[0]!;
  const words = all(row.children, (_, p) => (p.className ?? "").split(" ").includes("d"))[0]!;
  return [text(words.children), (words as { role?: string }).role ?? null];
};
it("an own database's line says Refreshing… while it refreshes, and its error or Couldn't read it. when that fails", async () => {
  expect(ownDbLine({ state: "refreshing" })).toEqual(["Refreshing…", null]);
  expect(ownDbLine({ state: "error" })).toEqual(["Couldn't read it.", "alert"]);
  expect(ownDbLine({ state: "error", detail: "The file is gone." })).toEqual(["The file is gone.", "alert"]);
});

it("a sample's line draws all three of its faces at once with one shown, and before the download its database face holds the catalog's tables and size", async () => {
  const faces = () => {
    const row = all(render(), (_, p) => (p as { "data-db"?: string })["data-db"] === "sample:chinook")[0]!;
    return all(row.children, (_, p) => /^import-(rest|status|db)\b/.test(p.className ?? "")) as (Props & { "aria-hidden"?: unknown })[];
  };
  render(); await settle();
  const before = faces();
  expect(before.map(f => f.className)).toEqual(["import-rest", "import-status gone", "import-db gone"]);
  expect(before[2]!["aria-hidden"]).toBe(true);
  expect(text(before[2]!.children)).toBe(`1 table · ${fileSize(1000)}`);
  leaveSettings();
  jobs = [{ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "error", bytes: 10, total: 1000, detail: "The download could not connect." }];
  render(); await settle();
  const failed = faces();
  expect(failed.map(f => f.className)).toEqual(["import-rest gone", "import-status", "import-db gone"]);
  expect(text(failed[1]!.children)).toBe("The download could not connect.");
  expect((failed[1] as { role?: string }).role).toBe("alert");
});

it("Library is the Databases list first, then Clone a repository", () => {
  expect(all(render(), (_, p) => typeof (p as { title?: unknown }).title === "string").map(p => (p as { title?: string }).title)).toEqual(["Databases", "Clone a repository"]);
});

const cloneLine = () => {
  const tree = render();
  const rest = all(tree, (_, p) => (p.className ?? "").startsWith("import-rest"))[0]!;
  const status = all(tree, (_, p) => p.className === "import-status")[0]! as Props & { role?: string };
  return [rest.className, text(rest.children), text(status.children), status.role];
};
it("the clone row's line keeps its rest words unseen under the job's, says what the job is doing, and makes a failure an alert", async () => {
  let repoJobs: unknown[] = [];
  Object.defineProperty(host.state, "sourceImports", { get: () => ({ samples: [], jobs: repoJobs }) });
  expect(cloneLine()).toEqual(["import-rest", "Up to 64 MiB and 10,000 files.", "", "status"]);
  repoJobs = [{ id: "job", kind: "repository", key: "https://github.com/example/docs", label: "example/docs", state: "cloning", bytes: 2048 }];
  expect(cloneLine()).toEqual(["import-rest gone", "Up to 64 MiB and 10,000 files.", "example/docs · Cloning · 2 KiB received", "status"]);
  repoJobs = [{ id: "job", kind: "repository", key: "https://github.com/example/docs", label: "example/docs", state: "error", bytes: 0, detail: "Git is not installed. Install Git and try again." }];
  expect(cloneLine()).toEqual(["import-rest gone", "Up to 64 MiB and 10,000 files.", "example/docs · Git is not installed. Install Git and try again.", "alert"]);
});

it.each(["error", "cancelled"] as const)("a sample whose download ended %s offers Retry", async state => {
  jobs = [{ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state, bytes: 10, total: 1000 }];
  render(); await settle();
  expect(text(find(render(), "button", "Retry Chinook").children)).toBe("Retry");
});

it("on a client that cannot read settings, a downloaded sample's questions count tools as on", async () => {
  host.state = { ...host.state, sources: [COPY], settings: "na" };
  render(); await settle();
  all(render(), (_, p) => p.className?.startsWith("db-open") === true)[0]!.onClick!();
  const tree = render();
  expect(all(tree, (t, p) => t === "button" && p.className === "db-q").map(b => b.disabled)).toEqual([false, false, false, false]);
  expect(all(tree, (_, p) => p.className === "d db-why")).toEqual([]);
});

it("a pressed Download is running before the server answers: it shows the fill, not Download, and a second press starts nothing", async () => {
  const server: { answer?: (job: unknown) => void } = {};
  host.request.mockImplementation(() => new Promise(r => { server.answer = r; }));
  render(); await settle();
  find(render(), "button", "Download Chinook").onClick!({ detail: 1 });
  const pressed = all(render(), (t, p) => t === "button" && (p.className ?? "").includes("fill-btn"))[0]!;
  expect(pressed["aria-label"]).toBe("Cancel download, 0% done");
  pressed.onClick!({ detail: 1 });
  expect(host.request).toHaveBeenCalledTimes(1);
  server.answer?.({ id: "job-1", kind: "sample", key: "chinook", label: "Chinook", state: "downloading", bytes: 0, total: 1000 });
  await settle();
});

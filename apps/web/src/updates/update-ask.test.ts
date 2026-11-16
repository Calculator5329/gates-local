// The footer's update button and its ask, mounted for real (react-dom on the fake DOM).
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { UpdateStatus } from "@gates-local/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { FakeDocument, FakeElement, FakeIFrame, type FakeNode } from "../../test/fake-dom.ts";

const h = vi.hoisted(() => ({
  readUpdateStatus: vi.fn<() => Promise<string | null>>(),
  updateAndRestart: vi.fn<(approved?: string) => Promise<string | null>>(),
  checkForUpdates: vi.fn<() => Promise<string | null>>(),
  downloadUpdate: vi.fn<() => Promise<string | null>>(),
  dismissUpdateResult: vi.fn<() => Promise<void>>(),
  openSettings: vi.fn(),
  closeTip: vi.fn(),
  tipOpen: false,
}));
vi.mock("../lib/session/index.ts", () => ({
  canUpdateHere: () => true,
  checkForUpdates: h.checkForUpdates,
  dismissUpdateResult: h.dismissUpdateResult,
  downloadUpdate: h.downloadUpdate,
  openSettings: h.openSettings,
  readUpdateStatus: h.readUpdateStatus,
  updateAndRestart: h.updateAndRestart,
}));
vi.mock("../lib/ui/ui.tsx", () => ({ closeTip: h.closeTip, esc: (s: string) => s }));

const doc = new FakeDocument();
type Listener = { type: string; fn: (e: unknown) => void };
const listeners: Listener[] = [];
let root: Root;
let store: typeof import("../lib/store/store.ts");
let SidebarUpdate: typeof import("./Updates.tsx").SidebarUpdate;

const OFFERED: UpdateStatus = {
  version: { kind: "commit", commit: "abc1234" },
  result: null,
  lastCheck: { state: "available", checkedAt: 1, channel: "main", current: "abc1234", target: "def5678", targetCommit: `def5678${"0".repeat(33)}`, total: 1, changes: ["Faster chat"] },
  approval: "approval-1",
  activity: ["1 running reply"],
};
const MOVED: UpdateStatus = { ...OFFERED, approval: "approval-2", activity: ["1 running reply", "model download: alpha:7b"] };
const REPLY = "1 reply stops. Its text is kept.";
const DOWNLOAD = "Download of alpha:7b stops. It resumes.";

const matches = (el: FakeElement, selector: string) => {
  const [outer, inner] = selector.split(" ");
  if (inner === undefined) return el.classList.includes(outer?.slice(1) ?? "");
  if (!el.classList.includes(inner.slice(1))) return false;
  for (let p = el.parentNode; p instanceof FakeElement; p = p.parentNode) if (p.classList.includes(outer?.slice(1) ?? "")) return true;
  return false;
};
const closestOf = (start: FakeElement, selectors: string): FakeElement | null => {
  for (let el: FakeNode | null = start; el instanceof FakeElement; el = el.parentNode) if (selectors.split(",").some((s) => matches(el as FakeElement, s.trim()))) return el;
  return null;
};
const patched = {
  focus: FakeElement.prototype.focus,
  querySelector: FakeElement.prototype.querySelector,
};

function buttonOrClass(this: FakeElement, selector: string): FakeElement | null {
  if (selector !== "button") return patched.querySelector.call(this, selector);
  const walk = (n: FakeNode): FakeElement | null => {
    for (const c of n.childNodes) {
      if (!(c instanceof FakeElement)) continue;
      if (c.tagName === "BUTTON") return c;
      const found = walk(c);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(this);
}

beforeAll(async () => {
  const win = {
    document: doc,
    HTMLIFrameElement: FakeIFrame,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };
  doc.defaultView = win;
  Object.assign(doc, {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners.push({ type, fn }); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    getElementById: (id: string) => (id === "tip" ? { classList: { contains: (c: string) => c === "open" && h.tipOpen } } : null),
  });
  FakeElement.prototype.focus = function focus(this: FakeElement) { doc.activeElement = this; };
  FakeElement.prototype.querySelector = buttonOrClass;
  Object.assign(FakeElement.prototype, { closest(this: FakeElement, selectors: string) { return closestOf(this, selectors); } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("Element", FakeElement);
  const { createRoot } = await import("react-dom/client");
  store = await import("../lib/store/store.ts");
  ({ SidebarUpdate } = await import("./Updates.tsx"));
  root = createRoot(doc.body.appendChild(doc.createElement("div")) as unknown as Element);
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  h.tipOpen = false;
  h.readUpdateStatus.mockReset().mockResolvedValue(null);
  h.updateAndRestart.mockReset().mockResolvedValue(null);
  h.checkForUpdates.mockReset().mockResolvedValue(null);
  h.downloadUpdate.mockReset().mockResolvedValue(null);
  h.dismissUpdateResult.mockReset().mockResolvedValue(undefined);
  h.closeTip.mockReset();
  store.setState({ update: OFFERED, updateChecking: false, updateInstalling: false, updateError: null, drawer: false, pop: null });
  act(() => root.render(createElement("div", { className: "sb-foot" }, createElement(SidebarUpdate, { via: (then: () => void) => then() }))));
});
afterEach(() => { act(() => root.render(null)); vi.useRealTimers(); });
afterAll(() => {
  act(() => root.unmount());
  FakeElement.prototype.focus = patched.focus;
  FakeElement.prototype.querySelector = patched.querySelector;
  delete (FakeElement.prototype as Partial<{ closest: unknown }>).closest;
  vi.unstubAllGlobals();
});

const find = (pred: (el: FakeElement) => boolean): FakeElement | null => {
  const walk = (n: FakeNode): FakeElement | null => {
    for (const c of n.childNodes) {
      if (!(c instanceof FakeElement)) continue;
      if (pred(c)) return c;
      const found = walk(c);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(doc.body);
};
const byTestId = (id: string) => find((el) => el.getAttribute("data-testid") === id);
const props = (el: FakeElement | null): Record<string, unknown> => {
  if (el === null) throw new Error("no such element");
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  return (key === undefined ? {} : (el as unknown as Record<string, Record<string, unknown>>)[key]) ?? {};
};
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (el: FakeElement | null) => { await act(async () => { (props(el)["onClick"] as (() => void) | undefined)?.(); }); await settle(); };
const button = () => byTestId("sidebar.foot.update");
const ask = () => find((el) => el.classList.includes("cfm"));
const go = () => byTestId("sidebar.update.go");
const cancel = () => byTestId("sidebar.update.cancel");
const items = () => { const list = ask()?.childNodes.find((c) => c instanceof FakeElement && c.tagName === "UL"); return list === undefined ? [] : list.childNodes.filter((c): c is FakeElement => c instanceof FakeElement); };
const bright = () => items().map((li) => li.style["color"] === "var(--foreground)");
const changedNote = () => find((el) => el.getAttribute("role") === "status")?.textContent ?? "";
const fire = async (type: string, e: Record<string, unknown>) => { await act(async () => { for (const l of listeners.filter((x) => x.type === type)) l.fn({ stopPropagation() {}, ...e }); }); await settle(); };
const push = async (update: UpdateStatus) => { await act(async () => { store.setState({ update }); }); await settle(); };

it("a new approval while the ask is open shows the new line brighter and says Changed, holds Go a second, and moves focus off Go to Cancel", async () => {
  await click(button());
  expect(items().map((li) => li.textContent)).toEqual([REPLY]);
  expect(props(go())["disabled"]).toBe(false);
  act(() => go()?.focus());
  await push(MOVED);
  expect(items().map((li) => li.textContent)).toEqual([REPLY, DOWNLOAD]);
  expect(bright()).toEqual([false, true]);
  expect(changedNote()).toBe(`Changed: ${DOWNLOAD}`);
  expect(props(go())["disabled"]).toBe(true);
  expect(doc.activeElement).toBe(cancel());
  await act(async () => { vi.advanceTimersByTime(999); });
  expect(props(go())["disabled"]).toBe(true);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(props(go())["disabled"]).toBe(false);
  expect(changedNote()).toBe("");
  expect(bright()).toEqual([false, false]);
});

it("Go that finds the approval moved on installs nothing, and the ask opens again with the new line marked", async () => {
  h.updateAndRestart.mockImplementation(async () => { store.setState({ update: MOVED }); return null; });
  await click(button());
  await click(go());
  expect(h.updateAndRestart).toHaveBeenCalledExactlyOnceWith("approval-1");
  expect(ask()).not.toBeNull();
  expect(items().map((li) => li.textContent)).toEqual([REPLY, DOWNLOAD]);
  expect(changedNote()).toBe(`Changed: ${DOWNLOAD}`);
  expect(props(go())["disabled"]).toBe(true);
});

it("the ask closes when the click stops being an update and with the drawer; Escape leaves an open menu, closes a tooltip first, then the ask, focus back on the button", async () => {
  await click(button());
  await push({ ...OFFERED, lastCheck: { state: "up-to-date", checkedAt: 2, channel: "main", current: "abc1234" } });
  expect(ask()).toBeNull();
  await push(OFFERED);
  await act(async () => { store.setState({ drawer: true }); });
  await click(button());
  expect(ask()).not.toBeNull();
  await act(async () => { store.setState({ drawer: false }); });
  await settle();
  expect(ask()).toBeNull();

  await click(button());
  expect(doc.activeElement).toBe(cancel());
  await act(async () => { store.setState({ pop: { id: "plus", kb: true } }); });
  await fire("keydown", { key: "Escape" });
  expect(ask()).not.toBeNull();
  await act(async () => { store.setState({ pop: null }); });
  h.tipOpen = true;
  await fire("keydown", { key: "Escape" });
  expect(h.closeTip).toHaveBeenCalled();
  expect(ask()).not.toBeNull();
  h.tipOpen = false;
  await fire("keydown", { key: "Escape" });
  expect(ask()).toBeNull();
  expect(doc.activeElement).toBe(button());
});

it("a running-work list that cannot be read still asks, with nothing running known, and says why with Go off", async () => {
  h.readUpdateStatus.mockResolvedValue("The server could not say what runs.");
  await push({ ...OFFERED, activity: [] });
  await click(button());
  expect(ask()).not.toBeNull();
  expect(find((el) => el.getAttribute("role") === "alert")?.textContent).toBe("The server could not say what runs.");
  expect(props(go())["disabled"]).toBe(true);
  expect(h.updateAndRestart).not.toHaveBeenCalled();
});

it("a running-work list that could not be read is read again on Retry, and Go works once it reads", async () => {
  h.readUpdateStatus.mockResolvedValue("Couldn't read what an update would stop; try again.");
  await push({ ...OFFERED, activity: [] });
  await click(button());
  expect(props(go())["disabled"]).toBe(true);
  h.readUpdateStatus.mockResolvedValue(null);
  const reads = h.readUpdateStatus.mock.calls.length;
  await click(byTestId("sidebar.update.retry"));
  expect(h.readUpdateStatus).toHaveBeenCalledTimes(reads + 1);
  expect(find((el) => el.getAttribute("role") === "alert")).toBeNull();
  expect(props(go())["disabled"]).toBe(false);
});

it("Retry takes its line away as the list is read again, so the focus moves to Cancel and not to the page", async () => {
  h.readUpdateStatus.mockResolvedValue("Couldn't read what an update would stop; try again.");
  await push({ ...OFFERED, activity: [] });
  await click(button());
  byTestId("sidebar.update.retry")?.focus();
  await click(byTestId("sidebar.update.retry"));
  expect(doc.activeElement?.getAttribute("data-testid")).toBe("sidebar.update.cancel");
});

it("a footer check that failed shows until a newer check answers, and a later status with no check does not bring it back", async () => {
  h.checkForUpdates.mockResolvedValue("Gates Local is not answering.");
  await push({ ...OFFERED, approval: undefined, lastCheck: { state: "up-to-date", checkedAt: 1, channel: "main", current: "abc1234" } });
  await click(button());
  expect(h.checkForUpdates).toHaveBeenCalledOnce();
  expect(button()?.getAttribute("aria-label")).toBe("Couldn't check");
  await push({ ...OFFERED, approval: undefined, lastCheck: { state: "up-to-date", checkedAt: 2, channel: "main", current: "abc1234" } });
  expect(button()?.getAttribute("aria-label")).toBe("Check for updates");
  await push({ ...OFFERED, approval: undefined, lastCheck: null });
  expect(button()?.getAttribute("aria-label")).toBe("Check for updates");
});

it("a stopped update's note goes with the press that acts on it: Go dismisses it, Cancel leaves it, a check dismisses it at once", async () => {
  const stopped = { at: 1, outcome: "stopped" as const, line: "The update stopped. The previous version is restored." };
  await push({ ...OFFERED, result: stopped });
  await click(button());
  expect(h.dismissUpdateResult).not.toHaveBeenCalled();
  await click(cancel());
  expect(h.dismissUpdateResult).not.toHaveBeenCalled();
  await click(button());
  await click(go());
  expect(h.dismissUpdateResult).toHaveBeenCalledOnce();
  expect(h.dismissUpdateResult.mock.invocationCallOrder[0]).toBeLessThan(h.updateAndRestart.mock.invocationCallOrder[0] ?? 0);

  h.dismissUpdateResult.mockClear();
  await push({ ...OFFERED, approval: undefined, lastCheck: null, result: stopped });
  await click(button());
  expect(h.dismissUpdateResult).toHaveBeenCalledOnce();
  expect(h.checkForUpdates).toHaveBeenCalledOnce();
});

it("a busy footer button stays focusable with its tooltip, and a click does nothing", async () => {
  await push({ ...OFFERED, installing: true });
  const b = button();
  expect(b?.getAttribute("aria-disabled")).toBe("true");
  expect(props(b)["disabled"]).toBeUndefined();
  expect(b?.getAttribute("data-tip")).toBe("Closing to update…");
  expect(props(b)["onClick"]).toBeUndefined();
});

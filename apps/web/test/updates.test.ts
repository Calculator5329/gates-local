// Settings › General › Updates: each state of the group and the note after an
// update, rendered to markup from props, and the session's promise that the
// browser check runs only on a click; automatic checks belong to the desktop server.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";
import type { State } from "../src/store.ts";

type Updates = typeof import("../src/Updates.tsx") & typeof import("../src/SettingsUpdates.tsx");
type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");

let b: Browser;
let ui: Updates;
let session: Session;
let store: Store;
let disconnect: (() => void) | undefined;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  ui = { ...await import("../src/Updates.tsx"), ...await import("../src/SettingsUpdates.tsx") };
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = undefined;
});

afterEach(async () => {
  disconnect?.();
  vi.stubGlobal("gatesLocal", undefined);
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

const SETTINGS: Settings = methodSamples["settings.get"].result;
const CLONE: UpdateStatus = { version: { kind: "commit", commit: "abc1234", date: Date.UTC(2026, 10, 7) }, result: null, lastCheck: null };
const OFFERED: UpdateStatus = { ...CLONE, lastCheck: { state: "available", checkedAt: 1, channel: "main", current: "abc1234", target: "bbbbbbb", targetCommit: "b".repeat(40), total: 1, changes: ["Approved B"] }, approval: "approval-b", activity: [] };
const AT = Date.UTC(2026, 10, 7, 12, 0);

const props = (over: Partial<Parameters<Updates["UpdatesView"]>[0]> = {}) => ({
  status: CLONE,
  settings: SETTINGS,
  settingsLocked: false,
  checking: false,
  canUpdate: false,
  onCheck: () => undefined,
  onUpdate: () => undefined,
  onEveryChange: () => undefined,
  ...over,
});
const view = (over: Partial<Parameters<Updates["UpdatesView"]>[0]> = {}) => renderToStaticMarkup(createElement(ui.UpdatesView, props(over)));
const withCheck = (lastCheck: UpdateCheck) => ({ status: { ...CLONE, lastCheck } });
/** The markup with tags dropped, for reading the words. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the Updates group", () => {
  it("AV-05 the notice belongs to Settings scrolling content instead of its horizontal sibling", async () => {
    disconnect = session.connect();
    await until(() => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open");
    const { settingsScreen } = await import("../src/screen-loaders.ts");
    await settingsScreen.load();
    session.openSettings();
    store.setState({ update: { ...CLONE, result: { at: 1, outcome: "updated", line: "Approved commit is ready." } } });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const useStore = vi.spyOn(store, "useStore").mockImplementation(<T,>(select: (state: State) => T) => select(store.getState()));
    try {
      const { App } = await import("../src/App.tsx");
      const html = renderToStaticMarkup(createElement(App));
      const parents: string[][] = [];
      let noticeParents: string[][] | undefined;
      for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
        if (token.startsWith("</")) parents.pop();
        else if (/^<[a-z]/i.test(token) && !/^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i.test(token) && !token.endsWith("/>")) parents.push(/\bclass="([^"]*)"/.exec(token)?.[1]?.split(" ") ?? []);
        else if (token.includes("Gates Local updated")) { noticeParents = [...parents]; break; }
      }
      expect(noticeParents, "The actual app renders its update notice").toBeDefined();
      expect(noticeParents?.some(classes => classes.includes("set")), "AV-05 notice must share the Settings scrolling surface").toBe(true);
    } finally { useStore.mockRestore(); }
  });
  it("AV-01 a phone status offer exposes no update or preference controls", () => {
    const html = view({ status: { ...OFFERED, canControl: false }, canUpdate: false });
    expect(text(html)).toContain("bbbbbbb");
    expect(text(html)).toContain("computer");
    expect(html).not.toContain('>Check for updates</button>');
    expect(html).not.toContain('role="switch"');
  });
  it("names the automatic schedule and both preferences", () => {
    const html = view();
    expect(text(html)).toContain("Version");
    expect(html).toContain("abc1234");
    expect(text(html)).toContain("A commit from");
    expect(text(html)).toContain("Check for updates");
    expect(text(html)).toContain("15 seconds after startup, then hourly");
    expect(html).toContain('aria-label="Check for updates automatically"');
    expect(html).toContain('aria-checked="true"');
    expect(text(html)).toContain("Get every change, not only releases");
    expect(html).toContain('aria-checked="false"');
    expect(view({ settings: { ...SETTINGS, updateEveryChange: true } })).toContain('aria-checked="true"');
  });

  it("shows a release tag as the version", () => {
    expect(view({ status: { ...CLONE, version: { kind: "release", tag: "v0.2.0", commit: "abc1234" } } })).toContain("v0.2.0");
  });

  it("shows only the version for a copy that is not a clone, or when the server has no updates", () => {
    const plain = text(view({ status: { ...CLONE, version: { kind: "not-a-clone" } } }));
    expect(plain).toContain("Not a git clone");
    expect(plain).toContain("check for updates or update itself");
    expect(plain).not.toContain("Check for updates");
    const na = text(view({ status: "na" }));
    expect(na).toContain("To update, run pnpm run app-update in the Gates Local folder.");
    expect(na).not.toContain("Check for updates");
    expect(text(view({ status: undefined }))).toContain("Reading the version.");
  });

  it("shows checking while the check runs", () => {
    const html = view({ checking: true, ...withCheck({ state: "up-to-date", checkedAt: AT, channel: "main", current: "abc1234" }) });
    expect(text(html)).toContain("Checking…");
    expect(html).toContain("disabled");
    expect(text(html)).not.toContain("Up to date");
  });

  it("shows up to date with the channel and the time it checked", () => {
    const plain = text(view(withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "v0.2.0" })));
    expect(plain).toContain("Up to date");
    expect(plain).toContain("Following releases.");
    expect(plain).toMatch(/Checked at \S+/);
  });

  it("lists the changes with the rest folded, and the button only where it can update", () => {
    const changes = ["Five", "Four", "Three", "Two", "One"];
    const check: UpdateCheck = { state: "available", checkedAt: AT, channel: "main", current: "abc1234", target: "def5678", total: 25, changes };
    const html = view(withCheck(check));
    const plain = text(html);
    expect(plain).toContain("25 changes from abc1234 to def5678");
    const shown = html.slice(0, html.indexOf("<details"));
    expect(shown).toContain("Five");
    expect(shown).toContain("Three");
    expect(shown).not.toContain("Two");
    expect(plain).toContain("Show all 25 changes");
    expect(plain).toContain("…and 20 more.");
    expect(plain).not.toContain("Update and restart");
    expect(plain).toContain("pnpm run app-update");
    const desktop = text(view({ canUpdate: true, ...withCheck(check) }));
    expect(desktop).toContain("Update and restart");
    expect(desktop).toContain("goes back to abc1234");
    expect(text(view({ canUpdate: true, updating: true, ...withCheck(check) }))).toContain("Closing to update…");
  });

  it("shows a release's notes instead of the subjects", () => {
    const check: UpdateCheck = { state: "available", checkedAt: AT, channel: "release", current: "v0.1.0", target: "v0.2.0", total: 4, changes: ["a", "b"], notes: "Faster chat\nA new setting" };
    const plain = text(view(withCheck(check)));
    expect(plain).toContain("Faster chat");
    expect(plain).toContain("A new setting");
    expect(plain).not.toContain("Show all");
  });

  it("shows every reason it cannot check, with what to do", () => {
    const lines = ["These files have changes that are not saved in git:", "  app.txt", "Nothing was changed."];
    const plain = text(view(withCheck({ state: "cannot-check", checkedAt: AT, reason: "local-changes", lines })));
    expect(plain).toContain("Could not check for updates.");
    for (const l of lines) expect(plain).toContain(l.trim());
  });
});

const note = (result: UpdateStatus["result"] & object) => renderToStaticMarkup(createElement(ui.UpdateNoteView, { result, onDismiss: () => undefined }));
const hydrated = () => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open";

describe("the note after an update", () => {

  it("says it updated", () => {
    const plain = text(note({ at: 1, outcome: "updated", line: "Updated to v0.2.0, 3 changes." }));
    expect(plain).toContain("Gates Local updated");
    expect(plain).toContain("Updated to v0.2.0, 3 changes.");
    expect(plain).toContain("Dismiss");
  });

  it("says where a failed update stopped, the log, and the commands to finish by hand", () => {
    const plain = text(note({ at: 1, outcome: "rollback-failed", line: "The update to v0.2.0 stopped.", logPath: "update-logs/a.log", commands: ["git reset --keep abc1234", "pnpm install --frozen-lockfile"] }));
    expect(plain).toContain("The update did not finish");
    expect(plain).toContain("update-logs/a.log");
    expect(plain).toContain("git reset --keep abc1234");
    expect(plain).toContain("pnpm install --frozen-lockfile");
  });
});

describe("the check runs only on a click", () => {
  it("AU-02 an older bridge cannot silently discard the checked target", () => {
    vi.stubGlobal("gatesLocal", { getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart: async () => ({ ok: true }) });
    expect(session.canUpdateHere()).toBe(false);
  });
  it("AU-01 changed work at server confirmation shows the new list and cancel installs nothing", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 1, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => ({ ...OFFERED, activity: ["1 running reply"] }));
    b.server.answer("update.prepare", () => ({ state: "changed", status: { ...OFFERED, approval: "approval-new-work", activity: ["1 running reply", "model download: new-model"] } }));
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await session.updateAndRestart();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("model download: new-model"));
    expect(updateAndRestart).not.toHaveBeenCalled();
    expect(store.getState().updateInstalling).toBe(false);
  });

  it("AU-02 a new remote target requires its own approval and keeps the full target in the handoff", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 1, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => OFFERED);
    const newer = { ...OFFERED, approval: "approval-c", lastCheck: { state: "available" as const, checkedAt: 2, channel: "main" as const, current: "abc1234", target: "ccccccc", targetCommit: "c".repeat(40), total: 2, changes: ["Unapproved C", "Approved B"] } };
    b.server.answer("update.prepare", () => ({ state: "changed", status: newer }));
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await session.updateAndRestart();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("ccccccc"));
    expect(updateAndRestart).not.toHaveBeenCalled();
  });
  it("hydrate reads the status, opening Settings checks nothing, and the button checks once", async () => {
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await tick();
    expect(b.server.calls("update.status").length).toBe(1);
    expect(store.getState().update).toEqual(methodSamples["update.status"].result);
    session.openSettings("general");
    await until(() => store.getState().view === "settings", 5000, "Settings to open");
    await tick(10);
    expect(b.server.calls("update.check")).toEqual([]);
    expect(session.canUpdateHere()).toBe(false);

    const answer = methodSamples["update.check"].result;
    expect(await session.checkForUpdates()).toBeNull();
    expect(b.server.calls("update.check").length).toBe(1);
    const update = store.getState().update;
    expect(update !== undefined && update !== "na" && update.lastCheck).toEqual(answer);
  });

  it("a second click while one check runs waits for it instead of starting another", async () => {
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    const held = b.server.hold("update.check");
    const first = session.checkForUpdates();
    expect(store.getState().updateChecking).toBe(true);
    expect(await session.checkForUpdates()).toBeNull();
    (await held).respond(methodSamples["update.check"].result);
    expect(await first).toBeNull();
    expect(b.server.calls("update.check").length).toBe(1);
    expect(store.getState().updateChecking).toBe(false);
  });

  it("a server without updates marks the group not available", async () => {
    b.server.answer("update.status", () => {
      throw { code: "not-implemented", message: "no" };
    });
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    expect(store.getState().update).toBe("na");
  });

  it("the desktop bridge's Update and restart is used when it is there", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: false as const, message: "This folder is not a git clone of Gates Local, so it cannot update itself." }));
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 1, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => OFFERED);
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    expect(session.canUpdateHere()).toBe(true);
    expect(await session.updateAndRestart()).toBe("This folder is not a git clone of Gates Local, so it cannot update itself.");
    expect(updateAndRestart).toHaveBeenCalledTimes(1);
  });

  it("confirms work in other windows and keeps the app open when cancelled", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 1, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => ({ ...OFFERED, activity: ["2 running replies (including other windows)", "model download: alpha:7b", "1 image generation job"] }));
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    expect(await session.updateAndRestart()).toBeNull();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("model download: alpha:7b"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2 running replies"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("1 image generation job"));
    expect(updateAndRestart).not.toHaveBeenCalled();
    expect(store.getState().updateInstalling).toBe(false);
    expect(store.getState().updateError).toBeNull();
  });

  it("one click updates idle work; Settings and sidebar share installation state", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 1, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => OFFERED);
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    const first = session.updateAndRestart();
    const second = session.updateAndRestart();
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(updateAndRestart).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(updateAndRestart).toHaveBeenCalledWith({ reservation: "reservation-1", targetCommit: "b".repeat(40) });
    expect(store.getState().updateInstalling).toBe(true);
    const count = b.server.calls("update.check").length;
    await session.checkForUpdates();
    expect(b.server.calls("update.check")).toHaveLength(count);
  });

  it("a successful background check reaches every window through the shared channel", async () => {
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    const update = { ...CLONE, lastCheck: methodSamples["update.check"].result };
    b.server.push("update.changed", update);
    await tick();
    expect(store.getState().update).toEqual(update);
    expect(b.server.calls("update.check")).toHaveLength(0);
  });

  it("an automatic update arriving during hydration survives the older status snapshot", async () => {
    const held = b.server.hold("update.status");
    disconnect = session.connect();
    const request = await held;
    const newer = { ...CLONE, lastCheck: methodSamples["update.check"].result };
    b.server.push("update.changed", newer);
    await tick();
    request.respond(CLONE);
    await until(hydrated, 2000, "hydration");
    expect(store.getState().update).toEqual(newer);
  });
});

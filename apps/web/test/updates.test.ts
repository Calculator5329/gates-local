// Settings › General › Updates: each state of the group and the note after an
// update, rendered to markup from props, and the session's promise that the
// check runs only on a click (hydrate and opening Settings never call it).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Updates = typeof import("../src/Updates.tsx");
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
  ui = await import("../src/Updates.tsx");
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  disconnect = undefined;
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

const SETTINGS: Settings = methodSamples["settings.get"].result;
const CLONE: UpdateStatus = { version: { kind: "commit", commit: "abc1234", date: Date.UTC(2026, 10, 7) }, result: null, lastCheck: null };
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
  it("shows the version, the check button with words saying it runs only on a click, and the switch", () => {
    const html = view();
    expect(text(html)).toContain("Version");
    expect(html).toContain("abc1234");
    expect(text(html)).toContain("A commit from");
    expect(text(html)).toContain("Check for updates");
    expect(text(html)).toContain("Only when you click.");
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
    expect(plain).not.toContain("Check for updates");
    const na = text(view({ status: "na" }));
    expect(na).toContain("Not available in this build.");
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
  it("hydrate reads the status, opening Settings checks nothing, and the button checks once", async () => {
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await tick();
    expect(b.server.calls("update.status").length).toBe(1);
    expect(store.getState().update).toEqual(methodSamples["update.status"].result);
    session.openSettings("general");
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
    vi.stubGlobal("gatesLocal", { getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    expect(session.canUpdateHere()).toBe(true);
    expect(await session.updateAndRestart()).toBe("This folder is not a git clone of Gates Local, so it cannot update itself.");
    expect(updateAndRestart).toHaveBeenCalledTimes(1);
  });
});

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
/** The offered status, checked at another time. */
const at = (checkedAt: number, more: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...OFFERED, ...more, lastCheck: { ...(OFFERED.lastCheck as Extract<UpdateCheck, { state: "available" }>), checkedAt } });

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
/** An installed copy offered 1.2.4, checked at `checkedAt`, optionally downloading it. */
const offer = (checkedAt: number, download?: "downloading") => ({ status: { version: { kind: "installed" as const, version: "1.2.3" }, result: null, lastCheck: { state: "newer" as const, checkedAt, current: "1.2.3", target: "1.2.4", forThisCopy: true, lines: ["Version 1.2.4 is available."], page: "https://example.invalid/releases/latest", ...(download === undefined ? {} : { download }) }, activity: [] } });
/** The markup with tags dropped, for reading the words. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** Everything a person can read: the words, and each label's tip (hover or keyboard focus). */
const said = (html: string) => `${text(html)} ${[...html.matchAll(/aria-description="([^"]*)"/g)].map((m) => unescape(m[1] ?? "")).join(" ")}`;
/** Row 2's grey line: one element that never wraps (src-help), holding the state's line or the failure in its place. */
const stateLine = (html: string) => /<span class="(src-help(?: act-err)?)"[^>]*>([^<]*)<\/span>/.exec(html);
/** Rows and result blocks above the first switch: what the version and the check take up. */
const rowsAbove = (html: string) => {
  const swatch = html.indexOf('role="switch"');
  // The switch's own row starts before it.
  const end = swatch === -1 ? html.length : html.lastIndexOf('class="srow"', swatch);
  return (html.slice(0, end).match(/class="(?:srow|upd-res)"/g) ?? []).length;
};

describe("the Updates group", () => {
  it("AV-05 the notice belongs to Settings scrolling content instead of its horizontal sibling", async () => {
    disconnect = session.connect();
    await until(() => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open");
    const { settingsScreen } = await import("../src/screen-loaders.ts");
    await settingsScreen.load();
    session.openSettings();
    store.setState({ update: { ...CLONE, result: { at: 1, outcome: "stopped", line: "The update stopped. The previous version is restored." } } });
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
        else if (token.includes("The update did not finish")) { noticeParents = [...parents]; break; }
      }
      expect(noticeParents, "The actual app renders its update notice").toBeDefined();
      expect(noticeParents?.some(classes => classes.includes("set")), "AV-05 notice must share the Settings scrolling surface").toBe(true);
    } finally { useStore.mockRestore(); }
  });
  it("AV-01 a phone status offer exposes no update or preference controls", () => {
    const html = view({ status: { ...OFFERED, canControl: false }, settings: { ...SETTINGS, updateEveryChange: true }, canUpdate: false });
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
    // The row says what it sends; the schedule's detail is in its label's tooltip.
    expect(text(html)).toContain("git remote hourly");
    expect(html).toContain("15 seconds after startup, then hourly");
    expect(html).toContain('aria-label="Check for updates automatically"');
    expect(html).toContain('aria-checked="true"');
    expect(text(html)).toContain("Get every change, not only releases");
    expect(html).toContain('aria-checked="false"');
    expect(view({ settings: { ...SETTINGS, updateEveryChange: true } })).toContain('aria-checked="true"');
  });

  it("shows a release tag as the version, in the installed copy's form (no v)", () => {
    const html = text(view({ status: { ...CLONE, version: { kind: "release", tag: "v0.2.0", commit: "abc1234" } } }));
    expect(html).toContain("0.2.0");
    expect(html).not.toContain("v0.2.0");
  });

  it("shows only the version for a copy that is not a clone, or when the server has no updates", () => {
    const plain = text(view({ status: { ...CLONE, version: { kind: "not-a-clone" } } }));
    expect(plain).toContain("Can't update: not a git clone.");
    expect(plain).not.toContain("Check for updates");
    const na = text(view({ status: "na" }));
    expect(na).toContain("To update, run pnpm run app-update in the Gates Local folder.");
    expect(na).not.toContain("Check for updates");
    // Before the version arrives: the same row with a placeholder, no stand-in words to flash (docs/design.md).
    const before = view({ status: undefined });
    expect(before).toContain('aria-busy="true"');
    expect(before).toContain("data-skel");
    expect(text(before)).toContain("Version");
  });

  it("shows checking in the state row's label, keeping the button and the last checked time where they were", () => {
    const html = view({ checking: true, ...withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "abc1234" }) });
    expect(text(html)).toContain("Checking…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Check for updates<\/button>/);
    expect(text(html)).not.toContain("Up to date");
    expect(text(html)).toMatch(/Checked at \S+/);
    expect(rowsAbove(html)).toBe(rowsAbove(view(withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "abc1234" }))));
  });

  it("is two rows when up to date: Version with the commit said once, then the state with the time it checked and the button", () => {
    const html = view(withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "abc1234" }));
    const plain = text(html);
    expect(rowsAbove(html)).toBe(2);
    expect(plain.split("abc1234").length - 1).toBe(1);
    expect(plain).toContain("Up to date");
    expect(plain).toMatch(/Checked at \S+/);
    expect(plain).toMatch(/A commit from \w+ \d+, 2026, between releases\./);
    expect(plain).not.toContain("Asks this copy's git remote");
    expect(plain).not.toContain("Following every change on the main branch.");
    // The channel is said once, in the version's row, and follows the switch: a check made before it flipped does not say otherwise.
    const every = { ...SETTINGS, updateEveryChange: true };
    const mainCheck = withCheck({ state: "up-to-date", checkedAt: AT, channel: "main", current: "abc1234" });
    expect(text(view(mainCheck))).toMatch(/A commit from \w+ \d+, 2026, between releases\./);
    expect(text(view({ ...mainCheck, settings: every }))).toMatch(/A commit from \w+ \d+, 2026 on the main branch\./);
    expect(text(view({ settings: every }))).toMatch(/A commit from \w+ \d+, 2026 on the main branch\./);
    // Row 9: the server drops the last check when the switch flips, so row 2 shows the check it sends. A clone with
    // no release tags checks main with the switch off, and that answer is offered.
    const mainFound: UpdateCheck = { state: "available", checkedAt: AT, channel: "main", current: "abc1234", target: "def5678", total: 2, changes: ["Two", "One"] };
    expect(text(view(mainCheck))).toContain("Up to date");
    const noTags = view({ canUpdate: true, ...withCheck(mainFound) });
    expect(text(noTags)).toContain("Update available: def5678");
    expect(text(noTags)).toContain("Restart to update");
    expect(text(view({ settings: every, ...mainCheck }))).toContain("Up to date");
    // Before any check: the same two rows.
    expect(rowsAbove(view())).toBe(2);
    expect(text(view())).toContain("Not checked yet");
  });

  it("lists the first changes in the label's tip, and the button only where it can update", () => {
    const changes = ["Five", "Four", "Three", "Two", "One"];
    const check: UpdateCheck = { state: "available", checkedAt: AT, channel: "release", current: "abc1234", target: "def5678", total: 25, changes };
    const html = view(withCheck(check));
    const plain = text(html);
    expect(plain).toContain("Update available: def5678");
    expect(plain.split("abc1234").length - 1).toBe(1);
    expect(said(html)).toContain("25 changes: Five; Four; Three; and 22 more.");
    expect(said(html)).not.toContain("Two");
    expect(plain).not.toContain("Restart to update");
    expect(plain).toContain("pnpm run app-update");
    const desktop = view({ canUpdate: true, ...withCheck(check) });
    expect(text(desktop)).toContain("Restart to update");
    expect(text(desktop)).toMatch(/25 changes\. Checked at \S+/);
    expect(said(desktop)).toContain("goes back to abc1234");
    expect(text(view({ canUpdate: true, updating: true, ...withCheck(check) }))).toContain("Closing to update…");
  });

  it("puts a release's notes in the tip instead of the subjects", () => {
    const check: UpdateCheck = { state: "available", checkedAt: AT, channel: "release", current: "v0.1.0", target: "v0.2.0", total: 4, changes: ["a", "b"], notes: "Faster chat\nA new setting" };
    const all = said(view(withCheck(check)));
    expect(all).toContain("Release notes: Faster chat; A new setting.");
    expect(all).not.toContain("4 changes");
  });

  it("says every reason it cannot check: the first on the row, all of them and when it tried in the tip", () => {
    // the check ran and found changes: the footer's "Can't update itself", and the line ends as a sentence (the files are in the tip)
    const lines = ["1 file has changes that are not saved in git:", "  app.txt", "Nothing was changed."];
    const html = view(withCheck({ state: "cannot-check", checkedAt: AT, reason: "local-changes", lines }));
    expect(text(html)).toContain("Can't update itself");
    expect(text(html)).not.toContain("Couldn’t check");
    expect(stateLine(html)?.[2]).toBe("1 file has changes that are not saved in git.");
    for (const l of lines) expect(said(html)).toContain(l.trim());
    expect(said(html)).toMatch(/Tried at \S+/);
    // a check that did not answer still says so
    expect(text(view(withCheck({ state: "cannot-check", checkedAt: AT, reason: "unreachable", lines: ["Could not reach the update server."] })))).toContain("Couldn’t check");
  });

  it("every state is the same two rows: one grey line that never wraps, a failure in its place, nothing added under them", () => {
    const states: [string, Partial<Parameters<Updates["UpdatesView"]>[0]>][] = [
      ["not checked", {}],
      ["checking first", { checking: true }],
      ["up to date", withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "abc1234" })],
      ["found", withCheck({ state: "available", checkedAt: AT, channel: "release", current: "abc1234", target: "def5678", total: 25, changes: ["Five", "Four", "Three", "Two"] })],
      ["found, desktop", { canUpdate: true, ...withCheck({ state: "available", checkedAt: AT, channel: "release", current: "abc1234", target: "def5678", total: 2, changes: ["Two", "One"] }) }],
      ["failed", withCheck({ state: "cannot-check", checkedAt: AT, reason: "error", lines: ["The check stopped on an error: git fetch failed", "Try again, or run pnpm run app-update --check in the Gates Local folder to see more."] })],
      // Clicked while the check at AT showed, so that check is no newer than the failure.
      ["the call failed", { checkErr: "Gates Local is not answering. Try again in a moment.", checkErrSince: AT, ...withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "abc1234" }) }],
      ["the update failed", { canUpdate: true, updateErr: "The update could not start.", ...withCheck({ state: "available", checkedAt: AT, channel: "release", current: "abc1234", target: "def5678", total: 1, changes: ["One"] }) }],
    ];
    for (const [name, over] of states) {
      const html = view(over);
      expect(rowsAbove(html), name).toBe(2);
      expect(html, name).not.toContain("upd-res");
      expect(html, name).not.toContain('class="act-err"');
      expect(stateLine(html)?.[2]?.trim(), `${name}: row 2 has its one grey line`).not.toBe(undefined);
    }
    const failed = view(states[6]?.[1]);
    expect(stateLine(failed)?.[1]).toBe("src-help act-err");
    expect(stateLine(failed)?.[2]).toBe("Gates Local is not answering. Try again in a moment.");
    expect(text(failed)).not.toMatch(/Checked at/);
    expect(stateLine(view(states[7]?.[1]))?.[2]).toBe("The update could not start.");
  });

  it("UR-02 a newer check or a later action's failure replaces an old check failure", () => {
    const callFailed = "Gates Local is not answering. Try again in a moment.";
    const newer = withCheck({ state: "cannot-check", checkedAt: AT + 60_000, reason: "error", lines: ["The check stopped on an error: git fetch failed"] });
    // The click failed while the check at AT showed; a background check answered a minute later.
    const later = view({ checkErr: callFailed, checkErrSince: AT, ...newer });
    expect(stateLine(later)?.[1]).toBe("src-help");
    expect(stateLine(later)?.[2]).toBe("The check stopped on an error: git fetch failed");
    expect(text(later)).not.toContain(callFailed);
    // Failed before any check; any check since is newer.
    expect(text(view({ checkErr: callFailed, checkErrSince: null, ...withCheck({ state: "up-to-date", checkedAt: AT, channel: "release", current: "abc1234" }) }))).not.toContain(callFailed);
    // A failure of a later click wins over the old check failure still standing.
    const found = withCheck({ state: "available", checkedAt: AT, channel: "release", current: "abc1234", target: "def5678", total: 1, changes: ["One"] });
    expect(stateLine(view({ canUpdate: true, checkErr: callFailed, checkErrSince: AT, updateErr: "The update could not start.", ...found }))?.[2]).toBe("The update could not start.");
    expect(stateLine(view({ checkErr: callFailed, checkErrSince: AT, downloadErr: "The download stopped.", downloadErrSince: AT, ...found }))?.[2]).toBe("The download stopped.");
  });

  it("row 11 a failed Download gives way to a newer check, or to the server saying it downloads", () => {
    const failed = "The download stopped.";
    // Clicked while the check at AT showed: still the newest news.
    expect(stateLine(view({ downloadErr: failed, downloadErrSince: AT, ...offer(AT) }))?.[2]).toBe(failed);
    // A check a minute later answers instead.
    expect(text(view({ downloadErr: failed, downloadErrSince: AT, ...offer(AT + 60_000) }))).not.toContain(failed);
    // The server says the download runs after all.
    expect(text(view({ downloadErr: failed, downloadErrSince: AT, ...offer(AT, "downloading") }))).not.toContain(failed);
  });
});

describe("the Updates group of an installed copy", () => {
  const INSTALLED: UpdateStatus = { version: { kind: "installed", version: "1.2.3" }, result: null, lastCheck: null, activity: [], installing: false };
  const PAGE = "https://example.invalid/owner/repo/releases/latest";
  const installedWith = (lastCheck: UpdateCheck) => ({ status: { ...INSTALLED, lastCheck } });
  const link = `<a class="link" href="${PAGE}" data-testid="settings.updates.release-page" target="_blank" rel="noreferrer noopener">Open the release page</a>`;

  it("names the copy, checks the release page and has no git words or clone switches", () => {
    const html = view({ status: INSTALLED });
    const plain = text(html);
    expect(plain.split("1.2.3").length - 1).toBe(1);
    expect(plain).toContain("An installed copy, following releases.");
    expect(rowsAbove(html)).toBe(2);
    expect(plain).toContain("Check for updates");
    expect(html).toContain('aria-label="Check for updates automatically"');
    expect(plain).not.toContain("Get every change");
    expect(plain).not.toMatch(/git|clone|pnpm/i);
  });

  it.each([
    ["development build", { state: "cannot-check", checkedAt: AT, reason: "development", lines: ["This is a development build, so it does not check for updates."] }, false],
    ["no key", { state: "cannot-check", checkedAt: AT, reason: "no-key", lines: ["This build has no release key, so it cannot check for updates. Download the latest version from the release page."], page: PAGE }, true],
    ["could not reach", { state: "cannot-check", checkedAt: AT, reason: "unreachable", lines: ["Could not reach the update server. Check your connection."] }, false],
    ["no list", { state: "cannot-check", checkedAt: AT, reason: "no-list", lines: ["No release list was found on the release page."] }, false],
    ["bad signature", { state: "cannot-check", checkedAt: AT, reason: "bad-signature", lines: ["The release list did not pass its signature check, so Gates Local ignored it. Nothing was downloaded. If this keeps happening, download the latest version from the release page."], page: PAGE }, true],
    ["available", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is available."], page: PAGE }, false],
    ["downloading", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Downloading version 1.3.0 (12 of 98 MB). You can keep chatting."], page: PAGE, download: "downloading" }, false],
    ["bad download", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["The download of version 1.3.0 did not match the signed release list, so it was deleted."], page: PAGE, download: "bad" }, false],
    ["could not download", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Could not download version 1.3.0. Check your connection."], page: PAGE, download: "failed" }, false],
    ["disk", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Not enough free space on /home for version 1.3.0 (needs 98 MB, 12 MB free). Free some space, then use Check for updates."], page: PAGE, download: "disk" }, false],
    ["downloaded", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is downloaded and checked. This copy cannot install it by itself yet. To update now, download it from the release page."], page: PAGE, download: "ready" }, true],
    ["not for this copy", { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: false, lines: ["Version 1.3.0 is available, but this copy cannot install it by itself. Download it from the release page."], page: PAGE }, true],
  ] satisfies [string, UpdateCheck, boolean][])("%s: says the server's words, links the release page only when they send the person there", (_name, check, linked) => {
    const html = view({ canUpdate: true, ...installedWith(check) });
    const plain = said(html);
    for (const line of check.lines) expect(plain).toContain(line);
    expect(html.includes(link)).toBe(linked);
    expect(plain).not.toContain("Could not check for updates.");
    expect(plain).not.toContain("Update and restart");
    expect(plain).not.toMatch(/git|pnpm/i);
  });

  it("downloaded on Windows: the card's line is that it does not go back by itself, and the tip says how to go back", () => {
    const back = "If version 1.3.0 does not start, Gates Local will not go back by itself. To go back, run Setup-1.2.3.exe.";
    const html = view({ canUpdate: true, ...installedWith({ state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is downloaded and checked.", back], page: PAGE, download: "ready", restart: true }) });
    expect(stateLine(html)?.[2]).toBe("Does not go back by itself if 1.3.0 does not start.");
    expect(said(html)).toContain("To go back, run Setup-1.2.3.exe.");
    expect(html).toMatch(/<button[^>]*>Restart to update<\/button>/);
  });

  it("UW-06 downloaded on a copy that can replace its file: Restart to update in the desktop app, no release page", () => {
    const ready = installedWith({ state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is downloaded and checked."], page: PAGE, download: "ready", restart: true });
    const html = view({ canUpdate: true, ...ready });
    const plain = text(html);
    expect(plain).toContain("Version 1.3.0 is downloaded and checked.");
    expect(html).toMatch(/<button[^>]*>Restart to update<\/button>/);
    expect(said(html)).toContain("Gates Local will close, update and reopen.");
    expect(html.includes(link)).toBe(false);
    expect(text(view({ canUpdate: true, updating: true, ...ready }))).toContain("Closing to update…");
    // A browser tab or the phone never gets the button.
    expect(text(view({ canUpdate: false, ...ready }))).not.toContain("Restart to update");
    // A copy that cannot replace its file says why and links the release page.
    const refused = installedWith({ state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Gates Local cannot replace its own file because its folder is read-only. Download version 1.3.0 from the release page and replace the file yourself."], page: PAGE, download: "ready" });
    const no = view({ canUpdate: true, ...refused });
    expect(no.includes(link)).toBe(true);
    expect(text(no)).not.toContain("Restart to update");
  });

  it.each([
    ["could not reach", "unreachable", "Could not reach the update server. Check your connection."],
    ["no list", "no-list", "No release list was found on the release page."],
  ] as const)("%s: says it will try again only while automatic checks are on now", (_name, reason, line) => {
    const failed = installedWith({ state: "cannot-check", checkedAt: AT, reason, lines: [line] });
    const again = "Gates Local will try again in an hour.";
    expect(said(view({ ...failed, settings: SETTINGS }))).toContain(again);
    expect(said(view({ ...failed, settings: { ...SETTINGS, updateAutomatic: true } }))).toContain(again);
    const off = said(view({ ...failed, settings: { ...SETTINGS, updateAutomatic: false } }));
    expect(off).toContain(line);
    expect(off).not.toContain(again);
    // Other failures never promise a retry.
    expect(said(view(installedWith({ state: "cannot-check", checkedAt: AT, reason: "bad-signature", lines: ["x"], page: PAGE })))).not.toContain(again);
  });

  const newer = (over: Partial<UpdateCheck & { state: "newer" }> = {}): UpdateCheck => ({ state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is available."], page: PAGE, ...over });
  const OFF = { ...SETTINGS, updateAutomatic: false };
  const ON = { ...SETTINGS, updateAutomatic: true };

  it.each([
    ["bad download", "bad", "Use Check for updates to try again."],
    ["could not download", "failed", "Gates Local will try again in an hour."],
  ] as const)("%s: says how it is tried again only while automatic checks are on now", (_name, download, again) => {
    const failed = installedWith(newer({ download, lines: ["x"] }));
    expect(said(view({ ...failed, settings: ON }))).toContain(again);
    expect(said(view({ ...failed, settings: OFF }))).not.toContain(again);
    // Neither bracket belongs to any other state.
    for (const other of ["downloading", "disk", "ready"] as const) {
      const plain = said(view({ ...installedWith(newer({ download: other })), settings: ON }));
      expect(plain).not.toContain("Use Check for updates to try again");
      expect(plain).not.toContain("try again in an hour");
    }
  });

  it("offers Download for a version this copy can use only while automatic checks are off", () => {
    const button = '<button type="button" class="btn outline" data-testid="settings.updates.download">Download</button>';
    const onDownload = vi.fn();
    const off = view({ ...installedWith(newer()), settings: OFF, onDownload });
    expect(off).toContain(button);
    expect(text(off)).toContain("Update available: 1.3.0");
    expect(said(off)).toContain("Version 1.3.0 is available.");
    expect(view({ ...installedWith(newer()), settings: ON, onDownload })).not.toContain(button);
    expect(view({ ...installedWith(newer({ forThisCopy: false })), settings: OFF, onDownload })).not.toContain(button);
    for (const download of ["downloading", "bad", "failed", "disk", "ready"] as const) {
      expect(view({ ...installedWith(newer({ download })), settings: OFF, onDownload })).not.toContain(button);
    }
    // A phone sees the words and no control.
    expect(view({ status: { ...INSTALLED, lastCheck: newer(), canControl: false }, settings: OFF, onDownload })).not.toContain(button);
  });

  it("none found: two rows, the version said once", () => {
    const html = view(installedWith({ state: "up-to-date", checkedAt: AT, channel: "release", current: "1.2.3" }));
    const plain = text(html);
    expect(rowsAbove(html)).toBe(2);
    expect(plain).toContain("Up to date");
    expect(plain).toMatch(/Checked at \S+/);
    expect(plain.split("1.2.3").length - 1).toBe(1);
    expect(plain).not.toContain("No newer version was found.");
    expect(plain).not.toContain("Following releases");
  });

  it("puts no install control in the sidebar for a newer version", async () => {
    const { updateIcon } = await import("../src/update-state.ts");
    // Not ready, not update: the icon downloads it, and a downloaded version goes to the release page.
    expect(updateIcon({ status: { ...INSTALLED, lastCheck: { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: [], page: PAGE } }, desktop: true })?.click).toBe("download");
    expect(updateIcon({ status: { ...INSTALLED, lastCheck: { state: "newer", checkedAt: AT, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: [], page: PAGE, download: "ready" } }, desktop: true })?.click).toBe("page");
  });
});

const note = (result: UpdateStatus["result"] & object) =>renderToStaticMarkup(createElement(ui.UpdateNoteView, { result, onDismiss: () => undefined }));
// The page is ready without image.status now (it waits on ComfyUI), so hydration here is the update read landing.
const hydrated = () => store.getState().imageStatus !== undefined && store.getState().update !== undefined && store.getState().conn.kind === "open";

describe("the note after an update", () => {

  it("keeps successful updates silent", () => {
    expect(note({ at: 1, outcome: "updated", line: "Updated to v0.2.0, 3 changes." })).toBe("");
  });

  it("says where a failed update stopped, the log, and the commands to finish by hand", () => {
    const plain = text(note({ at: 1, outcome: "rollback-failed", line: "The update to v0.2.0 stopped.", logPath: "update-logs/a.log", commands: ["git reset --keep abc1234", "pnpm install --frozen-lockfile"] }));
    expect(plain).toContain("The update did not finish");
    expect(plain).toContain("update-logs/a.log");
    expect(plain).toContain("git reset --keep abc1234");
    expect(plain).toContain("pnpm install --frozen-lockfile");
  });
});

describe("dismissing the note on a phone", () => {
  it("clears the phone's note and sends no update.dismissResult", async () => {
    b.server.answer("update.status", () => ({ ...CLONE, canControl: false, result: { at: 1, outcome: "updated", line: "Updated to v0.2.0." } }));
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await session.dismissUpdateResult();
    expect(store.getState().update).toMatchObject({ result: null });
    expect(b.server.calls("update.dismissResult")).toEqual([]);
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
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 2, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => ({ ...OFFERED, activity: ["1 running reply"] }));
    b.server.answer("update.prepare", () => ({ state: "changed", status: { ...OFFERED, approval: "approval-new-work", activity: ["1 running reply", "model download: new-model"] } }));
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await session.updateAndRestart();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Download of new-model stops."));
    expect(updateAndRestart).not.toHaveBeenCalled();
    expect(store.getState().updateInstalling).toBe(false);
  });

  it("AU-02 a new remote target requires its own approval and keeps the full target in the handoff", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 2, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
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

  it("a check that answered anywhere since clears a failed install's words, but not while an install runs", async () => {
    b.server.answer("update.status", () => OFFERED);
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    await until(() => store.getState().update !== undefined && store.getState().update !== "na", 2000, "the status");
    store.setState({ updateError: "Couldn't start the update." });
    b.server.broadcast("update.changed", at(1, { activity: ["1 running reply"] }));
    await tick();
    expect(store.getState().updateError, "the same check again is no news").toBe("Couldn't start the update.");
    b.server.broadcast("update.changed", at(2, { installing: true }));
    await tick();
    expect(store.getState().updateError, "another window's install runs").toBe("Couldn't start the update.");
    store.setState({ updateInstalling: true });
    b.server.broadcast("update.changed", at(3));
    await tick();
    expect(store.getState().updateError, "this window's install runs").toBe("Couldn't start the update.");
    store.setState({ updateInstalling: false });
    b.server.broadcast("update.changed", at(4));
    await tick();
    expect(store.getState().updateError).toBeNull();
  });

  it("the Download click sends update.download once and shows the answer", async () => {
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    const answer = methodSamples["update.download"].result;
    expect(b.server.calls("update.download")).toEqual([]);
    expect(await session.downloadUpdate()).toBeNull();
    expect(b.server.calls("update.download").length).toBe(1);
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
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 2, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
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
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 2, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => ({ ...OFFERED, activity: ["2 running replies (including other windows)", "model download: alpha:7b", "1 image generation job"] }));
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    expect(await session.updateAndRestart()).toBeNull();
    // the same lines as the footer's ask (update-work.ts), each said once
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Download of alpha:7b stops. It resumes."));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("2 replies stop. Their text is kept."));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("1 image job stops."));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Falls back to abc1234 if a step fails."));
    expect(confirm).not.toHaveBeenCalledWith(expect.stringMatching(/including other windows|Save unsent drafts|kept as interrupted/));
    expect(updateAndRestart).not.toHaveBeenCalled();
    expect(store.getState().updateInstalling).toBe(false);
    expect(store.getState().updateError).toBeNull();
  });

  it("one click updates idle work; Settings and sidebar share installation state", async () => {
    const updateAndRestart = vi.fn(async () => ({ ok: true as const }));
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("gatesLocal", { updateApprovalVersion: 2, getServerUrl: async () => "ws://127.0.0.1:1/?token=t", updateAndRestart });
    b.server.answer("update.status", () => OFFERED);
    disconnect = session.connect();
    await until(hydrated, 2000, "hydration");
    const first = session.updateAndRestart();
    const second = session.updateAndRestart();
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(updateAndRestart).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(updateAndRestart).toHaveBeenCalledWith({ reservation: "reservation-1", target: "b".repeat(40) });
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

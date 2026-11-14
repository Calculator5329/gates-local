// The sidebar's update icon: one state per row of the footer table, for each
// kind of copy (a git clone, an installed copy, a copy that is neither).
import { describe, expect, it } from "vitest";
import { UpdateBlocked, type UpdateCheck, type UpdateStatus } from "@gates-local/contracts";
import { restartable, updateIcon, type UpdateInput, ver } from "../src/update-state.ts";

const clock = (ms: number) => `T${ms}`;
const clone: UpdateStatus = { version: { kind: "commit", commit: "abc1234" }, result: null, lastCheck: null };
const installed: UpdateStatus = { version: { kind: "installed", version: "1.2.3" }, result: null, lastCheck: null };
const neither: UpdateStatus = { version: { kind: "not-a-clone" }, result: null, lastCheck: null };
const PAGE = "https://example.invalid/releases";
const available = { state: "available", checkedAt: 5, current: "abc1234", target: "def5678", channel: "main", total: 3, changes: ["Faster chat"] } as const satisfies UpdateCheck;
const newer = (o: Partial<Extract<UpdateCheck, { state: "newer" }>> = {}): UpdateCheck => ({ state: "newer", checkedAt: 7, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is available."], page: PAGE, ...o });
const icon = (status: UpdateStatus | null, more: Partial<UpdateInput> = {}) => updateIcon({ status, desktop: true, clock, ...more });
const withCheck = (s: UpdateStatus, lastCheck: UpdateCheck): UpdateStatus => ({ ...s, lastCheck });
/** An available target this window can install: a checked commit and the server's approval for it. */
const fresh: UpdateStatus = { ...clone, approval: "a1", lastCheck: { ...available, targetCommit: `def5678${"0".repeat(33)}` } };

describe("up to date or nothing known", () => {
  it("is the muted arrows and checks on click, before the status arrives", () => {
    expect(icon(null)).toMatchObject({ state: "idle", click: "check", dot: null, busy: false, label: "Check for updates" });
    expect(icon(null)?.tip).toContain("Not checked since Gates Local started");
  });
  it("says when a clone was last found up to date", () => {
    const i = icon(withCheck(clone, { state: "up-to-date", checkedAt: 9, channel: "main", current: "abc1234" }));
    expect(i).toMatchObject({ state: "idle", click: "check", dot: null });
    expect(i?.tip).toContain("Up to date (abc1234)");
    expect(i?.tip).toContain("Checked at T9");
  });
  it("says when an installed copy found nothing newer", () => {
    const i = icon(withCheck(installed, { state: "up-to-date", checkedAt: 9, channel: "release", current: "1.2.3" }));
    expect(i).toMatchObject({ state: "idle", click: "check" });
    expect(i?.tip).toContain("No newer version was found");
  });
  it("treats a finished update as nothing to do", () => {
    expect(icon({ ...clone, result: { at: 1, outcome: "updated", line: "Updated to v0.2.0, 3 changes." } })).toMatchObject({ state: "idle" });
  });
});

describe("one form across the clone and the installed copy", () => {
  it("a version reads without its v; a commit passes through", () => {
    expect(ver("v0.2.5")).toBe("0.2.5");
    expect(ver("0.2.5")).toBe("0.2.5");
    expect(ver("def5678")).toBe("def5678");
    expect(icon(withCheck(clone, { ...available, current: "v0.2.4", target: "v0.2.5" }))?.label).toBe("Update to 0.2.5");
  });
});

describe("checking", () => {
  it("spins, does nothing on click and keeps its words", () => {
    expect(icon(clone, { checking: true })).toMatchObject({ state: "checking", click: null, busy: true, label: "Checking for updates…" });
    expect(icon(installed, { checking: true })?.state).toBe("checking");
  });
});

describe("available", () => {
  it("a clone: names the target and updates after a confirm", () => {
    const i = icon(fresh);
    expect(i).toMatchObject({ state: "available", click: "update", dot: "amber", label: "Update to def5678" });
    expect(i?.tip).toContain("3 changes from abc1234 to def5678");
    expect(i?.tip).toContain("Checked at T5");
    expect(i?.tip).toMatch(/closes while it updates/);
  });
  it("a clone: the tooltip keeps what the old button said, the release notes or else the change titles, escaped", () => {
    expect(icon(withCheck(clone, available))?.tip).toContain("<br>Faster chat<br>");
    expect(icon(withCheck(clone, { ...available, notes: "Faster <chat>\nFewer stalls" }))?.tip).toContain("<br>Faster &lt;chat&gt;<br>Fewer stalls<br>");
    const many = { ...available, total: 7, changes: ["a", "b", "c", "d", "e", "f", "g"] };
    expect(icon(withCheck(clone, many))?.tip).toContain("<br>a<br>b<br>c<br>d<br>e<br>and 2 more<br>");
  });
  it("an installed copy: downloads it", () => {
    const i = icon(withCheck(installed, newer()));
    expect(i).toMatchObject({ state: "available", click: "download", dot: "amber", label: "Download version 1.3.0" });
    expect(i?.tip).toContain("Version 1.3.0 is available.");
  });
});

describe("downloading", () => {
  it("an installed copy: a ring with no click, and the server's own progress words", () => {
    const i = icon(withCheck(installed, newer({ download: "downloading", lines: ["Downloading version 1.3.0 (40 of 96 MB). You can keep chatting."] })));
    expect(i).toMatchObject({ state: "downloading", click: null, busy: true, progress: null });
    expect(i?.tip).toContain("40 of 96 MB");
  });
  it("a clone never downloads", () => {
    for (const s of [clone, withCheck(clone, available)]) expect(icon(s)?.state).not.toBe("downloading");
  });
});

describe("ready", () => {
  it("only when the copy can really restart into it: the green arrows and a green dot", () => {
    const ready = withCheck(installed, newer({ download: "ready", lines: ["Version 1.3.0 is downloaded and checked."] }));
    expect(icon(ready, { canRestart: true })).toMatchObject({ state: "ready", click: "restart", dot: "green", label: "Restart to update" });
  });
  it("nothing today: an installed copy's downloaded version goes to the release page", () => {
    const ready = withCheck(installed, newer({ download: "ready", lines: ["Version 1.3.0 is downloaded and checked. This copy cannot install it by itself yet. To update now, download it from the release page."] }));
    const i = icon(ready);
    expect(i).toMatchObject({ state: "external", click: "page", page: PAGE, dot: "amber" });
    expect(i?.tip).toContain("cannot install it by itself");
  });
  it("a clone never shows it", () => {
    expect(icon(withCheck(clone, available), { canRestart: true })?.state).toBe("available");
  });
  it("UW-01 an installed copy can restart only when the server says it can and approves this version, in the desktop app", () => {
    const ready = { ...withCheck(installed, newer({ download: "ready", restart: true, lines: ["Version 1.3.0 is downloaded and checked."] })), approval: "a1" };
    expect(restartable(ready, true)).toBe(true);
    expect(icon(ready, { canRestart: restartable(ready, true) })).toMatchObject({ state: "ready", click: "restart" });
    expect(restartable(ready, false)).toBe(false);
    expect(restartable({ ...ready, approval: undefined }, true)).toBe(false);
    expect(restartable(withCheck(installed, newer({ download: "ready", lines: ["Gates Local cannot replace its own file because its folder is read-only."] })), true)).toBe(false);
    expect(restartable({ ...fresh }, true)).toBe(false);
  });
});

describe("updating", () => {
  it("this window's click or the server's word: a spinner, no click", () => {
    expect(icon(withCheck(clone, available), { installing: true })).toMatchObject({ state: "updating", click: null, busy: true, label: "Closing to update…" });
    expect(icon({ ...withCheck(clone, available), installing: true })?.state).toBe("updating");
  });
  it("UW-02 an installed copy says it closes, updates and reopens, never that dependencies install", () => {
    const i = icon(withCheck(installed, newer({ download: "ready", restart: true })), { installing: true });
    expect(i?.tip).toContain("Gates Local will close, update and reopen.");
    expect(i?.tip).not.toContain("dependencies");
  });
  it("UW-03 after a restart click failed, an installed copy that can still restart offers Restart again", () => {
    const ready = { ...withCheck(installed, newer({ download: "ready", restart: true })), approval: "a1" };
    expect(icon(ready, { canRestart: true, error: "The update approval expired or changed." })).toMatchObject({ state: "failed", click: "restart" });
  });
  it("UW-04 a rolled-back update says so and the click dismisses the note", () => {
    const back = { ...withCheck(installed, newer()), result: { at: 1, outcome: "rolled-back" as const, line: "Version 1.3.0 did not start, so Gates Local went back to 1.2.3. Your chats are as they were when you clicked Restart." } };
    const i = icon(back);
    expect(i).toMatchObject({ state: "failed", dismiss: true });
    expect(i?.tip).toContain("went back to 1.2.3");
  });
});

describe("failed", () => {
  it("a click that could not start: the reason, and the click tries the update again when the target is fresh, or checks first", () => {
    const i = icon(fresh, { error: "Could not start the <updater>" });
    expect(i).toMatchObject({ state: "failed", click: "update", dot: null });
    expect(i?.tip).toContain("Could not start the &lt;updater&gt;");
    expect(icon(withCheck(clone, available), { error: "x" })).toMatchObject({ state: "failed", click: "check" });
    expect(icon(clone, { error: "x" })?.tip).toContain("Click to check again.");
  });
  it("the last run stopped: the line and where the log is, and the click dismisses it as it acts", () => {
    const i = icon({ ...clone, result: { at: 1, outcome: "stopped", line: "Build failed; still on abc1234.", logPath: "update-logs/run.log", commands: ["git reset --hard abc1234"] } });
    expect(i).toMatchObject({ state: "failed", click: "check", dismiss: true });
    expect(i?.tip).toContain("Build failed; still on abc1234.");
    expect(i?.tip).toContain("update-logs/run.log");
    expect(i?.tip).toContain("git reset --hard abc1234");
    expect(icon({ ...fresh, result: { at: 1, outcome: "refused", line: "Refused." } })).toMatchObject({ state: "failed", click: "update", dismiss: true });
  });
  it("a rollback that failed: the click opens Settings › General, where its commands are, and keeps the note", () => {
    const i = icon({ ...fresh, result: { at: 1, outcome: "rollback-failed", line: "Could not go back.", commands: ["git reset --hard abc1234"] } });
    expect(i).toMatchObject({ state: "failed", click: "settings" });
    expect(i?.dismiss).toBeFalsy();
    expect(i?.tip).toContain("Click to open Settings");
    expect(i?.tip).not.toContain("try again");
  });
  it("an available target with no checked commit or approval checks first", () => {
    expect(icon(withCheck(clone, available))).toMatchObject({ state: "available", click: "check" });
    expect(icon(fresh)).toMatchObject({ state: "available", click: "update" });
  });
  it("a footer check or download that failed: the same words Settings shows, and the next click checks again", () => {
    const i = icon(withCheck(clone, available), { clickError: { click: "check", message: "Could not reach <the> server.", since: 5 } });
    expect(i).toMatchObject({ state: "failed", click: "check", label: "Could not check for updates" });
    expect(i?.tip).toContain("Could not reach &lt;the&gt; server.");
    expect(i?.tip).toContain("Click to check again.");
    expect(icon(withCheck(installed, newer()), { clickError: { click: "download", message: "No space.", since: 7 } })).toMatchObject({ state: "failed", click: "check", label: "Download failed" });
  });
  it("good news clears a footer error: a check that answered anywhere since, or a download the server says runs or is done", () => {
    const failedCheck = { click: "check", message: "No answer.", since: 4 } as const;
    expect(icon(withCheck(clone, available), { clickError: failedCheck })).toMatchObject({ state: "available", dot: "amber" });
    expect(icon(withCheck(clone, { ...available, checkedAt: 4 }), { clickError: failedCheck })).toMatchObject({ state: "failed" });
    expect(icon(withCheck(clone, available), { clickError: { ...failedCheck, since: null } })).toMatchObject({ state: "available" });
    expect(icon(clone, { clickError: { ...failedCheck, since: null } })).toMatchObject({ state: "failed" });
    const failedDownload = { click: "download", message: "No space.", since: 7 } as const;
    expect(icon(withCheck(installed, newer({ download: "downloading", lines: ["Downloading."] })), { clickError: failedDownload })).toMatchObject({ state: "downloading" });
    expect(icon(withCheck(installed, newer({ download: "ready" })), { clickError: failedDownload })).not.toMatchObject({ state: "failed" });
    expect(icon(withCheck(installed, newer({ download: "failed" })), { clickError: failedDownload })).toMatchObject({ state: "failed", label: "Download failed" });
    expect(icon(withCheck(installed, newer({ checkedAt: 9 })), { clickError: failedDownload })).toMatchObject({ state: "available" });
    // an install that still runs keeps its own look; a failed rollback stays
    expect(icon(withCheck(clone, available), { clickError: failedCheck, installing: true })).toMatchObject({ state: "updating" });
    expect(icon({ ...withCheck(clone, available), result: { at: 1, outcome: "rollback-failed", line: "Going back failed." } }, { clickError: failedCheck })).toMatchObject({ state: "failed", click: "settings" });
  });
  it("a download just clicked is busy until the server says where it is", () => {
    expect(icon(withCheck(installed, newer()), { downloading: true })).toMatchObject({ state: "downloading", click: null, busy: true, progress: null });
    expect(icon(withCheck(installed, newer({ download: "failed" })), { downloading: true })).toMatchObject({ state: "failed", click: "check" });
  });
  it("a clone's check that could not say: the server's lines, and the click checks again", () => {
    const i = icon(withCheck(clone, { state: "cannot-check", checkedAt: 3, reason: "remote", lines: ["Could not reach the git remote.", "Check your connection."] }));
    expect(i).toMatchObject({ state: "failed", click: "check" });
    expect(i?.tip).toContain("Could not reach the git remote.");
    expect(i?.tip).toContain("Tried at T3");
  });
  it("an installed copy's check or download that failed: checks again", () => {
    expect(icon(withCheck(installed, { state: "cannot-check", checkedAt: 3, reason: "unreachable", lines: ["Could not reach the update server. Check your connection."] }))).toMatchObject({ state: "failed", click: "check" });
    for (const download of ["bad", "failed", "disk"] as const) {
      expect(icon(withCheck(installed, newer({ download, lines: [`${download} words`] })))).toMatchObject({ state: "failed", click: "check" });
    }
  });
});

describe("can't update itself", () => {
  it("an installed copy with no installer for it: the release page, dot because something newer is known", () => {
    const i = icon(withCheck(installed, newer({ forThisCopy: false, lines: ["Version 1.3.0 is available, but this copy cannot install it by itself. Download it from the release page."] })));
    expect(i).toMatchObject({ state: "external", click: "page", page: PAGE, dot: "amber", label: "Can't update itself" });
  });
  it("an installed copy with no release key: the release page, no dot", () => {
    expect(icon(withCheck(installed, { state: "cannot-check", checkedAt: 3, reason: "no-key", lines: ["No key."], page: PAGE }))).toMatchObject({ state: "external", click: "page", dot: null });
  });
  it("a development build or a copy that is not a clone: nothing to check, the click opens the version row", () => {
    expect(icon(withCheck(installed, { state: "cannot-check", checkedAt: 3, reason: "development", lines: ["This is a development build, so it does not check for updates."] }))).toMatchObject({ state: "external", click: "settings", dot: null });
    const i = icon(neither);
    expect(i).toMatchObject({ state: "external", click: "settings", dot: null });
    expect(i?.tip).toContain("not downloaded with git clone");
    expect(icon({ ...clone, version: { kind: "unreadable", detail: "no HEAD" } })).toMatchObject({ state: "external", click: "settings" });
  });
});

describe("a check that could not say", () => {
  // Every reason the contract allows, so a new one fails here until it is placed:
  // "person" reasons a new check cannot change go to Settings › General without red,
  // "retry" ones are a failure the next check may clear.
  const KIND: Record<UpdateBlocked, "person" | "retry" | "page"> = {
    "no-git": "person", "not-a-clone": "person", "no-upstream": "person", "local-changes": "person", "local-commits": "person",
    "no-releases": "person", diverged: "person", development: "person", "no-key": "page",
    remote: "retry", error: "retry", unfinished: "retry", unreachable: "retry", "no-list": "retry", "bad-signature": "retry",
  };
  for (const reason of UpdateBlocked.literals) it(`${reason}`, () => {
    const sentence = `The server's own <sentence> for ${reason}.`;
    const i = icon(withCheck(reason === "no-key" ? installed : clone, { state: "cannot-check", checkedAt: 3, reason, lines: [sentence], page: PAGE }));
    expect(i?.tip).toContain(`<b>The server's own &lt;sentence&gt; for ${reason}.</b>`);
    switch (KIND[reason]) {
      case "person":
        expect(i).toMatchObject({ state: "external", label: "Can't update itself", click: "settings", dot: null });
        expect(i?.tip).not.toContain("check again");
        break;
      case "page":
        expect(i).toMatchObject({ state: "external", click: "page", page: PAGE });
        break;
      case "retry":
        expect(i).toMatchObject({ state: "failed", label: "Could not check for updates", click: "check" });
        expect(i?.tip).toContain("Click to check again.");
        break;
    }
  });
  it("no release key and no page: Settings › General", () => {
    expect(icon(withCheck(installed, { state: "cannot-check", checkedAt: 3, reason: "no-key", lines: ["No key."] }))).toMatchObject({ state: "external", click: "settings" });
  });
});

it("is not shown in a browser tab or on a phone", () => {
  expect(updateIcon({ status: withCheck(clone, available), desktop: false })).toBeNull();
  expect(updateIcon({ status: null, desktop: false, installing: true, error: "x" })).toBeNull();
});

it("escapes every server value in its tooltip", () => {
  const i = icon(withCheck(installed, newer({ target: "<b>1.3</b>", forThisCopy: false, lines: ["<img src=x>"] })));
  expect(i?.tip).not.toContain("<img");
  expect(i?.tip).not.toContain("<b>1.3</b>");
});

// Section 8 of docs/design/installed-updates.md, read from the design itself,
// so a sentence that drifts from the reviewed text fails here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as words from "./words.ts";

const design = readFileSync(path.resolve(import.meta.dirname, "../../../../docs/design/installed-updates.md"), "utf8");
const section = design.slice(design.indexOf("## 8. What the person sees"), design.indexOf("## 9."));

/** The Words cell of the row whose State cell is exactly `state`. */
function cell(state: string): string {
  for (const line of section.split("\n")) {
    const parts = line.split(" | ");
    if (parts.length >= 2 && parts[0] === `| ${state}`) return parts.slice(1).join(" | ").replace(/ \|$/, "");
  }
  throw new Error(`no row ${state} in section 8`);
}
/** The quoted sentences of a cell, in order. */
const quoted = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map(m => m[1] ?? "");
const fill = (template: string, values: Record<string, string>): string => template.replace(/<([^<>]+)>/g, (whole, key: string) => values[key] ?? whole);
/** An *[automatic]* sentence: kept without its marks while automatic checks are on, dropped with its space otherwise. */
const automatic = (text: string, on: boolean): string => on ? text.replace(/\*\[([^\]]*)\]\*/g, "$1") : text.replace(/ \*\[[^\]]*\]\*/g, "");
const links = (state: string): boolean => cell(state).endsWith("+ link") || / \+ link\b/.test(cell(state));

const v = { v: "1.4.0", new: "1.5.0", old: "1.4.0", current: "1.4.0", a: "12", b: "122", volume: "/home", n: "130", m: "40", path: "/apps/Gates-Local.AppImage" };

describe("section 8, word for word", () => {
  it("version row and the plain one-line states", () => {
    const [title, detail] = quoted(cell("version row"));
    expect(words.versionRow("1.4.0")).toEqual({ text: fill(title ?? "", v), detail });
    expect(words.noKey()).toEqual({ text: quoted(cell("no key"))[0], link: true });
    expect(words.noneFound()).toEqual({ text: quoted(cell("none found"))[0] });
    expect(words.available("1.5.0")).toEqual({ text: fill(quoted(cell("available"))[0] ?? "", v) });
    expect(words.nothingForThisCopy("1.5.0")).toEqual({ text: fill(quoted(cell("nothing for this copy"))[0] ?? "", v), link: true });
    expect(words.badSignature()).toEqual({ text: quoted(cell("bad signature"))[0], link: true });
    expect(words.downloading("1.5.0", 12, 122)).toEqual({ text: fill(quoted(cell("downloading"))[0] ?? "", v) });
    expect(words.disk("/home", "1.5.0", 130, 40)).toEqual({ text: fill(quoted(cell("disk"))[0] ?? "", v) });
    expect(words.updateStartup()).toEqual({ text: quoted(cell("update startup"))[0] });
    expect(words.watcherDied()).toEqual({ text: quoted(cell("watcher died"))[0] });
    expect(words.secondLaunch()).toEqual({ text: quoted(cell("second launch"))[0] });
    expect(words.otherCopy("/apps/Other.AppImage")).toEqual({ text: fill(quoted(cell("other copy"))[0] ?? "", { path: "/apps/Other.AppImage" }) });
    expect(words.updated("1.5.0")).toEqual({ text: fill(quoted(cell("updated"))[0] ?? "", v) });
    expect(words.rolledBack("1.5.0", "1.4.0")).toEqual({ text: fill(quoted(cell("rolled back"))[0] ?? "", v) });
    expect(words.stuck("1.4.0")).toEqual({ text: fill(quoted(cell("stuck"))[0] ?? "", v) });
    expect(words.earlierFailure()).toEqual({ text: quoted(cell("earlier failure not dismissed"))[0] });
    expect(words.didNotClose()).toEqual({ text: quoted(cell("did not close"))[0] });
    expect(words.couldNotStartUpdate("/d/updates")).toEqual({ text: fill(quoted(cell("could not start the update"))[0] ?? "", { path: "/d/updates" }) });
    expect(words.cleanupPending("/d/updates/1.5.0")).toEqual({ text: fill(quoted(cell("cleanup pending"))[0] ?? "", { path: "/d/updates/1.5.0" }) });
    expect(words.transactionUnreadable("/d/updates/installed-update.json")).toEqual({ text: fill(quoted(cell("transaction unreadable"))[0] ?? "", { path: "/d/updates/installed-update.json" }) });
  });

  it("the sentences in brackets appear only while automatic checks are on", () => {
    for (const on of [true, false]) {
      expect(words.couldNotCheck(on)).toEqual({ text: automatic(quoted(cell("could not check"))[0] ?? "", on) });
      expect(words.notFound404(on)).toEqual({ text: automatic(quoted(cell("404"))[0] ?? "", on) });
      expect(words.badDownload("1.5.0", on)).toEqual({ text: automatic(fill(quoted(cell("bad download"))[0] ?? "", v), on) });
    }
  });

  it("ready, on Linux and on Windows with both go-back forms", () => {
    const [title, detail] = quoted(cell("ready, Linux"));
    expect(words.readyLinux()).toEqual({ text: title, detail });
    const [wTitle, wDetail, wElse] = quoted(cell("ready, Windows"));
    expect(words.readyWindows("1.5.0", { installer: "C:\\kept\\Setup.exe" })).toEqual({ text: wTitle, detail: fill(wDetail ?? "", { ...v, path: "C:\\kept\\Setup.exe" }) });
    // The alternative replaces the sentence's last clause, after "To go back, ".
    const lead = (wDetail ?? "").slice(0, (wDetail ?? "").indexOf("run <path>."));
    const tail = (wElse ?? "").replace(/^…/, "");
    expect(words.readyWindows("1.5.0", { current: "1.4.0", releasePage: "https://example.test/releases/tag/v1.4.0" }))
      .toEqual({ text: wTitle, detail: fill(lead + tail, { ...v, "release page link": "https://example.test/releases/tag/v1.4.0" }) });
  });

  it("the three reasons a copy cannot replace its own file", () => {
    const text = quoted(cell("read-only / no-permission / not-appimage"))[0] ?? "";
    const [head, rest] = text.split("because its folder is read-only / ");
    const reasons = ["because its folder is read-only", ...(rest ?? "").split(". Download")[0]!.split(" / ")];
    const tail = `. Download${text.split(". Download")[1]}`;
    const cases = [["read-only", reasons[0]], ["no-permission", reasons[1]], ["not-appimage", reasons[2]]] as const;
    for (const [reason, clause] of cases) {
      expect(words.cannotReplace(reason, "1.5.0")).toEqual({ text: fill(`${head}${clause}${tail}`, v), link: true });
    }
    expect(links("read-only / no-permission / not-appimage")).toBe(true);
    expect(words.pinnedDataFolder("1.5.0")).toEqual({ text: fill(quoted(cell("pinned data folder"))[0] ?? "", v), link: true });
  });

  it("replace paused and go-back paused, for a full disk and for a path it cannot change (no permission, or a read-only volume)", () => {
    for (const [state, make] of [["replace paused", (c: words.PauseCause) => words.replacePaused(c)], ["go-back paused", (c: words.PauseCause) => words.goBackPaused("1.4.0", c)]] as const) {
      const text = quoted(cell(state))[0] ?? "";
      const open = text.indexOf("<the disk is full / ");
      const close = text.indexOf(">>", open) + 2;
      const before = text.slice(0, open), after = text.slice(close);
      expect(make({ kind: "disk" })).toEqual({ text: fill(`${before}the disk is full${after}`, v) });
      expect(make({ kind: "permission", path: "/apps" })).toEqual({ text: fill(`${before}it cannot change /apps${after}`, v) });
    }
  });

  it("the three failure pages and the Windows note name the paths as they are", () => {
    const paths = { "store copy path": "/d/store-copies/threads.v4.sqlite", ".previous path": "/apps/.Gates-Local.AppImage.previous-x", "data folder": "/d", "aside path": "/d/store-copies/aside-x", "incoming path": "/apps/.Gates-Local.AppImage.incoming-x", "kept installer path": "C:\\kept\\Setup.exe" };
    const all = { ...v, ...paths };
    expect(words.rollbackFailedStoreCopy({ newVersion: "1.5.0", oldVersion: "1.4.0", storeCopy: paths["store copy path"], previous: paths[".previous path"], dataFolder: "/d" }))
      .toEqual({ text: fill(quoted(cell("rollback failed: the copy of the chats is missing or wrong (B2a; failure page)"))[0] ?? "", all), link: true });
    expect(words.rollbackFailedOldDidNotStart({ newVersion: "1.5.0", oldVersion: "1.4.0", path: v.path, dataFolder: "/d", aside: paths["aside path"] }))
      .toEqual({ text: fill(quoted(cell("rollback failed: the old version did not start either (B4; failure page)"))[0] ?? "", all), link: true });
    expect(words.windowsDidNotFinish("1.5.0", paths["kept installer path"]))
      .toEqual({ text: fill(quoted(cell("Windows did not finish"))[0] ?? "", all), link: true });
  });

  it("B3's page says whether the saved old version is missing or is something else", () => {
    const state = "rollback failed: the saved old version is not there (B3; failure page)";
    const text = quoted(cell(state))[0] ?? "";
    const open = text.indexOf("<is not version <old> / ");
    const close = text.indexOf(">", text.indexOf(" / ", open)) + 1;
    const before = text.slice(0, open), after = text.slice(close);
    const values = { ...v, ".previous path": "/apps/.Gates-Local.AppImage.previous-x", "data folder": "/d" };
    const o = { newVersion: "1.5.0", oldVersion: "1.4.0", previous: values[".previous path"], path: v.path, dataFolder: "/d" };
    expect(links(state)).toBe(true);
    expect(words.rollbackFailedSavedOld({ ...o, saved: "not-old" })).toEqual({ text: fill(`${before}is not version <old>${after}`, values), link: true });
    expect(words.rollbackFailedSavedOld({ ...o, saved: "missing" })).toEqual({ text: fill(`${before}is missing${after}`, values), link: true });
  });

  it("the unknown-file page names only the saved versions that are there", () => {
    const old = { version: "1.4.0", path: "/apps/.Gates-Local.AppImage.previous-x" };
    const next = { version: "1.5.0", path: "/d/updates/1.5.0/Gates-Local-1.5.0-x86_64.AppImage" };
    const page = (state: string, values: Record<string, string>) => {
      expect(links(state)).toBe(true);
      return { text: fill(quoted(cell(state))[0] ?? "", { ...v, ...values }), link: true };
    };
    expect(words.unknownFile(v.path, old, next)).toEqual(page("unknown file, both saved (watcher's failure page)", { ".previous path": old.path, "saved new path": next.path }));
    expect(words.unknownFile(v.path, old, null)).toEqual(page("unknown file, one saved (watcher's failure page)", { v: old.version, "saved path": old.path }));
    expect(words.unknownFile(v.path, null, next)).toEqual(page("unknown file, one saved (watcher's failure page)", { v: next.version, "saved path": next.path }));
    expect(words.unknownFile(v.path, null, null)).toEqual(page("unknown file, none saved (watcher's failure page)", {}));
  });
});

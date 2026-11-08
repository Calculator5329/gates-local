import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DESKTOP_ID, renderDesktopEntry } from "../src/desktop-entry.ts";
import { installLinux, linuxDataHome } from "../src/linux-install.ts";

const desktopDir = path.resolve(import.meta.dirname, "..");
const assets = path.join(desktopDir, "assets");
const work = mkdtempSync(path.join(tmpdir(), "gates-linux-install-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
const fresh = (): string => {
  const dir = path.join(work, `case-${++n}`);
  mkdirSync(dir);
  return dir;
};

/** Every file under dir, as path (relative to dir) -> contents. */
function files(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const file = path.join(dir, name);
    if (statSync(file).isFile()) out.set(name, readFileSync(file));
  }
  return out;
}

const ENTRY = path.join("applications", `${DESKTOP_ID}.desktop`);
const SVG = path.join("icons", "hicolor", "scalable", "apps", `${DESKTOP_ID}.svg`);
const PNG = path.join("icons", "hicolor", "512x512", "apps", `${DESKTOP_ID}.png`);
const FIXED = new Date("2026-11-07T12:00:00.000Z");
const quiet = { log: () => {} };

describe("installLinux", () => {
  it("writes the entry and both icons, mode 0644, and makes no backup on a fresh install", () => {
    const dataHome = fresh();
    installLinux({ dataHome, exec: ["/opt/gates/run"], assets, now: FIXED, ...quiet });
    const got = files(dataHome);
    expect([...got.keys()].toSorted()).toEqual([ENTRY, PNG, SVG].toSorted());
    expect(got.get(ENTRY)?.toString("utf8")).toBe(renderDesktopEntry(["/opt/gates/run"]));
    expect(got.get(SVG)?.equals(readFileSync(path.join(assets, "icon.svg")))).toBe(true);
    expect(got.get(PNG)?.equals(readFileSync(path.join(assets, "icon.png")))).toBe(true);
    for (const rel of [ENTRY, SVG, PNG]) expect(statSync(path.join(dataHome, rel)).mode & 0o777).toBe(0o644);
  });

  it("an identical re-run changes nothing and keeps no backup", () => {
    const dataHome = fresh();
    installLinux({ dataHome, exec: ["/opt/gates/run"], assets, now: FIXED, ...quiet });
    const before = files(dataHome);
    installLinux({ dataHome, exec: ["/opt/gates/run"], assets, now: FIXED, ...quiet });
    expect(files(dataHome)).toEqual(before);
  });

  it("keeps every earlier launcher, even when installs share a timestamp", () => {
    const dataHome = fresh();
    const versions = ["/opt/v1/run", "/opt/v2/run", "/opt/v3/run"].map((p) => renderDesktopEntry([p]));
    for (const p of ["/opt/v1/run", "/opt/v2/run", "/opt/v3/run"]) installLinux({ dataHome, exec: [p], assets, now: FIXED, ...quiet });
    const all = files(dataHome);
    expect(all.get(ENTRY)?.toString("utf8")).toBe(versions[2]);
    const kept = [...all.values()].map((b) => b.toString("utf8")).filter((text) => text.startsWith("[Desktop Entry]"));
    expect(kept.toSorted()).toEqual([...versions].toSorted());
  });

  it("backs a changed icon up too, and no backup lands where the menu or icon theme would read it", () => {
    const dataHome = fresh();
    const old = path.join(dataHome, SVG);
    mkdirSync(path.dirname(old), { recursive: true });
    copyFileSync(path.join(assets, "icon.png"), old);
    installLinux({ dataHome, exec: ["/opt/v1/run"], assets, now: FIXED, ...quiet });
    installLinux({ dataHome, exec: ["/opt/v2/run"], assets, now: FIXED, ...quiet });
    const all = files(dataHome);
    expect([...all.entries()].filter(([rel, b]) => rel !== PNG && b.equals(readFileSync(path.join(assets, "icon.png")))).length).toBe(1);
    const scanned = [...all.keys()].filter((rel) => rel.startsWith(`applications${path.sep}`) || rel.startsWith(`icons${path.sep}`));
    expect(scanned.toSorted()).toEqual([ENTRY, PNG, SVG].toSorted());
  });

  it("a missing icon source writes nothing at all", () => {
    const dataHome = fresh();
    const partial = fresh();
    copyFileSync(path.join(assets, "icon.svg"), path.join(partial, "icon.svg"));
    expect(() => installLinux({ dataHome, exec: ["/opt/gates/run"], assets: partial, now: FIXED, ...quiet })).toThrow(/icon\.png/);
    expect([...files(dataHome).keys()]).toEqual([]);
  });
});

describe("linuxDataHome", () => {
  it("takes an absolute XDG_DATA_HOME and ignores a relative or empty one, as the XDG spec says", () => {
    expect(linuxDataHome({ XDG_DATA_HOME: "/data/u" }, "/home/u")).toBe("/data/u");
    expect(linuxDataHome({ XDG_DATA_HOME: "relative-data" }, "/home/u")).toBe("/home/u/.local/share");
    expect(linuxDataHome({ XDG_DATA_HOME: "" }, "/home/u")).toBe("/home/u/.local/share");
    expect(linuxDataHome({}, "/home/u")).toBe("/home/u/.local/share");
  });
});

const run = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) =>
  spawnSync(process.execPath, [path.join(desktopDir, "scripts", "install-linux.ts"), ...args], { cwd, env, encoding: "utf8" });

describe("scripts/install-linux.ts", () => {
  it("installs under a temp HOME when XDG_DATA_HOME is relative, never under the working folder", () => {
    const home = fresh();
    const cwd = fresh();
    const env = { PATH: process.env["PATH"], HOME: home, XDG_DATA_HOME: "relative-data" };
    const result = run(cwd, env, ["--exec", "/opt/gates/run", "--exec-arg", "100%done"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect([...files(cwd).keys()]).toEqual([]);
    const entry = readFileSync(path.join(home, ".local", "share", ENTRY), "utf8");
    expect(entry).toBe(renderDesktopEntry(["/opt/gates/run", "100%done"]));
  });

  it("installs under an absolute XDG_DATA_HOME, and refuses a missing --exec", () => {
    const home = fresh();
    const dataHome = fresh();
    const env = { PATH: process.env["PATH"], HOME: home, XDG_DATA_HOME: dataHome };
    expect(run(home, env, ["--exec", "/opt/gates/run"]).status).toBe(0);
    expect([...files(dataHome).keys()].toSorted()).toEqual([ENTRY, PNG, SVG].toSorted());
    expect([...files(home).keys()]).toEqual([]);
    expect(run(home, env, []).status).toBe(2);
  });
});

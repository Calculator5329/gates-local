import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DESKTOP_ID, renderDesktopEntry } from "../src/desktop-entry.ts";
import { BACKUP_DIR, installLinux, linuxDataHome } from "../src/linux-install.ts";

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

/** Every regular file under dir (symlinks not followed), as path (relative to dir) -> contents. */
function files(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const file = path.join(dir, name);
    if (lstatSync(file).isFile()) out.set(name, readFileSync(file));
  }
  return out;
}

/**
 * An installer process whose launcher write waits at a barrier: it touches
 * <work>/ready-<name> and holds until <work>/go-<name> exists. With
 * "intruder" it instead writes a competing launcher at the target right
 * before each of its own launcher writes, as a second install would.
 */
const WORKER = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [work, dataHome, source, assets, name, mode] = process.argv.slice(2);
const launcher = dataHome + "/applications/gates-local.desktop";
const write = fs.writeFileSync;
const nap = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
let intrusions = 0;
fs.writeFileSync = (file, ...args) => {
  if (String(file) === launcher && mode === "pause" && !paused) {
    paused = true;
    write(work + "/ready-" + name, "");
    const end = Date.now() + 20000;
    while (!fs.existsSync(work + "/go-" + name)) {
      if (Date.now() > end) throw new Error("barrier timed out");
      Atomics.wait(nap, 0, 0, 10);
    }
  }
  if (String(file) === launcher && mode === "intruder") write(launcher, "intruder " + ++intrusions + "\\n");
  return write(file, ...args);
};
syncBuiltinESMExports();
const { installLinux } = await import(source);
installLinux({ dataHome, exec: ["/opt/" + name + "/run"], assets, now: new Date("2026-11-07T12:00:00Z"), log: () => {} });
`;

/** Workers that have not exited yet; afterEach stops them so a failed assertion leaves no process behind. */
const live = new Set<{ child: ChildProcess; done: Promise<unknown> }>();
afterEach(async () => {
  const left = [...live];
  for (const w of left) w.child.kill("SIGKILL");
  await Promise.all(left.map((w) => w.done));
});

function worker(dir: string, dataHome: string, name: string, mode: "pause" | "intruder") {
  const script = path.join(dir, "worker.mjs");
  writeFileSync(script, WORKER);
  const child = spawn(process.execPath, [script, dir, dataHome, path.join(desktopDir, "src", "linux-install.ts"), assets, name, mode], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
  const handle = { child, done };
  live.add(handle);
  void done.then(() => live.delete(handle));
  return handle;
}

async function waitFor(file: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it("two installs that both saw no launcher keep both: one at the target, the other backed up", async () => {
    const dir = fresh();
    const dataHome = path.join(dir, "data");
    const a = worker(dir, dataHome, "v1", "pause");
    const b = worker(dir, dataHome, "v2", "pause");
    // Both are past the occupied check and held at the launcher write.
    await Promise.all([waitFor(path.join(dir, "ready-v1")), waitFor(path.join(dir, "ready-v2"))]);
    writeFileSync(path.join(dir, "go-v1"), "");
    expect(await a.done).toEqual({ code: 0, stderr: "" });
    writeFileSync(path.join(dir, "go-v2"), "");
    expect(await b.done).toEqual({ code: 0, stderr: "" });
    const all = files(dataHome);
    expect(all.get(ENTRY)?.toString("utf8")).toBe(renderDesktopEntry(["/opt/v2/run"]));
    const backedUp = [...all.entries()].filter(([rel]) => rel.startsWith(BACKUP_DIR + path.sep)).map(([, bytes]) => bytes.toString("utf8"));
    expect(backedUp).toEqual([renderDesktopEntry(["/opt/v1/run"])]);
  }, 30_000);

  it("stops with a clear error, overwriting nothing, when the launcher is taken again after a backup", async () => {
    const dir = fresh();
    const dataHome = path.join(dir, "data");
    const run = await worker(dir, dataHome, "v1", "intruder").done;
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/another install/);
    const texts = [...files(dataHome).values()].map((b) => b.toString("utf8"));
    expect(texts).toContain("intruder 1\n");
    expect(texts).toContain("intruder 2\n");
    expect(texts).not.toContain(renderDesktopEntry(["/opt/v1/run"]));
  }, 30_000);

  it("a dangling symlink at the target is backed up as the link itself and never followed", () => {
    const dataHome = fresh();
    const referent = path.join(dataHome, "elsewhere", "missing.desktop");
    const target = path.join(dataHome, ENTRY);
    mkdirSync(path.dirname(target), { recursive: true });
    mkdirSync(path.dirname(referent));
    symlinkSync(referent, target);
    installLinux({ dataHome, exec: ["/opt/gates/run"], assets, now: FIXED, ...quiet });
    expect(existsSync(referent)).toBe(false);
    expect(lstatSync(target).isFile()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(renderDesktopEntry(["/opt/gates/run"]));
    const backupRoot = path.join(dataHome, BACKUP_DIR);
    const links = existsSync(backupRoot)
      ? readdirSync(backupRoot, { recursive: true, encoding: "utf8" }).filter((rel) => lstatSync(path.join(backupRoot, rel)).isSymbolicLink())
      : [];
    expect(links).toHaveLength(1);
    expect(readlinkSync(path.join(backupRoot, links[0] ?? ""))).toBe(referent);
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

import { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaunch, type RelaunchDeps } from "../src/update-relaunch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform: NodeJS.Platform = "linux", gone = false) {
  const root = mkdtempSync(path.join(tmpdir(), "update-relaunch-")); roots.push(root);
  const cwd = path.join(root, "apps", "desktop");
  const pkg = path.join(cwd, "node_modules", "electron");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  writeFileSync(path.join(cwd, "package.json"), "{}");
  writeFileSync(path.join(pkg, "index.js"), 'module.exports = require("node:path").join(__dirname, "dist", require("node:fs").readFileSync(require("node:path").join(__dirname, "path.txt"), "utf8"));');
  const install = (name: string) => { writeFileSync(path.join(pkg, "path.txt"), name); const file = path.join(pkg, "dist", name); writeFileSync(file, "fixture"); return file; };
  const executable = install("new-electron");
  const start = vi.fn<NonNullable<RelaunchDeps["spawn"]>>(() => Object.assign(new ChildProcess(), { pid: 4242 }));
  const stopTree = vi.fn(async () => true);
  const currentStart = vi.fn<() => string | null>(() => gone ? null : "owned-start");
  const deps = { root, env: {}, platform, spawn: start, record: () => ({ pid: 4242, start: "owned-start", uptime: 1 }), gone: () => gone, startOf: currentStart, stopTree };
  return { install, executable, pkg, start, currentStart, stopTree, deps, spec: { cwd, args: [cwd] } };
}

it("AW-01 rollback launches the restored Electron executable in the same updater process", async () => {
  const f = fixture(); const relaunch = createRelaunch(f.deps);
  await relaunch(f.spec);
  const previous = f.install("old-electron");
  await relaunch(f.spec);
  expect(f.start.mock.calls.map(call => call[0])).toEqual([f.executable, previous]);
});

it("AW-01 rollback follows a replaced package link rather than Node's cached resolution", async () => {
  const f = fixture();
  const newer = path.join(f.deps.root, "new-package");
  renameSync(f.pkg, newer);
  symlinkSync(newer, f.pkg, process.platform === "win32" ? "junction" : "dir");
  const relaunch = createRelaunch(f.deps);
  await relaunch(f.spec);
  const previous = path.join(f.deps.root, "old-package");
  mkdirSync(path.join(previous, "dist"), { recursive: true });
  writeFileSync(path.join(previous, "path.txt"), "old-electron");
  writeFileSync(path.join(previous, "dist", "old-electron"), "fixture");
  unlinkSync(f.pkg); symlinkSync(previous, f.pkg, process.platform === "win32" ? "junction" : "dir");
  await relaunch(f.spec);
  expect(f.start.mock.calls.map(call => call[0])).toEqual([path.join(newer, "dist", "new-electron"), path.join(previous, "dist", "old-electron")]);
});

it("AW-02 a vanished Windows root cannot certify its owned descendants stopped", async () => {
  const f = fixture("win32", true);
  const app = await createRelaunch(f.deps)(f.spec);
  expect(await app.stop()).toBe(false);
  expect(f.stopTree).not.toHaveBeenCalled();
});

it("AW-02 a matching live Windows root is stopped through its tree", async () => {
  const f = fixture("win32");
  const app = await createRelaunch(f.deps)(f.spec);
  expect(await app.stop()).toBe(true);
  expect(f.stopTree).toHaveBeenCalledWith(4242, { requireWindowsTreeKill: true });
});

it.each([null, "reused-start"])("AW-02 Windows cannot kill when its current identity is %s", async current => {
  const f = fixture("win32"); f.currentStart.mockReturnValue(current);
  const app = await createRelaunch(f.deps)(f.spec);
  expect(await app.stop()).toBe(false);
  expect(f.stopTree).not.toHaveBeenCalled();
});

it("AW-02 an unknown Windows root identity cannot authorize a tree kill or rollback", async () => {
  const f = fixture("win32");
  const app = await createRelaunch({ ...f.deps, record: () => ({ pid: 4242, start: null, uptime: 1 }) })(f.spec);
  expect(await app.stop()).toBe(false);
  expect(f.stopTree).not.toHaveBeenCalled();
});

it("AW-02 an unconfirmed Windows termination keeps rollback blocked", async () => {
  const f = fixture("win32"); f.stopTree.mockResolvedValue(false);
  const app = await createRelaunch(f.deps)(f.spec);
  expect(await app.stop()).toBe(false);
});

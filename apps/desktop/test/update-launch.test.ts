// "Update and restart" (src/update-launch.ts, src/running.ts): the command
// main starts before it quits, and the pid file the updater reads to tell
// the app is open.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNING_FILE, clearRunning, readRunning, writeRunning } from "../src/running.ts";
import { cannotUpdate, nodeCommand, updaterLaunch } from "../src/update-launch.ts";

const REPO = path.resolve("/srv/gates-local");
const DATA = path.resolve("/srv/data");
const base = { repoRoot: REPO, pid: 4242, dataDir: DATA, cwd: path.join(REPO, "apps", "desktop"), env: {}, exists: () => false };

describe("the updater launch", () => {
  it("passes the pid, the data folder and the way the app was started", () => {
    const plan = updaterLaunch({ ...base, argv: ["/x/electron", "."] });
    expect(plan).toEqual({
      command: "node",
      args: [path.join(REPO, "scripts", "update.ts"), "--wait-pid", "4242", "--restart", "--data-dir", DATA, "--relaunch-cwd", base.cwd, "--relaunch-arg", "."],
      cwd: REPO,
    });
  });

  it("drops --background, so the app comes back with a window", () => {
    const plan = updaterLaunch({ ...base, argv: ["/x/electron", path.join(REPO, "apps", "desktop"), "--background"] });
    expect(plan.args.slice(-2)).toEqual(["--relaunch-arg", path.join(REPO, "apps", "desktop")]);
    expect(plan.args).not.toContain("--background");
  });

  it("uses the node pnpm ran with when it exists, else node on PATH", () => {
    const node = path.resolve("/opt/node/bin/node");
    expect(nodeCommand({ npm_node_execpath: node }, (f) => f === node)).toBe(node);
    expect(nodeCommand({ npm_node_execpath: node }, () => false)).toBe("node");
    expect(nodeCommand({ npm_node_execpath: "node" }, () => true)).toBe("node");
    expect(nodeCommand({}, () => true)).toBe("node");
  });

  it("refuses in a packaged app or a folder that is not a clone", () => {
    expect(cannotUpdate({ packaged: true, repoRoot: REPO, exists: () => true })).toMatch(/not run from a git clone/);
    expect(cannotUpdate({ packaged: false, repoRoot: REPO, exists: (f) => !f.endsWith(".git") })).toMatch(/not a git clone/);
    expect(cannotUpdate({ packaged: false, repoRoot: REPO, exists: () => true })).toBeNull();
  });
});

describe("the running file", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("names the live app, reads as closed once its pid is gone, and is removed only by its own pid", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gl-running-"));
    const data = path.join(dir, "data");
    writeRunning(data, 100, 5);
    expect(JSON.parse(readFileSync(path.join(data, RUNNING_FILE), "utf8"))).toEqual({ pid: 100, startedAt: 5 });
    expect(readRunning(data, (p) => p === 100)).toEqual({ pid: 100, file: path.join(data, RUNNING_FILE) });
    expect(readRunning(data, () => false)).toBeNull();
    clearRunning(data, 200);
    expect(readRunning(data, () => true)?.pid).toBe(100);
    clearRunning(data, 100);
    expect(readRunning(data, () => true)).toBeNull();
  });

  it("reads a broken file as not running", () => {
    dir = mkdtempSync(path.join(tmpdir(), "gl-running-"));
    writeFileSync(path.join(dir, RUNNING_FILE), "{not json");
    expect(readRunning(dir, () => true)).toBeNull();
    writeFileSync(path.join(dir, RUNNING_FILE), JSON.stringify({ pid: -1 }));
    expect(readRunning(dir, () => true)).toBeNull();
  });
});

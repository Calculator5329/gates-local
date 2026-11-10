// "Update and restart" (src/update-launch.ts, src/running.ts): the command
// main starts before it quits, and the pid file the updater reads to tell
// the app is open.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchMode } from "../src/launch.ts";
import { createUpdateAdmission } from "../../server/src/update/admission.ts";
import { RUNNING_FILE, clearRunning, readRunning, writeRunning } from "../src/running.ts";
import { APPROVAL_DEADLINE_ENV, approvedHandoffEnv, cannotUpdate, launchApprovedUpdate, nodeCommand, onceUntilFailed, relaunchEnv, updaterLaunch, validUpdateRequest, type UpdateControl } from "../src/update-launch.ts";

const REPO = path.resolve("/srv/gates-local");
const DATA = path.resolve("/srv/data");
const base = { repoRoot: REPO, pid: 4242, dataDir: DATA, cwd: path.join(REPO, "apps", "desktop"), env: {}, exists: () => false };

describe("the updater launch", () => {
  it("AV-01 bounds a detached handoff and removes its deadline from the reopened app", () => {
    const env = approvedHandoffEnv({ PATH: "/bin" }, 100);
    expect(env[APPROVAL_DEADLINE_ENV]).toBe("105");
    expect(relaunchEnv(env)).toEqual({ PATH: "/bin" });
  });
  it("AU-01 main cannot spawn without a live server reservation and releases failed handoffs", async () => {
    const request = { reservation: "lease", targetCommit: "a".repeat(40) };
    const start = vi.fn(async () => ({ ok: true as const }));
    const cancel = vi.fn<UpdateControl["cancel"]>(async () => undefined);
    const control = { commit: vi.fn<UpdateControl["commit"]>(async () => ({ accepted: false })), cancel };
    expect((await launchApprovedUpdate(request, control, start)).ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("lease");
    control.commit.mockImplementation(async (input) => ({ accepted: true, release: input.release }));
    const failed = await launchApprovedUpdate(request, control, async () => ({ ok: false, message: "spawn failed" }));
    expect(failed).toEqual({ ok: false, message: "spawn failed" });
    expect(cancel).toHaveBeenCalledTimes(4);
    expect(cancel.mock.calls[2]?.[0]).toBe(control.commit.mock.calls[1]?.[0].release);
    expect(await launchApprovedUpdate(request, control, start)).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith(request.targetCommit);
    expect(cancel).toHaveBeenCalledTimes(4);
  });
  it("AU-01 a lost commit acknowledgement cannot strand the server pause", async () => {
    const admission = createUpdateAdmission();
    const targetCommit = "a".repeat(40);
    const reservation = admission.reserve(targetCommit);
    const start = vi.fn(async () => ({ ok: true as const }));
    const control: UpdateControl = {
      commit: async (input) => { admission.commit(input.reservation, input.targetCommit, input.release); throw new Error("reply lost"); },
      cancel: async (token) => admission.cancel(token),
    };
    expect((await launchApprovedUpdate({ reservation, targetCommit }, control, start)).ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(admission.installing()).toBe(false);
    expect(() => admission.admit()).not.toThrow();
  });
  it("AU-02 the bridge requires a full target and a reservation, not a short label", () => {
    expect(validUpdateRequest({ reservation: "lease", targetCommit: "a".repeat(40) })).toBe(true);
    expect(validUpdateRequest({ reservation: "lease", targetCommit: "aaaaaaa" })).toBe(false);
    expect(validUpdateRequest({ targetCommit: "a".repeat(40) })).toBe(false);
  });
  it("AU-02 carries the full approved commit into the detached updater", () => {
    const approvedCommit = "a".repeat(40);
    const input = { ...base, argv: ["/x/electron", "."], approvedCommit };
    const plan = updaterLaunch(input);
    expect(plan.args).toContain("--target-commit");
    expect(plan.args[plan.args.indexOf("--target-commit") + 1]).toBe(approvedCommit);
  });
  it("passes the pid, the data folder and the way the app was started", () => {
    const plan = updaterLaunch({ ...base, argv: ["/x/electron", "."] });
    expect(plan).toEqual({
      command: "node",
      args: [path.join(REPO, "scripts", "update.ts"), "--wait-pid", "4242", "--restart", "--data-dir", DATA, "--relaunch-cwd", base.cwd, "--relaunch-arg=."],
      cwd: REPO,
    });
  });

  it("keeps each Electron argument in one token, so one starting with -- is a value", () => {
    const plan = updaterLaunch({ ...base, argv: ["/x/electron", ".", "--disable-gpu"] });
    expect(plan.args.slice(-2)).toEqual(["--relaunch-arg=.", "--relaunch-arg=--disable-gpu"]);
  });

  it("drops --background, so the app comes back with a window", () => {
    const plan = updaterLaunch({ ...base, argv: ["/x/electron", path.join(REPO, "apps", "desktop"), "--background"] });
    expect(plan.args.at(-1)).toBe(`--relaunch-arg=${path.join(REPO, "apps", "desktop")}`);
    expect(plan.args.join(" ")).not.toContain("--background");
  });

  it("drops the background variable from the relaunch too, and the Electron-as-node one", () => {
    const env = relaunchEnv({ GATES_LOCAL_BACKGROUND: "1", ELECTRON_RUN_AS_NODE: "1", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
    expect(launchMode(["/x/electron", "."], env)).toEqual({ background: false });
  });

  it("leaves the environment it was given alone", () => {
    const given = { GATES_LOCAL_BACKGROUND: "1" };
    relaunchEnv(given);
    expect(given).toEqual({ GATES_LOCAL_BACKGROUND: "1" });
  });
});

/** A start that stays open until the test ends it, like a spawn that has not reported yet. */
function pendingStart() {
  let starts = 0;
  const ends: Array<(r: { ok: boolean }) => void> = [];
  const start = () => {
    starts++;
    return new Promise<{ ok: boolean }>((resolve) => ends.push(resolve));
  };
  return { start, ends, count: () => starts };
}

describe("one Update and restart per click", () => {
  it("starts once when two calls arrive before the first has spawned, and both get its answer", async () => {
    const p = pendingStart();
    const click = onceUntilFailed(p.start);
    const calls = [click(), click()];
    expect(p.count()).toBe(1);
    p.ends[0]!({ ok: true });
    expect(await Promise.all(calls)).toEqual([{ ok: true }, { ok: true }]);
  });

  it("stays started after it worked, while the app quits", async () => {
    const p = pendingStart();
    const click = onceUntilFailed(p.start);
    const first = click();
    p.ends[0]!({ ok: true });
    await first;
    void click();
    expect(p.count()).toBe(1);
  });

  it("can be tried again after a start that failed or threw", async () => {
    const p = pendingStart();
    const click = onceUntilFailed(p.start);
    const first = click();
    p.ends[0]!({ ok: false });
    expect(await first).toEqual({ ok: false });
    void click();
    expect(p.count()).toBe(2);
    const throws = onceUntilFailed<{ ok: boolean }>(() => Promise.reject(new Error("no")));
    await expect(throws()).rejects.toThrow("no");
    await expect(throws()).rejects.toThrow("no");
  });

  it("uses the node pnpm ran with when it exists, else node on PATH", () => {
    const node = path.resolve("/opt/node/bin/node");
    expect(nodeCommand({ npm_node_execpath: node }, (f) => f === node)).toBe(node);
    expect(nodeCommand({ npm_node_execpath: node }, () => false)).toBe("node");
    expect(nodeCommand({ npm_node_execpath: "node" }, () => true)).toBe("node");
    expect(nodeCommand({}, () => true)).toBe("node");
  });

  it("refuses in a packaged app or a folder that is not a clone", () => {
    expect(cannotUpdate({ packaged: true, repoRoot: REPO, exists: () => true })).toBe("This installed copy of Gates Local cannot update itself yet. Download the new version from the release page.");
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

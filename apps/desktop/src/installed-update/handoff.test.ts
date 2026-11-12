// The handoff's real effects (section 2): what a launch it starts receives,
// when a recorded process counts as ended, and the test builds' stop points.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processRecord } from "../../../server/src/update/identity.ts";
import { STARTUP_TOKEN_ENV } from "../../../server/src/update/startup.ts";
import { forwardedArgs, launchEnv, loggedStopAt, processGone, spawnedOutput, spawnProgram, sweepOwnTmp, testStopAt } from "./handoff.ts";
import { WATCH_FLAG } from "./launch-kinds.ts";

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function folder(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iu-handoff-"));
  roots.push(root);
  return root;
}
const until = async (check: () => boolean, ms = 5_000): Promise<boolean> => {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
};

describe("handoff", () => {
  it("HO-01 a launch it starts keeps only the sandbox and GPU switches, plus the debug port in a test build", () => {
    const argv = ["/app/gates-local", "--no-sandbox", `${WATCH_FLAG}=/d/updates/installed-update.json`, "--inspect=9229", "--disable-gpu", "--no-sandbox"];
    expect(forwardedArgs(argv, {}, false)).toEqual(["--no-sandbox", "--disable-gpu"]);
    const env = { GATES_LOCAL_UPDATE_TEST_DEBUG_PORT: "45123" };
    expect(forwardedArgs(argv, env, false)).toEqual(["--no-sandbox", "--disable-gpu"]);
    expect(forwardedArgs(argv, env, true)).toEqual(["--no-sandbox", "--disable-gpu", "--remote-debugging-port=45123"]);
    expect(forwardedArgs(argv, { GATES_LOCAL_UPDATE_TEST_DEBUG_PORT: "9229; rm" }, true)).toEqual(["--no-sandbox", "--disable-gpu"]);
  });

  it("HO-02 its environment drops the AppImage runtime's, the old token and the no-window and node switches, and carries the new token", () => {
    const env = {
      PATH: "/bin", APPIMAGE: "/a/G.AppImage", APPDIR: "/tmp/.mount_x", ARGV0: "G", OWD: "/home",
      ELECTRON_RUN_AS_NODE: "1", GATES_LOCAL_BACKGROUND: "1", [STARTUP_TOKEN_ENV]: "old", APPIMAGE_EXTRACT_AND_RUN: "1",
    };
    expect(launchEnv(env, "T1")).toEqual({ PATH: "/bin", APPIMAGE_EXTRACT_AND_RUN: "1", [STARTUP_TOKEN_ENV]: "T1" });
    expect(launchEnv(env, null)).toEqual({ PATH: "/bin", APPIMAGE_EXTRACT_AND_RUN: "1" });
  });

  it("HO-06 in extract-and-run mode each launch extracts into a folder of its own under the person's TMPDIR; mounted, nothing changes", () => {
    const made: string[] = [];
    const own = (base: string) => {
      const dir = `${base}/gl-update-${made.length}`;
      made.push(dir);
      return dir;
    };
    // The old main, run from the runtime's extraction of the program file.
    const main = { PATH: "/bin", TMPDIR: "/t", APPDIR: "/t/appimage_extracted_0123abcd", APPIMAGE: "/a/G.AppImage" };
    expect(launchEnv(main, null, own)).toEqual({ PATH: "/bin", TMPDIR: "/t/gl-update-0", GATES_LOCAL_UPDATE_TMPDIR: "/t", APPIMAGE_EXTRACT_AND_RUN: "1" });
    // T1, started by that watcher: a new folder under the person's TMPDIR, not inside the watcher's.
    const watcher = { PATH: "/bin", TMPDIR: "/t/gl-update-0", GATES_LOCAL_UPDATE_TMPDIR: "/t", APPDIR: "/t/gl-update-0/appimage_extracted_0123abcd", APPIMAGE_EXTRACT_AND_RUN: "1" };
    expect(launchEnv(watcher, "T1", own)).toEqual({ PATH: "/bin", TMPDIR: "/t/gl-update-1", GATES_LOCAL_UPDATE_TMPDIR: "/t", APPIMAGE_EXTRACT_AND_RUN: "1", [STARTUP_TOKEN_ENV]: "T1" });
    // Mounted: the runtime's own mount folder, nothing shared.
    expect(launchEnv({ PATH: "/bin", TMPDIR: "/t", APPDIR: "/t/.mount_x" }, null, own)).toEqual({ PATH: "/bin", TMPDIR: "/t" });
    expect(made).toEqual(["/t/gl-update-0", "/t/gl-update-1"]);
  });

  it("HO-07 the sweep removes the launches' emptied TMPDIR folders only", () => {
    const base = folder();
    // Short: Chromium's socket sits under this folder, and a Unix socket path holds 108 bytes.
    for (const name of ["gl-update-a", "gl-update-b", "other"]) mkdirSync(path.join(base, name));
    writeFileSync(path.join(base, "gl-update-b", "in-use"), "");
    sweepOwnTmp({ GATES_LOCAL_UPDATE_TMPDIR: base });
    expect(readdirSync(base).toSorted()).toEqual(["gl-update-b", "other"]);
    sweepOwnTmp({});
    expect(readdirSync(path.join(base, "gl-update-b"))).toEqual(["in-use"]);
  });

  it("HO-03 a recorded process is gone only when it and its group have ended, whether or not it leads the group", async () => {
    // Not a group leader: the group check alone would call it gone at once.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    pids.push(child.pid!);
    const record = processRecord(child.pid!);
    expect(processGone(record)).toBe(false);
    child.kill("SIGKILL");
    expect(await until(() => processGone(record))).toBe(true);
    // A leader whose helper outlives it: not gone until the helper ends.
    const leader = spawn("sh", ["-c", "sleep 30 & echo $!; exit 0"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    pids.push(leader.pid!);
    const leaderRecord = processRecord(leader.pid!);
    const helper = Number((await new Promise<string>(resolve => leader.stdout!.once("data", d => resolve(String(d))))).trim());
    pids.push(helper);
    await new Promise(resolve => leader.once("exit", resolve));
    expect(processGone(leaderRecord)).toBe(false);
    process.kill(helper, "SIGKILL");
    expect(await until(() => processGone(leaderRecord))).toBe(true);
  });

  it("HO-04 stop points come from the environment in a test build only, and only named ones", () => {
    const killed: string[] = [];
    const kill = (point: string) => () => { killed.push(point); };
    expect(testStopAt({ GATES_LOCAL_UPDATE_TEST_STOP_AT: "L1.spawned" }, false, kill("x"))).toBeUndefined();
    expect(testStopAt({ GATES_LOCAL_UPDATE_TEST_STOP_AT: "nowhere" }, true, kill("x"))).toBeUndefined();
    expect(testStopAt({}, true, kill("x"))).toBeUndefined();
    const stopAt = testStopAt({ GATES_LOCAL_UPDATE_TEST_STOP_AT: "L1.spawned" }, true, kill("L1.spawned"));
    stopAt?.("L1.before");
    expect(killed).toEqual([]);
    stopAt?.("L1.spawned");
    expect(killed).toEqual(["L1.spawned"]);
  });

  it("HO-09 a test build logs the named stop point once, when it is reached, and no other", () => {
    const dir = folder();
    mkdirSync(path.join(dir, "updates"));
    const killed: string[] = [];
    const stopAt = loggedStopAt(dir, { GATES_LOCAL_UPDATE_TEST_STOP_AT: "L1.spawned" }, true, () => { killed.push("L1.spawned"); });
    const lines = () => (existsSync(path.join(dir, "updates", "update.log")) ? readFileSync(path.join(dir, "updates", "update.log"), "utf8") : "").split("\n").filter(l => l !== "").map(l => l.replace(/^\S+ \[\d+\] /, ""));
    stopAt?.("W1.before");
    stopAt?.("L1.before");
    expect(lines()).toEqual([]);
    stopAt?.("L1.spawned");
    expect(lines()).toEqual(["test stop at L1.spawned"]);
    expect(killed).toEqual(["L1.spawned"]);
    expect(loggedStopAt(dir, { GATES_LOCAL_UPDATE_TEST_STOP_AT: "L1.spawned" }, false)).toBeUndefined();
  });

  it("HO-05 a spawned program leads its own group, gets the arguments and environment given, and a missing one throws", async () => {
    const dir = folder();
    const out = path.join(dir, "seen.json");
    const script = path.join(dir, "program.mjs");
    // The process group is the fifth field of /proc/self/stat, after the name in brackets.
    writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";\nconst stat = readFileSync("/proc/self/stat", "utf8");\nconst group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.${STARTUP_TOKEN_ENV} ?? null, leads: group === process.pid }));\n`);
    const pid = spawnProgram(process.execPath, [script, "--no-sandbox"], { ...launchEnv(process.env, "T9") });
    pids.push(pid);
    expect(await until(() => existsSync(out))).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ args: ["--no-sandbox"], token: "T9", leads: true });
    expect(() => spawnProgram(path.join(dir, "missing.AppImage"), [], {})).toThrow();
  });

  it("HO-08 a test build keeps what the programs it starts print, appended to one file; a person's build keeps nothing", async () => {
    const dir = folder();
    expect(spawnedOutput(dir, false)).toBeUndefined();
    const file = spawnedOutput(dir, true);
    expect(file).toBe(path.join(dir, "updates", "spawned.log"));
    mkdirSync(path.join(dir, "updates"));
    const say = (words: string) => spawnProgram("/bin/sh", ["-c", `echo ${words}-out; echo ${words}-err >&2`], {}, file);
    pids.push(say("first"));
    expect(await until(() => existsSync(file!) && readFileSync(file!, "utf8").includes("first-err"))).toBe(true);
    pids.push(say("second"));
    expect(await until(() => readFileSync(file!, "utf8").includes("second-err"))).toBe(true);
    expect(readFileSync(file!, "utf8").split("\n").filter(l => l !== "").toSorted()).toEqual(["first-err", "first-out", "second-err", "second-out"]);
  });
});

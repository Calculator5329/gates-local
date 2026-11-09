import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toBridgeState } from "../src/bridge.ts";
import { findFreePort, Supervisor, TOKEN_ENV, type SupervisorOptions, type SupervisorState } from "../src/supervisor.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-server.ts");
const HOST = join(import.meta.dirname, "fixtures", "host.ts");

// Observe the real child exit, then quit before the supervisor's stderr-flush timer.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe("kept server failure evidence", () => {
  it("IN-02 bounds a large invalid ready line while retaining its failure kind and child termination", async () => {
    const { supervisor } = setup("large-failure", { env: { ...process.env, FAKE_MODE: "large-failure", FAKE_BAD_READY: "1" } });
    const state = await supervisor.start();
    if (state.status !== "crashed" || !state.logPath) throw new Error("Expected a kept failure");
    expect(state.reason.kind).toBe("bad-ready");
    const text = readFileSync(state.logPath, "utf8");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    const kept = JSON.parse(text);
    expect(kept.reason.kind).toBe("bad-ready");
    expect(kept.exit).toEqual(state.exit);
    expect(kept.exit.signal).toBe("SIGTERM");
  });

  it("IN-02 bounds report bytes and count, preserves stderr's end and redaction, and only rotates its own files", async () => {
    const env = { ...process.env, FAKE_MODE: "large-failure", FAKE_REPORT_LABEL: "0" };
    const { supervisor, dataDir } = setup("large-failure", { env, restartLimit: { max: 10, windowMs: 60_000 } });
    const note = join(dataDir, "server-failure-notes.json");
    const lookalike = join(dataDir, "server-failure-1700000000000-aaaaaaaaaaaa.json");
    const link = join(dataDir, "server-failure-1700000000000-bbbbbbbbbbbb.json");
    const hardlink = join(dataDir, "server-failure-1700000000000-cccccccccccc.json");
    const directory = join(dataDir, "server-failure-1700000000000-dddddddddddd.json");
    writeFileSync(note, "user notes");
    writeFileSync(lookalike, JSON.stringify({ memo: "not a failure report" }));
    symlinkSync(note, link);
    linkSync(note, hardlink);
    mkdirSync(directory);
    const legacy = join(dataDir, "server-failure-1700000000000-eeeeeeeeeeee.json");
    writeFileSync(legacy, JSON.stringify({ time: "2023-11-14T22:13:20.000Z", entry: "old-server", execPath: "node", pid: 1, reason: { kind: "exit", code: 3, signal: null }, exit: { code: 3, signal: null }, stderrTail: ["Z".repeat(1024 * 1024)], stdoutTail: [] }, null, 2));
    // Shares the old header's first two fields, and is oversized so rotation would remove a real report.
    const headerTwin = join(dataDir, "server-failure-1700000000000-ffffffffffff.json");
    writeFileSync(headerTwin, JSON.stringify({ time: "2023-11-14T22:13:20.000Z", entry: "my notes", memo: "Z".repeat(1024 * 1024) }, null, 2));
    const reports: string[] = [];
    for (let i = 0; i < 8; i++) {
      env.FAKE_REPORT_LABEL = String(i);
      if (i > 0) expect(supervisor.restart()).toEqual({ ok: true });
      const state = i === 0 ? await supervisor.start() : await supervisor.settled();
      if (state.status !== "crashed" || !state.logPath) throw new Error("Expected a kept real-child failure");
      reports.push(state.logPath);
      const text = readFileSync(state.logPath, "utf8");
      expect.soft(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
      const kept = JSON.parse(text);
      expect(kept).toMatchObject({ reason: { kind: "exit", code: 3, signal: null }, exit: { code: 3, signal: null } });
      const end = `🙂éEND-STDERR:${i}`;
      const stderr = kept.stderrTail.join("\n");
      expect(stderr.endsWith(end)).toBe(true);
      expect(stderr).toContain("[redacted]");
      expect(stderr).not.toContain("\ufffd");
      // After removing the redaction markers and fixture label, no hex token
      // fragments may remain, even at a byte/Unicode truncation boundary.
      for (const output of [stderr, state.stderrTail.join("\n")]) {
        const withoutMarkers = output.replaceAll("[redacted]", "").replaceAll(end, "");
        expect.soft(/[a-f0-9]/.test(withoutMarkers)).toBe(false);
      }
    }
    expect.soft(reports.filter(file => existsSync(file))).toEqual(reports.slice(-5));
    expect.soft(existsSync(legacy)).toBe(false);
    expect(readFileSync(note, "utf8")).toBe("user notes");
    expect(readFileSync(lookalike, "utf8")).toBe(JSON.stringify({ memo: "not a failure report" }));
    expect.soft(existsSync(headerTwin)).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("user notes");
    expect(readFileSync(hardlink, "utf8")).toBe("user notes");
    expect(existsSync(directory)).toBe(true);
  }, 15_000);

  it("IN-01 keeps an exit observed before quit while the crash callback is pending", async () => {
    const { supervisor, dataDir, states } = setup("exit-early");
    const started = supervisor.start();
    const child = vi.mocked(spawn).mock.results.at(-1)?.value;
    if (!child) throw new Error("No real child was spawned");
    await once(child, "exit");
    expect(child.exitCode).toBe(3);
    expect(supervisor.state.status).toBe("starting");
    await supervisor.stop();
    expect((await started).status).toBe("stopped");
    const reports = readdirSync(dataDir).filter(name => name.startsWith("server-failure-"));
    expect(reports).toHaveLength(1);
    const kept = JSON.parse(readFileSync(join(dataDir, reports[0]!), "utf8"));
    expect(kept).toMatchObject({ reason: { kind: "exit", code: 3, signal: null }, exit: { code: 3, signal: null } });
    expect(kept.stderrTail).toContain("fatal: cannot open database");
    expect(states.map(state => state.status)).toEqual(["starting", "stopping", "stopped"]);
  });

  it("IN-01 does not keep a crash report for a child forcibly killed by stop", async () => {
    const { supervisor, dataDir } = setup("ignore-term", { stopTimeoutMs: 30 });
    expect((await supervisor.start()).status).toBe("ready");
    await supervisor.stop();
    expect(supervisor.state.status).toBe("stopped");
    expect(readdirSync(dataDir).filter(name => name.startsWith("server-failure-"))).toEqual([]);
  });
  it("keeps a report after quit with the child exit and stderr, without its token", async () => {
    const { supervisor, dataDir } = setup("exit-early", { env: { ...process.env, FAKE_MODE: "exit-early", FAKE_ECHO_TOKEN: "1" } });
    const state = await supervisor.start();
    expect(state.status).toBe("crashed");
    if (state.status !== "crashed") return;
    const bridge = toBridgeState(state);
    await supervisor.stop();
    expect(bridge).toMatchObject({ exit: { code: 3, signal: null }, logPath: expect.any(String) });
    const files = readdirSync(dataDir).filter(name => name.startsWith("server-failure-"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dataDir, files[0]!), "utf8");
    const kept = JSON.parse(text);
    expect(kept).toMatchObject({ reason: { kind: "exit", code: 3 }, exit: { code: 3, signal: null } });
    expect(text).toContain("fatal: cannot open database");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(launches(dataDir)[0]!.token);
  });

  it("keeps the actual termination separately from a readiness timeout", async () => {
    const { supervisor, dataDir } = setup("never-ready", { readyTimeoutMs: 200 });
    const state = await supervisor.start();
    const files = readdirSync(dataDir).filter(name => name.startsWith("server-failure-"));
    expect(files).toHaveLength(1);
    const kept = JSON.parse(readFileSync(join(dataDir, files[0]!), "utf8"));
    expect(state).toMatchObject({ reason: { kind: "ready-timeout", timeoutMs: 200 }, exit: { code: null, signal: "SIGTERM" } });
    expect(kept).toMatchObject({ reason: { kind: "ready-timeout" }, exit: { code: null, signal: "SIGTERM" } });
    expect(kept.stderrTail).toContain("loading models...");
  });
});

/** 'gone' only when /proc has no entry: a zombie counts as still there. Windows has no /proc and no zombies. */
function procState(pid: number): "gone" | "zombie" | "alive" {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return "alive";
    } catch {
      return "gone";
    }
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z" ? "zombie" : "alive";
  } catch {
    return "gone";
  }
}

const survivors = (candidates: Iterable<number>) => [...candidates].filter((pid) => procState(pid) === "alive");

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

interface LaunchRecord {
  pid: number;
  port: number;
  token: string;
  argv: string[];
  electronRunAsNode: string | undefined;
}

function launches(dataDir: string): LaunchRecord[] {
  return readdirSync(dataDir)
    .filter((name) => name.startsWith("launch-"))
    .map((name) => JSON.parse(readFileSync(join(dataDir, name), "utf8")) as LaunchRecord);
}

/** The next state with one of these statuses (never the current one). */
async function next(supervisor: Supervisor, ...statuses: SupervisorState["status"][]): Promise<SupervisorState> {
  return await new Promise((resolve) => {
    const off = supervisor.subscribe((state) => {
      if (!statuses.includes(state.status)) return;
      off();
      resolve(state);
    });
  });
}

const live: Supervisor[] = [];
const dirs: string[] = [];
const pids = new Set<number>();

function setup(mode: string, extra: Partial<SupervisorOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "gates-desktop-sup-"));
  dirs.push(dataDir);
  const logs: string[] = [];
  const states: SupervisorState[] = [];
  const supervisor = new Supervisor({
    entry: FAKE,
    dataDir,
    env: { ...process.env, FAKE_MODE: mode },
    readyTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
    log: (line) => logs.push(line),
    ...extra,
  });
  supervisor.subscribe((state) => {
    states.push(state);
    if (state.status === "ready") pids.add(state.pid);
  });
  live.push(supervisor);
  return { supervisor, dataDir, logs, states };
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop()));
  for (const dir of dirs.splice(0)) {
    for (const record of launches(dir)) pids.add(record.pid);
    rmSync(dir, { recursive: true, force: true });
  }
  // A zombie has exited; its adopting parent is responsible for reaping it.
  // Kill actual survivors first so a failure cannot leave running processes.
  const remaining = survivors(pids);
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  pids.clear();
  expect(remaining, "processes left behind").toEqual([]);
});

describe("Supervisor", () => {
  it("starts even when another listener claims the port before the server binds", async () => {
    const { supervisor, dataDir, logs } = setup("claimed-port");
    const state = await supervisor.start();
    expect(state.status, JSON.stringify({ state, logs })).toBe("ready");
    expect(launches(dataDir)[0]?.port).toBe(0);
    if (state.status === "ready") expect(state.port).toBeGreaterThan(0);
  });

  it("starts the server, reaches ready on its assigned port, and stops it", async () => {
    const { supervisor, dataDir, states, logs } = setup("ready");
    const state = await supervisor.start();
    expect(state.status, JSON.stringify({ state, logs })).toBe("ready");
    if (state.status !== "ready") return;

    const [record] = launches(dataDir);
    expect(record?.pid).toBe(state.pid);
    expect(record?.port).toBe(0);
    expect(state.port).toBeGreaterThan(0);
    expect(record?.argv).toEqual(["--port", "0", "--data-dir", dataDir]);
    expect(record?.electronRunAsNode).toBe("1");
    expect(record?.argv.join(" ")).not.toContain(record?.token ?? "missing");
    expect(record?.token).toMatch(/^[0-9a-f]{64}$/);

    await supervisor.stop();
    expect(states.map((s) => s.status)).toEqual(["starting", "ready", "stopping", "stopped"]);
    expect(procState(state.pid)).toBe("gone");
  });

  it("crashes with a ready-timeout reason when no ready line comes, and leaves no child", async () => {
    const { supervisor, dataDir } = setup("never-ready", { readyTimeoutMs: 400 });
    const state = await supervisor.start();
    expect(state.status).toBe("crashed");
    if (state.status !== "crashed") return;
    expect(state.reason).toEqual({ kind: "ready-timeout", timeoutMs: 400 });
    expect(state.stderrTail).toContain("loading models...");
    const [record] = launches(dataDir);
    expect(record).toBeDefined();
    expect(procState(record?.pid ?? -1)).toBe("gone");
  });

  it("reports an exit before ready with its code and stderr", async () => {
    const { supervisor } = setup("exit-early");
    const state = await supervisor.start();
    expect(state).toMatchObject({
      status: "crashed",
      reason: { kind: "exit", code: 3, signal: null },
      stderrTail: ["fatal: cannot open database"],
    });
  });

  it("refuses a ready line that names another port", async () => {
    const { supervisor } = setup("wrong-port", { port: await findFreePort() });
    const state = await supervisor.start();
    expect(state.status).toBe("crashed");
    if (state.status === "crashed") expect(state.reason.kind).toBe("bad-ready");
  });

  it.each([0, -1, 65536, 1.5])("refuses an invalid assigned port %s", async (port) => {
    const { supervisor } = setup("ready", { env: { ...process.env, FAKE_MODE: "ready", FAKE_REPORTED_PORT: String(port) } });
    expect(await supervisor.start()).toMatchObject({ status: "crashed", reason: { kind: "bad-ready" } });
  });

  it("uses an explicit port when requested", async () => {
    const port = await findFreePort();
    const { supervisor } = setup("ready", { port });
    expect(await supervisor.start()).toMatchObject({ status: "ready", port });
  });

  it("reports a spawn error as a crash", async () => {
    const { supervisor } = setup("ready", { execPath: join(tmpdir(), "no-such-binary-gates-local") });
    const state = await supervisor.start();
    expect(state.status).toBe("crashed");
    if (state.status === "crashed") expect(state.reason.kind).toBe("spawn-error");
  });

  it("goes ready -> crashed on exit 1, then an explicit restart reaches ready again", async () => {
    const { supervisor, states } = setup("crash-once");
    const first = await supervisor.start();
    expect(first.status).toBe("ready");
    const crashed = await next(supervisor, "crashed");
    expect(crashed).toMatchObject({ status: "crashed", reason: { kind: "exit", code: 1, signal: null } });
    if (crashed.status !== "crashed") return;
    expect(crashed.stderrTail).toContain("boom: simulated crash");
    expect(crashed.restartBlockedUntil).toBeNull();

    expect(supervisor.restart()).toEqual({ ok: true });
    const again = await supervisor.settled();
    expect(again.status).toBe("ready");
    expect(states.map((s) => s.status)).toEqual(["starting", "ready", "crashed", "restarting", "ready"]);
    if (first.status === "ready" && again.status === "ready") {
      expect(again.pid).not.toBe(first.pid);
      expect(procState(first.pid)).toBe("gone");
    }
  });

  it("shows the crash when the server is killed from outside, and restart brings it back", async () => {
    const { supervisor } = setup("ready");
    const first = await supervisor.start();
    if (first.status !== "ready") throw new Error(`not ready: ${first.status}`);
    const crashing = next(supervisor, "crashed");
    process.kill(first.pid, "SIGKILL");
    const crashed = await crashing;
    // Windows reports a killed process as exit code 1 with no signal.
    const killed = process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" };
    expect(crashed).toMatchObject({ status: "crashed", reason: { kind: "exit", ...killed } });
    expect(supervisor.restart().ok).toBe(true);
    expect((await supervisor.settled()).status).toBe("ready");
  });

  it("SIGKILLs a server that ignores SIGTERM after the grace period", async () => {
    const { supervisor, logs } = setup("ignore-term", { stopTimeoutMs: 400 });
    const state = await supervisor.start();
    if (state.status !== "ready") throw new Error(`not ready: ${state.status}`);
    const began = Date.now();
    await supervisor.stop();
    expect(Date.now() - began).toBeGreaterThanOrEqual(380);
    expect(supervisor.state.status).toBe("stopped");
    expect(logs.some((line) => line.includes("sending SIGKILL"))).toBe(true);
    expect(procState(state.pid)).toBe("gone");
  });

  it("Windows: a stop closes the server's stdin first, so it shuts down itself, and kills only after the grace", async () => {
    const polite = setup("ready", { platform: "win32", stopTimeoutMs: 5_000 });
    const up = await polite.supervisor.start();
    if (up.status !== "ready") throw new Error(`not ready: ${up.status}`);
    const began = Date.now();
    await polite.supervisor.stop();
    expect(Date.now() - began).toBeLessThan(4_000);
    expect(existsSync(join(polite.dataDir, `eof-${up.pid}`))).toBe(true);
    expect(polite.logs.some((line) => line.includes("sending SIGKILL"))).toBe(false);
    expect(procState(up.pid)).toBe("gone");

    const stubborn = setup("ignore-term", { platform: "win32", stopTimeoutMs: 400 });
    const on = await stubborn.supervisor.start();
    if (on.status !== "ready") throw new Error(`not ready: ${on.status}`);
    await stubborn.supervisor.stop();
    expect(stubborn.logs.some((line) => line.includes("kept running after its stdin closed for 400 ms; sending SIGKILL"))).toBe(true);
    expect(procState(on.pid)).toBe("gone");
  });

  it("stops cleanly while still waiting for ready, without reporting a crash", async () => {
    const { supervisor, dataDir, states } = setup("never-ready");
    const started = supervisor.start();
    expect(await waitUntil(() => launches(dataDir).length === 1, 3_000)).toBe(true);
    await supervisor.stop();
    await started;
    expect(states.map((s) => s.status)).toEqual(["starting", "stopping", "stopped"]);
    expect(readdirSync(dataDir).filter(name => name.startsWith("server-failure-"))).toEqual([]);
  });

  it("refuses restart unless crashed, and rate-limits restart loops", async () => {
    let clock = 1_000_000;
    const { supervisor } = setup("exit-early", { restartLimit: { max: 2, windowMs: 60_000 }, now: () => clock });
    await supervisor.start();
    expect(supervisor.state.status).toBe("crashed");

    for (let i = 0; i < 2; i++) {
      expect(supervisor.restart()).toEqual({ ok: true });
      expect(supervisor.restart()).toEqual({ ok: false, reason: "not-crashed" });
      await supervisor.settled();
      clock += 1_000;
    }
    const blocked = supervisor.state;
    expect(blocked.status).toBe("crashed");
    if (blocked.status === "crashed") expect(blocked.restartBlockedUntil).toBe(1_000_000 + 60_000);
    expect(supervisor.restart()).toEqual({ ok: false, reason: "rate-limited", retryAfterMs: 58_000 });

    clock = 1_000_000 + 60_000;
    expect(supervisor.restart()).toEqual({ ok: true });
    await supervisor.settled();
  });

  it("the server exits when its parent dies without cleanup (stdin EOF path)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gates-desktop-host-"));
    dirs.push(dataDir);
    const host = spawn(process.execPath, [HOST, FAKE, dataDir], { stdio: ["ignore", "pipe", "ignore"] });
    if (host.pid !== undefined) pids.add(host.pid);
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: host.stdout }).once("line", resolve);
      host.once("exit", () => reject(new Error("host exited early")));
    });
    const { status, pid } = JSON.parse(line) as { status: string; pid: number };
    pids.add(pid);
    expect(status).toBe("ready");
    // While the parent lives, the server keeps running (its stdin stays open).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(procState(pid)).toBe("alive");
    const hostExited = new Promise((resolve) => host.once("exit", resolve));
    host.kill("SIGKILL");
    await hostExited;
    expect(await waitUntil(() => existsSync(join(dataDir, `eof-${pid}`)), 5_000)).toBe(true);
    expect(await waitUntil(() => procState(pid) !== "alive", 5_000)).toBe(true);
  });

  it("detects a planted server that keeps running after stdin EOF", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "gates-desktop-survivor-"));
    dirs.push(dataDir);
    const child = spawn(process.execPath, [FAKE, "--port", "0", "--data-dir", dataDir], {
      env: { ...process.env, FAKE_MODE: "ignore-term" }, stdio: ["pipe", "pipe", "ignore"],
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const pid = child.pid!;
    pids.add(pid);
    try {
      await new Promise<void>((resolve) => createInterface({ input: child.stdout }).on("line", (line) => { if (line.startsWith("{")) resolve(); }));
      child.stdin.end();
      expect(await waitUntil(() => survivors([pid]).length === 0, 100)).toBe(false);
      expect(survivors([pid])).toEqual([pid]);
      expect(existsSync(join(dataDir, `eof-${pid}`))).toBe(false);
    } finally { child.kill("SIGKILL"); await exited; }
  });
});

describe("bridge state", () => {
  it("exposes the server URL with the launch token, a new token per launch, and no pid", async () => {
    const { supervisor, dataDir } = setup("ready");
    const first = await supervisor.start();
    if (first.status !== "ready") throw new Error(`not ready: ${first.status}`);
    const crashing = next(supervisor, "crashed");
    process.kill(first.pid, "SIGKILL");
    await crashing;
    expect(supervisor.restart().ok).toBe(true);
    const second = await supervisor.settled();
    if (second.status !== "ready") throw new Error(`not ready: ${second.status}`);

    const records = launches(dataDir);
    const tokens = [first, second].map((state) => {
      const bridge = toBridgeState(state);
      expect(bridge).not.toHaveProperty("pid");
      if (bridge.status !== "ready") throw new Error("bridge not ready");
      const url = new URL(bridge.serverUrl);
      expect(url.protocol).toBe("ws:");
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBe(state.port);
      const token = url.searchParams.get("token");
      // The token in the URL is the one the server received in its environment.
      expect(records.find((r) => r.pid === state.pid)?.token).toBe(token);
      return token;
    });
    expect(tokens[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(TOKEN_ENV).toBe("GATES_LOCAL_SERVER_TOKEN");
  });
});

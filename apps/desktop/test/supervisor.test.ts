import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { toBridgeState } from "../src/bridge.ts";
import { Supervisor, TOKEN_ENV, type SupervisorOptions, type SupervisorState } from "../src/supervisor.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-server.ts");
const HOST = join(import.meta.dirname, "fixtures", "host.ts");

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
  // No child of any test survives it, not even as a zombie. Survivors are
  // SIGKILLed first so one failure cannot leak processes past the run.
  const survivors = [...pids].filter((pid) => procState(pid) !== "gone");
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  pids.clear();
  expect(survivors, "processes left behind").toEqual([]);
});

describe("Supervisor", () => {
  it("starts the server, reaches ready on the passed port, and stops it", async () => {
    const { supervisor, dataDir, states } = setup("ready");
    const state = await supervisor.start();
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;

    const [record] = launches(dataDir);
    expect(record?.pid).toBe(state.pid);
    expect(record?.port).toBe(state.port);
    expect(record?.argv).toEqual(["--port", String(state.port), "--data-dir", dataDir]);
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
    const { supervisor } = setup("wrong-port");
    const state = await supervisor.start();
    expect(state.status).toBe("crashed");
    if (state.status === "crashed") expect(state.reason.kind).toBe("bad-ready");
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
    expect(await waitUntil(() => procState(pid) === "gone", 5_000)).toBe(true);
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

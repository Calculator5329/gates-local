import { afterEach, expect, test, vi } from "vitest";
import { groupAlive } from "../../apps/server/src/process-state.ts";
import { firstRunTimes } from "./first-run.ts";

const seam = vi.hoisted(() => ({
  stage: "", phase: "", children: new Set<import("node:child_process").ChildProcess>(), ready: 0,
  abort: new AbortController(), gate: Promise.resolve(),
}));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (_file: string, _args: readonly string[], options: import("node:child_process").SpawnOptions) => {
    const descendant = `${seam.stage === "normal" ? "" : 'process.on("SIGTERM", () => {});'} setInterval(() => {}, 1000);`;
    const worker = `${seam.stage === "normal" ? "" : 'process.on("SIGTERM", () => {});'} const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); child.once("spawn", () => console.log("ready")); setInterval(() => {}, 1000);`;
    const child = actual.spawn(process.execPath, ["-e", worker], { ...options, cwd: undefined, stdio: ["ignore", "pipe", "ignore"] });
    seam.children.add(child);
    child.stdout?.once("data", () => { seam.ready++; });
    if (seam.stage === "spawn" && seam.children.size === 1) seam.abort.abort();
    return child;
  } };
});
vi.mock("@playwright/test", () => ({ chromium: { launch: async () => ({
  close: async () => {},
  newContext: async () => ({
    close: async () => {}, newCDPSession: async () => ({ send: async () => {} }),
    newPage: async () => ({
      addInitScript: async () => {}, goto: async () => {},
      waitForFunction: async () => { seam.phase = "measurement"; if (seam.stage === "measurement") await seam.gate; },
      evaluate: async () => ({ elapsed: 1 }),
    }),
  }),
}) } }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const noop = () => {};
function forceStop(pid: number) {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error; }
}

test.each(["spawn", "readiness", "measurement", "normal"])("first-run owns detached groups during %s and never stops another run", async stage => {
  seam.stage = stage; seam.phase = ""; seam.children.clear(); seam.ready = 0; seam.abort = new AbortController();
  let release = noop;
  seam.gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", async () => { seam.phase = "readiness"; if (stage === "readiness") await seam.gate; return new Response(null); });
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const other = actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
  const otherExited = new Promise<void>(resolve => other.once("exit", () => resolve()));
  const killed = vi.spyOn(process, "kill");
  const measured = firstRunTimes("unused", "unused", 1, undefined, seam.abort.signal);
  const settled = measured.then(() => true, () => false);
  let finished = false; void settled.then(() => { finished = true; });
  try {
    if (stage === "normal") await vi.waitFor(() => expect(finished).toBe(true));
    else {
      await vi.waitFor(() => {
        if (stage === "spawn") expect(seam.children.size).toBeGreaterThan(0);
        else { expect(seam.ready).toBe(2); expect(seam.phase).toBe(stage); }
      });
    }
    const signals = () => killed.mock.calls.filter(([, signal]) => signal !== 0);
    const before = signals().length;
    seam.abort.abort();
    await vi.waitFor(() => {
      for (const child of seam.children) { expect(child.pid).toBeDefined(); expect(groupAlive(child.pid!)).toBe(false); }
    }, { timeout: 1500 });
    if (stage === "normal") expect(signals()).toHaveLength(before);
    if (stage === "spawn") expect(seam.children.size).toBe(1);
    expect(other.pid).toBeDefined(); expect(groupAlive(other.pid!)).toBe(true);
    release();
    expect(await settled).toBe(stage === "normal");
  } finally {
    release();
    for (const child of [...seam.children, other]) {
      if (child.pid !== undefined && groupAlive(child.pid)) forceStop(child.pid);
    }
    await Promise.all([settled, otherExited]);
  }
});

// Server supervisor: spawns the Gates Local server as a child of Electron
// main, waits for its ready line, reports crashes and restarts on request.
// Pure Node (no Electron imports) so vitest can drive it against fakes.
// The CLI contract it speaks is documented in apps/desktop/README.md.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { serverUrl, type RestartResult } from "./bridge.ts";
import type { CrashReason, SupervisorState } from "./supervisor-state.ts";

export type { CrashReason, SupervisorState } from "./supervisor-state.ts";
export type { RestartResult } from "./bridge.ts";

/** Env var the token travels in (not argv: /proc/<pid>/cmdline is world-readable). */
export const TOKEN_ENV = "GATES_LOCAL_SERVER_TOKEN";
export const HOST = "127.0.0.1";

export interface SupervisorOptions {
  /** Server entry file, passed as the first argument to `execPath`. */
  readonly entry: string;
  /** Passed as `--data-dir`; created if missing. */
  readonly dataDir: string;
  /** Defaults to process.execPath (Electron run as Node, or Node under test). */
  readonly execPath?: string;
  /** Base environment for the child; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Fixed port; by default a free loopback port is picked per launch. */
  readonly port?: number;
  readonly readyTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL. */
  readonly stopTimeoutMs?: number;
  readonly stderrTailLines?: number;
  /** Loop guard: at most `max` explicit restarts per `windowMs`. */
  readonly restartLimit?: { readonly max: number; readonly windowMs: number };
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** How a stop asks the server to exit; defaults to process.platform (tests inject). */
  readonly platform?: NodeJS.Platform;
}

const DEFAULTS = {
  readyTimeoutMs: 20_000,
  stopTimeoutMs: 3_000,
  stderrTailLines: 20,
  restartLimit: { max: 3, windowMs: 60_000 },
} as const;

/** Ask the kernel for a free loopback port. */
export async function findFreePort(host: string = HOST): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no port assigned"))));
    });
  });
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

type Listener = (state: SupervisorState) => void;

interface Launch {
  readonly id: number;
  readonly child: ChildProcess;
  readonly port: number;
  readonly url: string;
  readonly stderrTail: string[];
  /** Set when the supervisor itself decided the launch failed (timeout, bad ready). */
  failure: CrashReason | null;
  readyTimer: NodeJS.Timeout | null;
  exited: Promise<void>;
}

export class Supervisor {
  readonly #opts: SupervisorOptions;
  readonly #listeners = new Set<Listener>();
  readonly #restartTimes: number[] = [];
  #state: SupervisorState = { status: "idle" };
  #launchCount = 0;
  #current: Launch | null = null;
  #stopping: Promise<void> | null = null;
  #settleWaiters: Array<() => void> = [];

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
  }

  get state(): SupervisorState {
    return this.#state;
  }

  /** Pid of the live child, if any. */
  get pid(): number | undefined {
    const child = this.#current?.child;
    return child !== undefined && isRunning(child) ? child.pid : undefined;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** First launch. Resolves once the launch is ready or crashed. */
  async start(): Promise<SupervisorState> {
    if (this.#state.status !== "idle") return this.#state;
    return await this.#launch("starting");
  }

  /** Explicit restart from the UI. Only from crashed, and rate-limited. */
  restart(): RestartResult {
    if (this.#state.status !== "crashed") return { ok: false, reason: "not-crashed" };
    const blockedFor = this.#restartBlockedFor();
    if (blockedFor > 0) return { ok: false, reason: "rate-limited", retryAfterMs: blockedFor };
    this.#restartTimes.push(this.#now());
    void this.#launch("restarting");
    return { ok: true };
  }

  /** Resolves on the next ready or crashed state (or immediately if already settled). */
  async settled(): Promise<SupervisorState> {
    const s = this.#state.status;
    if (s === "ready" || s === "crashed" || s === "stopped") return this.#state;
    await new Promise<void>((resolve) => this.#settleWaiters.push(resolve));
    return this.#state;
  }

  /** Stop the child this supervisor spawned: SIGTERM, then SIGKILL after the grace. */
  async stop(): Promise<void> {
    if (this.#state.status === "stopped") return;
    if (this.#stopping !== null) return await this.#stopping;
    this.#stopping = (async () => {
      this.#setState({ status: "stopping" });
      const launch = this.#current;
      if (launch !== null) {
        clearReadyTimer(launch);
        await this.#terminate(launch);
      }
      this.#setState({ status: "stopped" });
    })();
    await this.#stopping;
  }

  /** Last resort for process 'exit' handlers: synchronous SIGKILL of the live child. */
  killNow(): void {
    const child = this.#current?.child;
    if (child !== undefined && isRunning(child)) child.kill("SIGKILL");
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  #restartBlockedFor(): number {
    const { max, windowMs } = this.#opts.restartLimit ?? DEFAULTS.restartLimit;
    const now = this.#now();
    while (this.#restartTimes.length > 0 && now - (this.#restartTimes[0] ?? 0) >= windowMs) {
      this.#restartTimes.shift();
    }
    if (this.#restartTimes.length < max) return 0;
    return (this.#restartTimes[0] ?? now) + windowMs - now;
  }

  #log(line: string): void {
    (this.#opts.log ?? ((l: string) => console.error(l)))(line);
  }

  #setState(state: SupervisorState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(state);
      } catch (error) {
        this.#log(`[supervisor] state listener threw: ${String(error)}`);
      }
    }
    if (state.status === "ready" || state.status === "crashed" || state.status === "stopped") {
      const waiters = this.#settleWaiters;
      this.#settleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  #isCurrent(id: number): boolean {
    return this.#current?.id === id && this.#stopping === null;
  }

  async #launch(status: "starting" | "restarting"): Promise<SupervisorState> {
    const id = ++this.#launchCount;
    this.#setState({ status, launch: id });
    let port: number;
    try {
      port = this.#opts.port ?? (await findFreePort());
      mkdirSync(this.#opts.dataDir, { recursive: true });
    } catch (error) {
      if (this.#stopping === null) this.#crash(id, null, { kind: "spawn-error", message: String(error) }, []);
      return this.#state;
    }
    if (this.#stopping !== null) return this.#state;

    const token = newToken();
    const execPath = this.#opts.execPath ?? process.execPath;
    const args = [this.#opts.entry, "--port", String(port), "--data-dir", this.#opts.dataDir];
    const env = { ...(this.#opts.env ?? process.env), ELECTRON_RUN_AS_NODE: "1", [TOKEN_ENV]: token };
    // stdin stays an open pipe for the child's lifetime: when this process
    // dies, even by SIGKILL, the kernel closes it and the server sees EOF.
    const child = spawn(execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = deferred();
    const launch: Launch = {
      id,
      child,
      port,
      url: serverUrl(port, token),
      stderrTail: [],
      failure: null,
      readyTimer: null,
      exited: exited.promise,
    };
    this.#current = launch;
    this.#log(`[supervisor] launch ${id}: ${execPath} ${args.join(" ")} (pid ${String(child.pid)})`);

    child.stdin?.on("error", () => {});
    const tailMax = this.#opts.stderrTailLines ?? DEFAULTS.stderrTailLines;
    if (child.stderr !== null) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        launch.stderrTail.push(line);
        if (launch.stderrTail.length > tailMax) launch.stderrTail.shift();
        this.#log(`[server] ${line}`);
      });
    }
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on("line", (line) => this.#onStdout(launch, line));
    }

    child.once("error", (error) => {
      if (child.pid !== undefined) return; // kill() failures etc.; the exit event still comes
      exited.resolve();
      if (this.#isCurrent(id)) this.#crash(id, null, { kind: "spawn-error", message: error.message }, []);
    });
    child.once("exit", (code, signal) => {
      clearReadyTimer(launch);
      child.stdin?.destroy();
      exited.resolve();
      if (!this.#isCurrent(id)) return;
      const reason = launch.failure ?? { kind: "exit", code, signal };
      // Give the stderr reader a moment to flush the last lines; do not wait
      // for 'close', which never comes if a grandchild inherited the pipes.
      setTimeout(() => {
        if (this.#isCurrent(id)) this.#crash(id, child.pid ?? null, reason, launch.stderrTail);
      }, 50);
    });

    const readyTimeoutMs = this.#opts.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs;
    launch.readyTimer = setTimeout(() => {
      launch.readyTimer = null;
      if (!this.#isCurrent(id) || this.#state.status === "ready") return;
      this.#log(`[supervisor] launch ${id}: no ready line within ${readyTimeoutMs} ms`);
      launch.failure = { kind: "ready-timeout", timeoutMs: readyTimeoutMs };
      void this.#terminate(launch);
    }, readyTimeoutMs);

    return await this.settled();
  }

  #onStdout(launch: Launch, line: string): void {
    const waiting = this.#isCurrent(launch.id) && this.#state.status !== "ready" && launch.failure === null;
    const ready = waiting ? parseReady(line) : null;
    if (ready === null) {
      this.#log(`[server:out] ${line}`);
      return;
    }
    clearReadyTimer(launch);
    if (ready.port !== launch.port) {
      launch.failure = { kind: "bad-ready", line };
      void this.#terminate(launch);
      return;
    }
    const pid = launch.child.pid ?? -1;
    this.#setState({ status: "ready", launch: launch.id, pid, port: launch.port, url: launch.url });
  }

  #crash(id: number, pid: number | null, reason: CrashReason, stderrTail: readonly string[]): void {
    const blockedFor = this.#restartBlockedFor();
    this.#setState({
      status: "crashed",
      launch: id,
      pid,
      reason,
      stderrTail: [...stderrTail],
      restartBlockedUntil: blockedFor > 0 ? this.#now() + blockedFor : null,
    });
  }

  async #terminate(launch: Launch): Promise<void> {
    const { child } = launch;
    if (!isRunning(child)) return await launch.exited;
    // Windows has no SIGTERM: kill("SIGTERM") there is TerminateProcess, so
    // the server's shutdown (which stops the app's own Ollama) would never
    // run. The polite request there is the contract's other one: stdin EOF.
    const win = (this.#opts.platform ?? process.platform) === "win32";
    if (win) child.stdin?.end();
    else child.kill("SIGTERM");
    const graceMs = this.#opts.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs;
    const timer = setTimeout(() => {
      if (!isRunning(child)) return;
      this.#log(`[supervisor] pid ${String(child.pid)} ${win ? "kept running after its stdin closed" : "ignored SIGTERM"} for ${graceMs} ms; sending SIGKILL`);
      child.kill("SIGKILL");
    }, graceMs);
    await launch.exited;
    clearTimeout(timer);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function noop(): void {}

function isRunning(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function clearReadyTimer(launch: Launch): void {
  if (launch.readyTimer !== null) clearTimeout(launch.readyTimer);
  launch.readyTimer = null;
}

/** The ready line is `{"ready":true,"port":<n>}`; anything else is ordinary output. */
export function parseReady(line: string): { port: number } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) return null;
    const record = value as { ready?: unknown; port?: unknown };
    if (record.ready !== true || typeof record.port !== "number") return null;
    return { port: record.port };
  } catch {
    return null;
  }
}

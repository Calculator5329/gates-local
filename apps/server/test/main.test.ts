// The CLI contract from apps/desktop/README.md, against the real entry:
// `node apps/server/src/main.ts --port 0 --data-dir <tmp>` in discover-only
// mode pointed at a fake Ollama. Every child spawned here is killed in
// afterEach if a test left it running.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type SocketLike, createClient } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type FakeOllama, startFakeOllama } from "../src/runtime/test-fakes.ts";

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TOKEN = "a".repeat(64);

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).toReversed()) await c();
});

function cacheTmp(): string {
  const base = path.join(os.homedir(), ".cache", "gates-local-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Launched {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launch(env: Record<string, string>, dataDir: string): Launched {
  const child = spawn(process.execPath, [ENTRY, "--port", "0", "--data-dir", dataDir], {
    env: { PATH: process.env["PATH"] ?? "", HOME: os.homedir(), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  });
  const out: Launched = { child, stdout: [], stderr: [], exited };
  if (child.stdout) createInterface({ input: child.stdout }).on("line", (l) => out.stdout.push(l));
  if (child.stderr) createInterface({ input: child.stderr }).on("line", (l) => out.stderr.push(l));
  return out;
}

async function until<T>(what: string, probe: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms)));
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The HTTP status of an upgrade the server refused, or "open". */
function upgrade(url: string): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      ws.terminate();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("error", (e) => {
      if (ws.readyState !== ws.CLOSED) reject(e);
    });
  });
}

/** A port nothing listens on (bound once, then released). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function fakeOllama(): Promise<FakeOllama> {
  const fake = await startFakeOllama({
    version: "0.0.7-cli-fake",
    tags: [{ name: "fake:1b", digest: "d1", size: 1, modified_at: "2026-01-01T00:00:00Z" }],
  });
  cleanups.push(() => fake.close());
  return fake;
}

describe("server CLI", () => {
  it("prints the ready line, refuses a missing token, serves threads.list, exits on stdin end", async () => {
    const fake = await fakeOllama();
    const tmp = cacheTmp();
    const dataDir = path.join(tmp, "data", "nested"); // does not exist yet
    const s = launch(
      {
        GATES_LOCAL_SERVER_TOKEN: TOKEN,
        GATES_LOCAL_RUNTIME: "discover-only",
        GATES_LOCAL_OLLAMA_URL: fake.baseUrl,
        XDG_DATA_HOME: path.join(tmp, "xdg"),
      },
      dataDir,
    );
    const readyLine = await until("the ready line", () => s.stdout[0]);
    const ready = JSON.parse(readyLine) as { ready: boolean; port: number };
    expect(ready.ready).toBe(true);
    expect(ready.port).toBeGreaterThan(0);
    expect(Object.keys(ready).toSorted()).toEqual(["port", "ready"]);
    expect(existsSync(path.join(dataDir, "threads.sqlite"))).toBe(true);

    const base = `ws://127.0.0.1:${ready.port}/`;
    expect(await upgrade(base)).toBe(401);
    expect(await upgrade(`${base}?token=${"b".repeat(64)}`)).toBe(401);

    const ws = new WebSocket(`${base}?token=${TOKEN}`);
    cleanups.push(() => ws.terminate());
    const client = createClient(ws as unknown as SocketLike, { timeoutMs: 5000 });
    expect(await client.call("threads.list", {})).toEqual([]);
    const t = await client.call("threads.create", { title: "From the CLI test" });
    expect((await client.call("threads.list", {})).map((x) => x.id)).toEqual([t.id]);
    // discover() ran in the background against the fake.
    let status = await client.call("runtime.status", {});
    for (const deadline = Date.now() + 5000; status.state !== "ready" && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 50));
      status = await client.call("runtime.status", {});
    }
    expect(status).toMatchObject({ state: "ready", owner: "external", baseUrl: fake.baseUrl, version: "0.0.7-cli-fake" });
    expect((await client.call("models.list", {})).map((m) => m.name)).toEqual(["fake:1b"]);
    client.close();

    expect(s.stdout).toEqual([readyLine]); // exactly one stdout line; logs went to stderr
    expect(s.stderr.join("\n")).not.toContain(TOKEN);

    const t0 = Date.now();
    s.child.stdin?.end();
    const exit = await withTimeout(s.exited, 3000, "exit after stdin end");
    expect(exit).toEqual({ code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(3000);
    // Nothing on the fake but reads: discover-only never starts or installs.
    expect(fake.requests.every((r) => r.startsWith("GET "))).toBe(true);
  });

  it("exits on SIGTERM within 3 s", async () => {
    const fake = await fakeOllama();
    const tmp = cacheTmp();
    const s = launch(
      {
        GATES_LOCAL_SERVER_TOKEN: TOKEN,
        GATES_LOCAL_RUNTIME: "discover-only",
        GATES_LOCAL_OLLAMA_URL: fake.baseUrl,
        XDG_DATA_HOME: path.join(tmp, "xdg"),
      },
      path.join(tmp, "data"),
    );
    await until("the ready line", () => s.stdout[0]);
    s.child.kill("SIGTERM");
    expect(await withTimeout(s.exited, 3000, "exit after SIGTERM")).toEqual({ code: 0, signal: null });
  });

  it("GATES_LOCAL_OLLAMA_BINARY=none stops the binary search, so an ollama on PATH no longer reads as stopped", async () => {
    const tmp = cacheTmp();
    // a runnable `ollama` on PATH, and nothing listening on the pinned port
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "ollama"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const port = await freePort();
    const statusWith = async (extra: Record<string, string>, name: string) => {
      const s = launch(
        {
          GATES_LOCAL_SERVER_TOKEN: TOKEN,
          GATES_LOCAL_RUNTIME: "discover-only",
          GATES_LOCAL_OLLAMA_URL: `http://127.0.0.1:${port}`,
          XDG_DATA_HOME: path.join(tmp, `xdg-${name}`),
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          ...extra,
        },
        path.join(tmp, `data-${name}`),
      );
      const ready = JSON.parse(await until("the ready line", () => s.stdout[0])) as { port: number };
      const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/?token=${TOKEN}`);
      cleanups.push(() => ws.terminate());
      const client = createClient(ws as unknown as SocketLike, { timeoutMs: 5000 });
      let status = await client.call("runtime.status", {});
      for (const deadline = Date.now() + 5000; status.state === "starting" && Date.now() < deadline; ) {
        await new Promise((r) => setTimeout(r, 50));
        status = await client.call("runtime.status", {});
      }
      client.close();
      return status;
    };
    expect((await statusWith({}, "search")).state).toBe("stopped");
    expect((await statusWith({ GATES_LOCAL_OLLAMA_BINARY: "none" }, "none")).state).toBe("missing");
  });

  it("refuses an unknown GATES_LOCAL_OLLAMA_BINARY value", async () => {
    const tmp = cacheTmp();
    const s = launch({ GATES_LOCAL_SERVER_TOKEN: TOKEN, GATES_LOCAL_OLLAMA_BINARY: "off", XDG_DATA_HOME: path.join(tmp, "xdg") }, path.join(tmp, "data"));
    const exit = await withTimeout(s.exited, 5000, "exit on a bad knob");
    await new Promise((r) => setTimeout(r, 50));
    expect(exit.code).toBe(2);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join("\n")).toContain('GATES_LOCAL_OLLAMA_BINARY must be unset or "none", got "off"');
  });

  it("refuses to start without the token env: non-zero exit, one stderr line, no ready line", async () => {
    const fake = await fakeOllama();
    const tmp = cacheTmp();
    const s = launch({ GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_URL: fake.baseUrl, XDG_DATA_HOME: path.join(tmp, "xdg") }, path.join(tmp, "data"));
    const exit = await withTimeout(s.exited, 5000, "exit without a token");
    await new Promise((r) => setTimeout(r, 50)); // let readline flush
    expect(exit.code).not.toBe(0);
    expect(exit.code).not.toBeNull();
    expect(s.stdout).toEqual([]);
    expect(s.stderr).toHaveLength(1);
    expect(s.stderr[0]).toContain("GATES_LOCAL_SERVER_TOKEN");
    expect(fake.requests).toEqual([]);
  });
});

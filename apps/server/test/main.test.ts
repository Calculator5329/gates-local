// The CLI contract from apps/desktop/README.md, against the real entry:
// `node apps/server/src/main.ts --port 0 --data-dir <tmp>` in discover-only
// mode pointed at a fake Ollama. Every child spawned here is killed in
// afterEach if a test left it running.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type SocketLike, createClient } from "@gates-local/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type FakeOllama, startFakeOllama, writeFakeBinary } from "../src/runtime/test-fakes.ts";

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
    // never the machine's own ComfyUI (8188) or comfyui.service: a port nothing listens on
    env: { PATH: process.env["PATH"] ?? "", HOME: os.homedir(), TMPDIR: process.env["TMPDIR"], TMP: process.env["TMP"], TEMP: process.env["TEMP"], GATES_LOCAL_COMFY_URL: "http://127.0.0.1:1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
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

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
    })]);
  } finally { clearTimeout(deadline); }
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
    const client = createClient(ws as unknown as SocketLike, { timeoutMs: 20_000 });
    expect(await client.call("threads.list", {})).toEqual([]);
    const t = await client.call("threads.create", { title: "From the CLI test" });
    expect((await client.call("threads.list", {})).map((x) => x.id)).toEqual([t.id]);
    // discover() ran in the background against the fake.
    let status = await client.call("runtime.status", {});
    await vi.waitFor(async () => {
      status = await client.call("runtime.status", {});
      expect(status.state).toBe("ready");
    }, { timeout: 20_000 });
    expect(status).toMatchObject({ state: "ready", owner: "external", baseUrl: fake.baseUrl, version: "0.0.7-cli-fake" });
    expect((await client.call("models.list", {})).map((m) => m.name)).toEqual(["fake:1b"]);
    client.close();

    expect(s.stdout).toEqual([readyLine]); // exactly one stdout line; logs went to stderr
    expect(s.stderr.join("\n")).not.toContain(TOKEN);

    s.child.stdin?.end();
    const exit = await s.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    // Nothing on the fake but reads: discover-only never starts or installs.
    // POST /api/show is a read (capabilities for models.list).
    expect(fake.requests.filter((r) => !r.startsWith("GET ") && !r.startsWith("POST /api/show"))).toEqual([]);
  });

  it("a pinned URL alone is discover-only: an ollama on PATH is never run", async () => {
    const tmp = cacheTmp();
    const binDir = path.join(tmp, "bin");
    const ran = path.join(tmp, "ran");
    writeFakeBinary(path.join(binDir, "ollama"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran");\n`);
    const s = launch(
      { GATES_LOCAL_SERVER_TOKEN: TOKEN, GATES_LOCAL_OLLAMA_URL: `http://127.0.0.1:${await freePort()}`, PATH: `${binDir}:${process.env["PATH"] ?? ""}`, XDG_DATA_HOME: path.join(tmp, "xdg") },
      path.join(tmp, "data"),
    );
    const line = await until("the runtime line", () => s.stderr.find((l) => /runtime (ready|stopped|missing|error|starting|wrong-service) /.test(l)));
    expect(existsSync(ran)).toBe(false);
    expect(line).toContain("runtime stopped (none)");
    expect(s.stderr.some((l) => l.includes("runtime discover-only"))).toBe(true);
  });

  // Windows cannot deliver SIGTERM (kill() there is TerminateProcess); the
  // desktop app stops the server through stdin EOF, tested above.
  it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGHUP"] as const)("exits on %s within 3 s", async signal => {
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
    s.child.kill(signal);
    expect(await withTimeout(s.exited, 3000, `exit after ${signal}`)).toEqual({ code: 0, signal: null });
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
      const client = createClient(ws as unknown as SocketLike, { timeoutMs: 20_000 });
      let status = await client.call("runtime.status", {});
      await vi.waitFor(async () => {
        status = await client.call("runtime.status", {});
        expect(status.state).not.toBe("starting");
      }, { timeout: 20_000 });
      client.close();
      return status;
    };
    expect((await statusWith({}, "search")).state).toBe("stopped");
    expect((await statusWith({ GATES_LOCAL_OLLAMA_BINARY: "none" }, "none")).state).toBe("missing");
  });

  it("discover-only: runtime Retry looks again and never runs the Ollama on PATH, though nothing answers", async () => {
    const tmp = cacheTmp();
    // a recording `ollama` on PATH (the real one is never run), and nothing on the pinned port:
    // the managed runtime would start this binary there
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const record = path.join(tmp, "ollama-runs.txt");
    writeFileSync(path.join(bin, "ollama"), `#!/bin/sh\necho "$@" >> '${record}'\nexit 1\n`, { mode: 0o755 });
    const port = await freePort();
    const s = launch(
      {
        GATES_LOCAL_SERVER_TOKEN: TOKEN,
        GATES_LOCAL_RUNTIME: "discover-only",
        GATES_LOCAL_OLLAMA_URL: `http://127.0.0.1:${port}`,
        XDG_DATA_HOME: path.join(tmp, "xdg"),
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      },
      path.join(tmp, "data"),
    );
    const ready = JSON.parse(await until("the ready line", () => s.stdout[0])) as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/?token=${TOKEN}`);
    cleanups.push(() => ws.terminate());
    const client = createClient(ws as unknown as SocketLike, { timeoutMs: 20_000 });
    const retried = await client.call("runtime.retry", {});
    // A short observation window checks that Retry schedules no later start.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(existsSync(record) ? readFileSync(record, "utf8") : "").toBe("");
    expect(retried).toMatchObject({ state: "stopped", owner: "none" });
    client.close();
  }, 30_000);

  it("refuses an unknown GATES_LOCAL_OLLAMA_BINARY value", async () => {
    const tmp = cacheTmp();
    const s = launch({ GATES_LOCAL_SERVER_TOKEN: TOKEN, GATES_LOCAL_OLLAMA_BINARY: "off", XDG_DATA_HOME: path.join(tmp, "xdg") }, path.join(tmp, "data"));
    const exit = await s.exited;
    expect(exit.code).toBe(2);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join("\n")).toContain('GATES_LOCAL_OLLAMA_BINARY must be unset or "none", got "off"');
  });

  it("refuses to start without the token env: non-zero exit, one stderr line, no ready line", async () => {
    const fake = await fakeOllama();
    const tmp = cacheTmp();
    const s = launch({ GATES_LOCAL_RUNTIME: "discover-only", GATES_LOCAL_OLLAMA_URL: fake.baseUrl, XDG_DATA_HOME: path.join(tmp, "xdg") }, path.join(tmp, "data"));
    const exit = await s.exited;
    expect(exit.code).not.toBe(0);
    expect(exit.code).not.toBeNull();
    expect(s.stdout).toEqual([]);
    expect(s.stderr).toHaveLength(1);
    expect(s.stderr[0]).toContain("GATES_LOCAL_SERVER_TOKEN");
    expect(fake.requests).toEqual([]);
  });
});

/** A built-client stand-in for GATES_LOCAL_WEB_ROOT. */
function webRoot(tmp: string): string {
  const root = path.join(tmp, "dist");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<!doctype html><html><head><title>Gates Local</title></head><body></body></html>");
  return root;
}

/** GET / over the phone socket, with headers of our choosing. */
function getRoot(socketPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/", headers }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("server CLI phone listener (GATES_LOCAL_WEB_LISTEN)", () => {
  const ORIGIN = "https://hub.example.ts.net:8456";
  const USER = "owner@example.com";

  it.each([
    ["a loopback TCP address", { GATES_LOCAL_WEB_LISTEN: "127.0.0.1:{port}" }, "TCP is refused"],
    ["an IPv6 loopback TCP address", { GATES_LOCAL_WEB_LISTEN: "[::1]:{port}" }, "TCP is refused"],
    ["a wildcard host", { GATES_LOCAL_WEB_LISTEN: "0.0.0.0:{port}" }, "TCP is refused"],
    ["a host name", { GATES_LOCAL_WEB_LISTEN: "localhost:{port}" }, "TCP is refused"],
    ["a bare port", { GATES_LOCAL_WEB_LISTEN: "{port}" }, "TCP is refused"],
    ["a tcp: URL", { GATES_LOCAL_WEB_LISTEN: "http://127.0.0.1:{port}" }, "TCP is refused"],
    ["a path with no unix: prefix", { GATES_LOCAL_WEB_LISTEN: "/run/phone.sock" }, "unix:<absolute path>"],
    ["a relative unix: path", { GATES_LOCAL_WEB_LISTEN: "unix:run/phone.sock" }, "absolute"],
    ["an empty unix: path", { GATES_LOCAL_WEB_LISTEN: "unix:" }, "absolute"],
    ["an empty origin", { GATES_LOCAL_WEB_ORIGIN: "" }, "GATES_LOCAL_WEB_ORIGIN"],
    ["an origin with no scheme", { GATES_LOCAL_WEB_ORIGIN: "hub.example.ts.net:8456" }, "GATES_LOCAL_WEB_ORIGIN"],
    ["an origin with a path", { GATES_LOCAL_WEB_ORIGIN: "https://hub.example.ts.net:8456/app" }, "GATES_LOCAL_WEB_ORIGIN"],
    ["an origin with credentials", { GATES_LOCAL_WEB_ORIGIN: "https://a:b@hub.example.ts.net:8456" }, "GATES_LOCAL_WEB_ORIGIN"],
    ["a non-http origin", { GATES_LOCAL_WEB_ORIGIN: "ftp://hub.example.ts.net" }, "GATES_LOCAL_WEB_ORIGIN"],
    ["an empty user", { GATES_LOCAL_WEB_USER: "" }, "GATES_LOCAL_WEB_USER"],
    ["a user with spaces", { GATES_LOCAL_WEB_USER: " owner@example.com" }, "GATES_LOCAL_WEB_USER"],
    ["no web root", { GATES_LOCAL_WEB_ROOT: "" }, "GATES_LOCAL_WEB_ROOT"],
    ["a peer that is a host name", { GATES_LOCAL_WEB_PEERS: "192.0.2.10,phone" }, "GATES_LOCAL_WEB_PEERS"],
    ["an empty peer item", { GATES_LOCAL_WEB_PEERS: "192.0.2.10," }, "GATES_LOCAL_WEB_PEERS"],
    ["a peer with a port", { GATES_LOCAL_WEB_PEERS: "192.0.2.10:443" }, "GATES_LOCAL_WEB_PEERS"],
  ])("refuses to start with %s: exit 2, no ready line, nothing listening", async (_what, override, named) => {
    const tmp = cacheTmp();
    const port = await freePort();
    const env: Record<string, string> = {
      GATES_LOCAL_SERVER_TOKEN: TOKEN,
      GATES_LOCAL_RUNTIME: "discover-only",
      GATES_LOCAL_OLLAMA_BINARY: "none",
      XDG_DATA_HOME: path.join(tmp, "xdg"),
      GATES_LOCAL_WEB_LISTEN: `unix:${path.join(tmp, "run", "phone.sock")}`,
      GATES_LOCAL_WEB_ORIGIN: ORIGIN,
      GATES_LOCAL_WEB_USER: USER,
      GATES_LOCAL_WEB_ROOT: webRoot(tmp),
    };
    for (const [k, v] of Object.entries(override)) env[k] = v.replace("{port}", String(port));
    const s = launch(env, path.join(tmp, "data"));
    const exit = await s.exited;
    expect(exit.code).toBe(2);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join("\n")).toContain(named);
    expect(s.stderr.join("\n")).not.toContain(USER);
    expect(existsSync(path.join(tmp, "run")), "no socket directory made").toBe(false);
  });

  it("refuses to start when the socket directory has group access: no ready line, directory untouched", async () => {
    const tmp = cacheTmp();
    const run = path.join(tmp, "run");
    mkdirSync(run);
    chmodSync(run, 0o750);
    const s = launch(
      {
        GATES_LOCAL_SERVER_TOKEN: TOKEN,
        GATES_LOCAL_RUNTIME: "discover-only",
        GATES_LOCAL_OLLAMA_BINARY: "none",
        XDG_DATA_HOME: path.join(tmp, "xdg"),
        GATES_LOCAL_WEB_LISTEN: `unix:${path.join(run, "phone.sock")}`,
        GATES_LOCAL_WEB_ORIGIN: ORIGIN,
        GATES_LOCAL_WEB_USER: USER,
        GATES_LOCAL_WEB_ROOT: webRoot(tmp),
      },
      path.join(tmp, "data"),
    );
    const exit = await s.exited;
    expect(exit.code).not.toBe(0);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join("\n")).toContain("group or other access");
    expect(existsSync(path.join(run, "phone.sock"))).toBe(false);
  });

  it("with every knob right it opens the owner-only phone socket beside the token listener", async () => {
    const tmp = cacheTmp();
    const socketPath = path.join(tmp, "run", "phone.sock");
    const s = launch(
      {
        GATES_LOCAL_SERVER_TOKEN: TOKEN,
        GATES_LOCAL_RUNTIME: "discover-only",
        GATES_LOCAL_OLLAMA_BINARY: "none",
        XDG_DATA_HOME: path.join(tmp, "xdg"),
        GATES_LOCAL_WEB_LISTEN: `unix:${socketPath}`,
        GATES_LOCAL_WEB_ORIGIN: ORIGIN,
        GATES_LOCAL_WEB_USER: USER,
        GATES_LOCAL_WEB_ROOT: webRoot(tmp),
        GATES_LOCAL_WEB_PEERS: " 192.0.2.10 , 2001:DB8::7",
      },
      path.join(tmp, "data"),
    );
    const ready = JSON.parse(await until("the ready line", () => s.stdout[0])) as { port: number };
    expect((lstatSync(socketPath).mode & 0o777).toString(8)).toBe("600");
    expect((lstatSync(path.join(tmp, "run")).mode & 0o777).toString(8)).toBe("700");
    // Serve's Unix-backend shape: Host localhost, the public host forwarded,
    // the phone's tailnet address as the source, its login.
    const serve = { host: "localhost", "x-forwarded-host": "hub.example.ts.net:8456", "x-forwarded-for": "192.0.2.10", "tailscale-user-login": USER };
    const ok = await getRoot(socketPath, serve);
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('<meta name="gates-local-server" content="same-origin">');
    expect((await getRoot(socketPath, { ...serve, "x-forwarded-for": "2001:db8::7" })).status, "the second listed peer").toBe(200);
    expect((await getRoot(socketPath, { ...serve, "x-forwarded-for": "192.0.2.11" })).status, "an unlisted peer").toBe(403);
    expect((await getRoot(socketPath, { ...serve, "x-forwarded-for": "127.0.0.1" })).status, "this machine").toBe(403);
    expect((await getRoot(socketPath, { host: "localhost", "x-forwarded-host": "hub.example.ts.net:8456", "x-forwarded-for": "192.0.2.10" })).status).toBe(403);
    expect((await getRoot(socketPath, { ...serve, host: "hub.example.ts.net:8456" })).status).toBe(403);
    expect(await upgrade(`ws://127.0.0.1:${ready.port}/?token=${TOKEN}`)).toBe("open");
  });
});

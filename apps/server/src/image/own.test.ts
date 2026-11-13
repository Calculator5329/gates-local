// The app's own ComfyUI as a child process. The engine tree here is the Linux
// layout with a fake: venv/bin/python is a script that runs a tiny Node HTTP
// server on the --port it is given, so the start, read, stop and deadline kill
// run against a real process. No real ComfyUI, no port 8188.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeDir, tmpDir } from "../runtime/test-fakes.ts";
import { engineDir, engineFiles } from "./engine.ts";
import { createOwnComfy, type OwnComfy } from "./own.ts";

const FAKE_ENGINE = `
const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS, JSON.stringify(process.argv.slice(2)));
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"devices":[]}'); }).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address() as net.AddressInfo;
    server.close(() => resolve(port));
  });
});

const answers = (address: string) => fetch(`${address}/system_stats`).then((r) => r.ok, () => false);

let work: string;
let appDataDir: string;
let own: OwnComfy | undefined;

function installFake(version = "0.0.1-test") {
  const dir = engineDir(appDataDir, version);
  const files = engineFiles(dir, "uv-venv");
  mkdirSync(path.dirname(files.python), { recursive: true });
  mkdirSync(path.dirname(files.main), { recursive: true });
  const script = path.join(work, "fake-engine.cjs");
  writeFileSync(script, FAKE_ENGINE);
  writeFileSync(files.python, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(files.python, 0o755);
  writeFileSync(files.main, "# fake\n");
}

beforeEach(() => {
  work = tmpDir("own-comfy");
  appDataDir = path.join(work, "data", "gates-local");
  vi.stubEnv("FAKE_ENGINE_ARGS", path.join(work, "args.json"));
});

afterEach(async () => {
  await own?.stop();
  own = undefined;
  vi.unstubAllEnvs();
  removeDir(work);
});

describe.skipIf(process.platform === "win32")("createOwnComfy", () => {
  it("is not installed until an engine tree is whole, then starts on its own port and stops", async () => {
    const port = await freePort();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.installed()).toBe(false);
    expect(await own.inspect()).toMatchObject({ present: false, active: false });
    installFake();
    expect(own.installed()).toBe(true);
    expect(own.address()).toBe(`http://127.0.0.1:${port}`);
    expect(await own.inspect()).toMatchObject({ present: true, active: false, activeState: "inactive" });

    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    const running = await own.inspect();
    expect(running).toMatchObject({ present: true, active: true, activeState: "active" });
    expect(running.pid).toBeGreaterThan(0);
    const args = JSON.parse(readFileSync(path.join(work, "args.json"), "utf8")) as string[];
    expect(args[0]).toBe(engineFiles(engineDir(appDataDir, "0.0.1-test"), "uv-venv").main);
    expect(args).toEqual(expect.arrayContaining(["--listen", "127.0.0.1", "--port", String(port), "--disable-auto-launch"]));
    expect(args[args.indexOf("--base-directory") + 1]).toBe(path.join(appDataDir, "image"));

    await own.stop();
    expect(await own.inspect()).toMatchObject({ active: false, pid: 0 });
    expect(await answers(own.address())).toBe(false);
  });

  it("the shutdown deadline kills only the run it names", async () => {
    installFake();
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await own.start();
    const { pid } = await own.inspect();
    own.killRuntimeNow!(pid + 1);
    expect((await own.inspect()).active).toBe(true);
    own.killRuntimeNow!(pid);
    await vi.waitFor(async () => expect((await own!.inspect()).active).toBe(false), { timeout: 5000 });
    expect(await answers(own.address())).toBe(false);
  });

  it("tells of a run that ends without the app asking, and not of one the app stops", async () => {
    installFake();
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    const told: number[] = [];
    own.onExit((pid) => told.push(pid));
    await own.start();
    const first = (await own.inspect()).pid;
    process.kill(-first, "SIGKILL");
    await vi.waitFor(() => expect(told).toEqual([first]), { timeout: 5000 });
    await own.start();
    await own.stop();
    expect(told).toEqual([first]);
  });
});

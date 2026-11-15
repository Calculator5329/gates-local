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
import { createOwnComfy, engineChildEnv, writeDevice, type OwnComfy } from "./own.ts";
import { createImageSetup, type BuildPlan } from "./setup.ts";

const FAKE_ENGINE = `
const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS + ".env", JSON.stringify({ cuda: process.env.CUDA_CACHE_PATH, triton: process.env.TRITON_CACHE_DIR, home: process.env.HOME }));
// ComfyUI 0.44 lists <base>/custom_nodes before it serves, and exits when it is missing.
fs.readdirSync(require("node:path").join(process.argv[process.argv.indexOf("--base-directory") + 1], "custom_nodes"));
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

  it("keeps the engine's compiled-kernel caches in the app's runtime folder, and leaves its home alone", async () => {
    installFake();
    vi.stubEnv("CUDA_CACHE_PATH", "/somewhere/the/person/set");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    const seen = JSON.parse(readFileSync(path.join(work, "args.json.env"), "utf8")) as { cuda?: string; triton?: string; home?: string };
    expect(seen.cuda).toBe(path.join(appDataDir, "runtime", "cuda-cache"));
    expect(seen.triton).toBe(path.join(appDataDir, "runtime", "triton-cache"));
    expect(seen.home).toBe(process.env.HOME);
    expect(engineChildEnv({ PATH: "/bin" }, appDataDir)).toEqual({ PATH: "/bin", CUDA_CACHE_PATH: seen.cuda, TRITON_CACHE_DIR: seen.triton });
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

  it("a processor build starts with --cpu after a later setup saw a card, so a card that answers late cannot break it", async () => {
    // The card did not answer during the first setup, so the processor build was made; a later
    // setup run saw the card, skipped the build (one is on disk) and stored the card device. The
    // processor build has no CUDA: started without --cpu it fails on import, on every picture.
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    let room = 0;
    const built: string[] = [];
    const build = (version: string): BuildPlan => ({ kind: "build", version, bytes: 1, run: async () => { built.push(version); installFake(version); } });
    const setup = () => createImageSetup({
      appDataDir, own: own!,
      image: { status: async () => ({ state: "stopped", owner: "none" }), engine: () => ({ owner: "none", state: "stopped", room }), start: async () => ({ presets: [], current: {} }) as never, download: async () => ({ files: [] }) },
      setDevice: (device) => writeDevice(appDataDir, device),
      engine: () => ({ ...build("1.0.0"), cpu: build("1.0.0-cpu") }),
      gpuStatus: async () => ({}) as never,
      settingsAddress: () => undefined,
      push: () => {},
      freeBytes: async () => 1024 ** 4,
    });
    const done = async (s: ReturnType<typeof setup>) => {
      await s.run();
      await vi.waitFor(async () => expect((await s.info()).progress?.step).toBe("done"));
    };
    await done(setup());
    room = 16 * 1024 ** 3;
    await done(setup());
    expect(built).toEqual(["1.0.0-cpu"]);
    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    const args = JSON.parse(readFileSync(path.join(work, "args.json"), "utf8")) as string[];
    expect(args[0]).toBe(engineFiles(engineDir(appDataDir, "1.0.0-cpu"), "uv-venv").main);
    expect(args).toContain("--cpu");
    expect(own.build?.()).toMatchObject({ version: "1.0.0-cpu", cpu: true });
  });

  it("a card build runs on the card, and with --cpu only where the setup found no card to run it on", async () => {
    installFake("1.0.0");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    expect(own.build?.()).toMatchObject({ version: "1.0.0", cpu: false });
    writeDevice(appDataDir, "cpu");
    expect(own.build?.()).toMatchObject({ version: "1.0.0", cpu: true });
    writeDevice(appDataDir, "gpu");
    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    expect(JSON.parse(readFileSync(path.join(work, "args.json"), "utf8"))).not.toContain("--cpu");
  });

  it("with the processor build and the card build both whole, it starts the one for what the computer has", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    // no device recorded: the card build, as a setup on a card writes
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    writeDevice(appDataDir, "cpu");
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
    writeDevice(appDataDir, "gpu");
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    const args = JSON.parse(readFileSync(path.join(work, "args.json"), "utf8")) as string[];
    expect(args[0]).toBe(engineFiles(engineDir(appDataDir, "1.0.0"), "uv-venv").main);
    expect(args).not.toContain("--cpu");
  });

  it("a card build that ends while it starts is passed over for the processor's beside it, until it is tried again and answers", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    const cardPython = engineFiles(engineDir(appDataDir, "1.0.0"), "uv-venv").python;
    const working = readFileSync(cardPython, "utf8");
    // a build that cannot run here: it ends at once, as Python does on an import that fails
    writeFileSync(cardPython, "#!/bin/sh\nexit 3\n");
    const port = await freePort();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    await own.start();
    await vi.waitFor(async () => expect((await own!.inspect()).active).toBe(false), { timeout: 5000 });
    expect(own.failed?.()).toBe("1.0.0");
    // the next start is the processor's, on the processor
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    own.answered?.();
    const args = JSON.parse(readFileSync(path.join(work, "args.json"), "utf8")) as string[];
    expect(args[0]).toBe(engineFiles(engineDir(appDataDir, "1.0.0-cpu"), "uv-venv").main);
    expect(args).toContain("--cpu");
    await own.stop();

    // the app's next start remembers: the build that works is the one that runs, and why
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
    expect(own.heldCard?.()).toBe("1.0.0");
    expect(own.failedCard?.()).toBe("1.0.0");
    // tried again once it can run (a driver put right), it answers, and is the one that runs from then on
    writeFileSync(cardPython, working);
    own.tryCard?.();
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    await own.start();
    await vi.waitFor(async () => expect(await answers(own!.address())).toBe(true), { timeout: 5000 });
    own.answered?.();
    await own.stop();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    expect(own.heldCard?.()).toBeUndefined();
    expect(own.failedCard?.()).toBeUndefined();
  });

  it("nothing is passed over where there is nothing else to start, or the engine is still there", async () => {
    installFake("1.0.0");
    const cardPython = engineFiles(engineDir(appDataDir, "1.0.0"), "uv-venv").python;
    const working = readFileSync(cardPython, "utf8");
    writeFileSync(cardPython, "#!/bin/sh\nexit 3\n");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await own.start();
    await vi.waitFor(async () => expect((await own!.inspect()).active).toBe(false), { timeout: 5000 });
    // the only build: it stays the one that starts, and the start's own error is what is said
    expect(own.failed?.()).toBeUndefined();
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    // the processor's build beside it, and the card's engine running (slow to answer is not ended)
    installFake("1.0.0-cpu");
    writeFileSync(cardPython, working);
    await own.start();
    expect((await own.inspect()).active).toBe(true);
    expect(own.failed?.()).toBeUndefined();
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
  });
});

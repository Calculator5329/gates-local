// The app's own ComfyUI as a child process. The engine tree here is the Linux
// layout with a fake: venv/bin/python is a script that runs a tiny Node HTTP
// server on the --port it is given, so the start, read, stop and deadline kill
// run against a real process. No real ComfyUI, no port 8188.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeDir, tmpDir } from "../runtime/test-fakes.ts";
import { ownedChildEnv } from "../runtime/runtime.ts";
import { engineDir, engineFiles, engineRoot } from "./engine.ts";
import { createOwnComfy, engineChildEnv, engineLogFile, extraModelPaths, extraModelPathsLine, freePort as appFreePort, MODEL_KINDS, writeDevice, type OwnComfy } from "./own.ts";
import { createImageSetup, type BuildPlan } from "./setup.ts";

const FAKE_ENGINE = `
const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS + ".env", JSON.stringify({ cuda: process.env.CUDA_CACHE_PATH, triton: process.env.TRITON_CACHE_DIR, home: process.env.HOME }));
// ComfyUI 0.44 lists <base>/custom_nodes before it serves, and exits when it is missing.
fs.readdirSync(require("node:path").join(process.argv[process.argv.indexOf("--base-directory") + 1], "custom_nodes"));
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"devices":[]}'); }).listen(port, "127.0.0.1", () => console.log("fake engine listening on " + port));
process.on("SIGTERM", () => process.exit(0));
`;

const STUBBORN_ENGINE = `
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
process.on("SIGTERM", () => {});
http.createServer((req, res) => res.end("{}")).listen(port, "127.0.0.1");
`;

const PARENT_ENGINE = `
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS + ".kid", String(kid.pid));
process.on("SIGTERM", () => process.exit(0));
http.createServer((req, res) => res.end("{}")).listen(port, "127.0.0.1");
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
let strays: number[] = [];

const realTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => { realTimeout(resolve, ms); });
const asRoot = process.getuid?.() === 0;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; } catch { return false; }
}

const runtimeFile = (name: string) => path.join(appDataDir, "runtime", name);
const pythonOf = (version: string) => engineFiles(engineDir(appDataDir, version), "uv-venv").python;
const readArgs = () => JSON.parse(readFileSync(path.join(work, "args.json"), "utf8")) as string[];

function useEngine(version: string, source: string) {
  const script = path.join(work, `engine-${version}.cjs`);
  writeFileSync(script, source);
  writeFileSync(pythonOf(version), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
}

function cannotStart(version: string) {
  writeFileSync(pythonOf(version), "#!/bin/sh\nexit 3\n");
}

async function startAnswering(run: OwnComfy) {
  await run.start();
  await vi.waitFor(async () => expect(await answers(run.address())).toBe(true), { timeout: 5000 });
}

async function startEnding(run: OwnComfy) {
  await run.start();
  await vi.waitFor(async () => expect((await run.inspect()).active).toBe(false), { timeout: 5000 });
}

function idle(args: string[]): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { detached: true, stdio: "ignore" });
  return new Promise((resolve, reject) => {
    child.once("spawn", () => { if (child.pid !== undefined) strays.push(child.pid); resolve(child); });
    child.once("error", reject);
  });
}

const exitOf = (child: ChildProcess) => new Promise<NodeJS.Signals | null>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
  else child.once("exit", (_code, signal) => resolve(signal));
});

const filesUnder = (dir: string) => readdirSync(dir, { recursive: true }).map(String).toSorted();

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await own?.stop();
  for (const pid of strays) if (alive(pid)) process.kill(pid, "SIGKILL");
  strays = [];
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
  it("picks a port for the engine that is free to listen on now, and never ComfyUI's usual 8188", async () => {
    const port = await appFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(8188);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("writes what the engine prints to comfyui.log in the app's runtime folder", async () => {
    installFake();
    const port = await freePort();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    await startAnswering(own);
    expect(engineLogFile(appDataDir)).toBe(path.join(appDataDir, "runtime", "comfyui.log"));
    await vi.waitFor(() => expect(readFileSync(path.join(appDataDir, "runtime", "comfyui.log"), "utf8")).toContain(`fake engine listening on ${port}`), { timeout: 5000 });
  });

  it("does not tell of a run the shutdown deadline kills", async () => {
    installFake();
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    const told: number[] = [];
    own.onExit((pid) => told.push(pid));
    await own.start();
    const { pid } = await own.inspect();
    own.killRuntimeNow!(pid);
    await vi.waitFor(async () => expect((await own!.inspect()).active).toBe(false), { timeout: 5000 });
    await realSleep(100);
    expect(told).toEqual([]);
  });

  it("knows its models folder inside the app's image folder before it has ever started", () => {
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.modelsDir?.()).toBe(path.join(appDataDir, "image", "models"));
    expect(existsSync(appDataDir)).toBe(false);
  });

  it("starts the newest whole build by version number, of either kind", () => {
    for (const version of ["1.9.0", "1.10.0", "1.9.0-cpu", "1.10.0-cpu"]) installFake(version);
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.10.0", cpu: false });
    writeDevice(appDataDir, "cpu");
    expect(own.build?.()).toEqual({ version: "1.10.0-cpu", cpu: true });
  });

  it("has no build while none is whole, and never counts a build a killed app left half made", () => {
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.build?.()).toBeUndefined();
    installFake(".build-x1y2z3");
    const files = engineFiles(engineDir(appDataDir, "1.1.0"), "uv-venv");
    mkdirSync(path.dirname(files.python), { recursive: true });
    writeFileSync(files.python, "");
    expect(own.build?.()).toBeUndefined();
    expect(own.installed()).toBe(false);
    installFake("1.0.0");
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
  });

  it("tells the version of the card build it passed over for the processor's", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    cannotStart("1.0.0");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    const heard: string[] = [];
    own.onHeld?.((version) => heard.push(version));
    await startEnding(own);
    expect(own.failed?.()).toBe("1.0.0");
    expect(heard).toEqual(["1.0.0"]);
  });

  it("a card build tried again that still does not start leaves the next start to the processor's build", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    cannotStart("1.0.0");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    own.holdCard?.("1.0.0");
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
    own.tryCard?.();
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    await startEnding(own);
    expect(own.failed?.()).toBe("1.0.0");
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
  });

  it("a stop waits ten seconds for an engine that will not exit, then kills it", async () => {
    installFake();
    useEngine("0.0.1-test", STUBBORN_ENGINE);
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await startAnswering(own);
    const { pid } = await own.inspect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stopped = false;
    const stopping = own.stop().then(() => { stopped = true; });
    vi.advanceTimersByTime(9_999);
    await realSleep(300);
    expect(alive(pid)).toBe(true);
    expect(stopped).toBe(false);
    vi.advanceTimersByTime(1);
    await stopping;
    expect(alive(pid)).toBe(false);
  });

  it("looks in the folder picked for downloads too, read again at each start", async () => {
    installFake();
    let picked: string | undefined = path.join(work, "Pictures A");
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux", extraModels: () => picked });
    await startAnswering(own);
    const first = readArgs();
    const config = first[first.indexOf("--extra-model-paths-config") + 1]!;
    expect(first).toContain("--extra-model-paths-config");
    expect(readFileSync(config, "utf8")).toBe(extraModelPaths(path.join(work, "Pictures A")));
    await own.stop();

    picked = path.join(work, "Pictures B");
    await startAnswering(own);
    const second = readArgs();
    expect(readFileSync(second[second.indexOf("--extra-model-paths-config") + 1]!, "utf8")).toBe(extraModelPaths(path.join(work, "Pictures B")));
    await own.stop();

    picked = undefined;
    await startAnswering(own);
    expect(readArgs()).not.toContain("--extra-model-paths-config");
  });

  it("names exactly the five kinds of model folder, each a folder of that name in the picked folder", () => {
    expect([...MODEL_KINDS]).toEqual(["checkpoints", "loras", "diffusion_models", "text_encoders", "vae"]);
    expect(extraModelPaths("/m").split("\n").slice(2, -1)).toEqual(["  checkpoints: checkpoints", "  loras: loras", "  diffusion_models: diffusion_models", "  text_encoders: text_encoders", "  vae: vae"]);
    expect(extraModelPathsLine("/m")).toContain("checkpoints: checkpoints, loras: loras, diffusion_models: diffusion_models, text_encoders: text_encoders, vae: vae }");
  });

  it("the engine's extra model paths name the picked folder in single quotes, so a Windows path's backslashes stay and a quote is doubled", () => {
    expect(extraModelPaths("C:\\Users\\Dee's PC\\Pictures")).toBe([
      "gates_local:",
      "  base_path: 'C:\\Users\\Dee''s PC\\Pictures'",
      "  checkpoints: checkpoints",
      "  loras: loras",
      "  diffusion_models: diffusion_models",
      "  text_encoders: text_encoders",
      "  vae: vae",
      "",
    ].join("\n"));
  });

  it("the line for a person's own ComfyUI is one YAML flow mapping, the folder single-quoted with a quote doubled", () => {
    expect(extraModelPathsLine("C:\\Users\\Dee's PC\\Pictures")).toBe(
      "gates_local: { base_path: 'C:\\Users\\Dee''s PC\\Pictures', checkpoints: checkpoints, loras: loras, diffusion_models: diffusion_models, text_encoders: text_encoders, vae: vae }",
    );
  });

  it("keeps the engine's kernel cache in the same folder as the app's chat engine", () => {
    expect(engineChildEnv({}, appDataDir).CUDA_CACHE_PATH).toBe(ownedChildEnv({}, appDataDir, 11435, "linux", true).CUDA_CACHE_PATH);
  });

  it("what the computer has and which card build is held are kept beside the engine builds, never inside them", () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    const before = filesUnder(engineRoot(appDataDir));
    writeDevice(appDataDir, "cpu");
    own.holdCard?.("1.0.0");
    expect(readFileSync(runtimeFile("comfyui-device"), "utf8")).toBe("cpu");
    expect(readFileSync(runtimeFile("comfyui-card-held"), "utf8")).toBe("1.0.0");
    expect(filesUnder(engineRoot(appDataDir))).toEqual(before);
  });

  it("holds no card build when the list of held builds cannot be read", () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    mkdirSync(runtimeFile("comfyui-card-held"));
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    expect(own.heldCard?.()).toBeUndefined();
  });

  it("says no card build failed when the list of failed builds cannot be read", () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    writeFileSync(runtimeFile("comfyui-card-held"), "1.0.0");
    mkdirSync(runtimeFile("comfyui-card-failed"));
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.heldCard?.()).toBe("1.0.0");
    expect(own.failedCard?.()).toBeUndefined();
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
  });

  it("a card build that does not start is still passed over for the rest of this run when the hold cannot be saved, and offered again at the next", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    cannotStart("1.0.0");
    mkdirSync(runtimeFile("comfyui-card-held"));
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await startEnding(own);
    expect(own.failed?.()).toBe("1.0.0");
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
    expect(own.heldCard?.()).toBe("1.0.0");
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    expect(own.heldCard?.()).toBeUndefined();
  });

  it("why a card build was passed over is still said for the rest of this run when it cannot be saved, and not at the next", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    cannotStart("1.0.0");
    mkdirSync(runtimeFile("comfyui-card-failed"));
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await startEnding(own);
    expect(own.failed?.()).toBe("1.0.0");
    expect(own.failedCard?.()).toBe("1.0.0");
    own = createOwnComfy({ appDataDir, port: 1, platform: "linux" });
    expect(own.heldCard?.()).toBe("1.0.0");
    expect(own.failedCard?.()).toBeUndefined();
  });

  it.skipIf(asRoot)("a card build that answers when the failed list cannot be rewritten stays listed until it answers after the app's next start", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    writeFileSync(runtimeFile("comfyui-card-held"), "1.0.0");
    writeFileSync(runtimeFile("comfyui-card-failed"), "1.0.0");
    chmodSync(runtimeFile("comfyui-card-failed"), 0o444);
    const port = await freePort();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.failedCard?.()).toBe("1.0.0");
    own.tryCard?.();
    await startAnswering(own);
    own.answered?.();
    expect(own.heldCard?.()).toBeUndefined();
    expect(readFileSync(runtimeFile("comfyui-card-failed"), "utf8")).toBe("1.0.0");
    await own.stop();

    chmodSync(runtimeFile("comfyui-card-failed"), 0o644);
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.build?.()).toEqual({ version: "1.0.0", cpu: false });
    await startAnswering(own);
    own.answered?.();
    expect(readFileSync(runtimeFile("comfyui-card-failed"), "utf8")).toBe("");
  });

  it.skipIf(asRoot)("a card build that answers when the held list cannot be rewritten is held and offered again at the app's next start", async () => {
    installFake("1.0.0-cpu");
    installFake("1.0.0");
    writeFileSync(runtimeFile("comfyui-card-held"), "1.0.0");
    chmodSync(runtimeFile("comfyui-card-held"), 0o444);
    const port = await freePort();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    own.tryCard?.();
    await startAnswering(own);
    own.answered?.();
    await own.stop();
    own = createOwnComfy({ appDataDir, port, platform: "linux" });
    expect(own.heldCard?.()).toBe("1.0.0");
    expect(own.build?.()).toEqual({ version: "1.0.0-cpu", cpu: true });
  });

  it("a stop also ends what the engine itself started", async () => {
    installFake();
    useEngine("0.0.1-test", PARENT_ENGINE);
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await startAnswering(own);
    const kidFile = path.join(work, "args.json.kid");
    await vi.waitFor(() => expect(existsSync(kidFile)).toBe(true), { timeout: 5000 });
    const kid = Number(readFileSync(kidFile, "utf8"));
    strays.push(kid);
    expect(alive(kid)).toBe(true);
    await own.stop();
    await vi.waitFor(() => expect(alive(kid)).toBe(false), { timeout: 5000 });
  });

  it("the shutdown deadline does not throw when the run it names is already gone", async () => {
    installFake();
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await own.start();
    const { pid } = await own.inspect();
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target: number, signal?: string | number) => {
      if (target < 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      return kill(target, signal);
    });
    expect(() => own!.killRuntimeNow!(pid)).not.toThrow();
  });

  it("ends a run the app left behind when it was killed before it starts a new one", async () => {
    installFake();
    const { main } = engineFiles(engineDir(appDataDir, "0.0.1-test"), "uv-venv");
    const leftover = await idle([main]);
    mkdirSync(path.join(appDataDir, "runtime"), { recursive: true });
    writeFileSync(runtimeFile("comfyui.pid"), JSON.stringify({ pid: leftover.pid, main }));
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await startAnswering(own);
    await vi.waitFor(() => expect(alive(leftover.pid!)).toBe(false), { timeout: 5000 });
    expect(await exitOf(leftover)).toBe("SIGKILL");
  });

  it("leaves alone a process the left-behind run's pid now names when it is not the engine", async () => {
    installFake();
    const { main } = engineFiles(engineDir(appDataDir, "0.0.1-test"), "uv-venv");
    const stranger = await idle([path.join(work, "something-else.py")]);
    mkdirSync(path.join(appDataDir, "runtime"), { recursive: true });
    writeFileSync(runtimeFile("comfyui.pid"), JSON.stringify({ pid: stranger.pid, main }));
    own = createOwnComfy({ appDataDir, port: await freePort(), platform: "linux" });
    await startAnswering(own);
    await realSleep(100);
    expect(alive(stranger.pid!)).toBe(true);
  });
});

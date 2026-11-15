// A source checkout's start, with Electron mocked and a real checkout in a
// temporary folder: while an update of the checkout is running or was cut
// off, main starts no server. It says so in a window, and an update a crash
// left is handed to the updater to finish or take back.
import { spawn as realSpawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { INSTALL_ARGS, runUpdate } from "@gates-local/update/apply";
import { runCli } from "@gates-local/update/cli";
import { acquireLock } from "@gates-local/update/lock";
import type { Runner } from "@gates-local/update/run";
import { type Repos, commit, crashAt, fakePnpm, head, makeRepos, publish, removeRepos, testEnv } from "@gates-local/update/testing";
import { readTransaction } from "@gates-local/update/transaction";

const fake = vi.hoisted(() => ({
  /** The supervised server's start: the one thing a half-installed checkout must never reach. */
  started: vi.fn(),
  loaded: [] as string[],
  spawned: [] as Array<{ command: string; args: readonly string[]; pid: number }>,
  exit: vi.fn(),
  quit: vi.fn(),
  relaunch: vi.fn(),
  /** The test checkout, and the folders main asked about. */
  checkout: "",
  asked: [] as string[],
}));
vi.mock("electron", () => ({
  app: {
    setName: vi.fn(), setPath: vi.fn(), getPath: () => ".", requestSingleInstanceLock: () => true, releaseSingleInstanceLock: vi.fn(), on: vi.fn(),
    whenReady: () => Promise.resolve(), isPackaged: false, quit: fake.quit, exit: fake.exit, relaunch: fake.relaunch, commandLine: { hasSwitch: () => false, appendSwitch: vi.fn() },
  },
  BrowserWindow: class {
    webContents = { mainFrame: {}, on: vi.fn(), getURL: () => "", send: vi.fn(), setWindowOpenHandler: vi.fn(), setWebRTCIPHandlingPolicy: vi.fn() };
    on = vi.fn(); isDestroyed = () => false; isFocused = () => true;
    loadURL = async (url: string) => { fake.loaded.push(decodeURIComponent(url)); };
  },
  clipboard: { read: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { setApplicationMenu: vi.fn() }, net: {}, protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));
// Main asks about the checkout it runs from, which under the test runner is this repository. The question is
// passed on with the test checkout in its place (the updater's guard refuses any folder outside the test root).
vi.mock("@gates-local/update/checkout-start", async (original) => {
  const real = await original<typeof import("@gates-local/update/checkout-start")>();
  return {
    ...real,
    checkoutStartFacts: (root: string, ...rest: [Parameters<typeof real.checkoutStartFacts>[1]]) => {
      fake.asked.push(root);
      return real.checkoutStartFacts(fake.checkout, ...rest);
    },
  };
});
vi.mock("./running.ts", () => ({ writeRunning: vi.fn(), clearRunning: vi.fn() }));
vi.mock("./supervisor.ts", () => ({ Supervisor: class { state = { status: "idle" }; subscribe = vi.fn(); start = fake.started; stop = vi.fn(async () => undefined); killNow = vi.fn(); } }));
// The updater main would start is recorded, never run; git in the test repositories runs as it is.
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (command: string, args: readonly string[], options: object) => {
      if (!args.some((a) => a.endsWith(path.join("scripts", "update.ts")))) return real.spawn(command, args, options);
      // Stands in for the updater: a process that starts, changes nothing and stays until the test ends it.
      const child = real.spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
      fake.spawned.push({ command, args, pid: child.pid! });
      return child;
    },
  };
});

let r: Repos;
const children: number[] = [];
const end = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };
beforeEach(() => {
  r = makeRepos();
  fake.checkout = r.clone;
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});
afterEach(() => {
  for (const pid of [...children.splice(0), ...fake.spawned.map((s) => s.pid)]) end(pid);
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules();
  for (const f of [fake.started, fake.exit, fake.quit, fake.relaunch]) f.mockClear();
  fake.loaded.length = 0; fake.spawned.length = 0; fake.asked.length = 0;
  removeRepos(r);
});

async function startApp(): Promise<void> {
  const on = process.on.bind(process);
  // Main's own exit and signal handlers stay out of the test runner; a child process's are its own.
  vi.spyOn(process, "on").mockImplementation((name, fn) => (["exit", "SIGINT", "SIGTERM", "SIGHUP"].includes(String(name)) ? process : on(name, fn)));
  await import("./main.ts");
  // whenReady's callbacks, where main starts its server, are a few microtasks away.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const said = (words: string) => fake.loaded.some((page) => page.includes(words));

it("a checkout with no update in flight starts its server", async () => {
  await startApp();
  await vi.waitFor(() => expect(fake.started).toHaveBeenCalledTimes(1));
  expect(fake.spawned).toEqual([]);
  // It looked before it took the app's lock and again after, both times at the checkout it runs from.
  expect(fake.asked).toEqual([path.resolve(import.meta.dirname, "..", "..", ".."), path.resolve(import.meta.dirname, "..", "..", "..")]);
});

it("an update cut off after the switch is not started as it is: the start hands it to the updater and says it is finishing", async () => {
  const target = commit(r.seed, "Newer");
  publish(r.seed);
  const cut = crashAt(fakePnpm(), (command, args) => command === "fake-pnpm" && args.join(" ") === INSTALL_ARGS.join(" "));
  await expect(runUpdate({ root: r.clone, runner: cut.runner, choice: "main", pnpm: cut.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined })).rejects.toThrow("the power went out");
  // The new commit with nothing installed or built for it: a half.
  expect(head(r.clone)).toBe(target);
  expect(readTransaction(r.clone)).toMatchObject({ phase: "forward" });

  await startApp();
  expect(fake.started).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(fake.spawned).toHaveLength(1));
  expect(fake.spawned[0]!.args).toContain("--finish");
  await vi.waitFor(() => expect(said("Gates Local is finishing an update.")).toBe(true));
  expect(fake.started).not.toHaveBeenCalled();

  // The updater ends having changed nothing (this stand-in does no work): the start says so and still starts nothing.
  end(fake.spawned[0]!.pid);
  await vi.waitFor(() => expect(said("Gates Local did not start.")).toBe(true), { timeout: 5000 });
  expect(said("did not finish")).toBe(true);
  expect(fake.spawned).toHaveLength(1);
  expect(fake.relaunch).not.toHaveBeenCalled();
  expect(fake.started).not.toHaveBeenCalled();
});

it("a checkout cut off while git was writing its files is not started: the window says it is part way, lists the files and gives the way back", async () => {
  const old = head(r.clone);
  commit(r.seed, "Newer");
  publish(r.seed);
  const torn = fakePnpm();
  const cut: Runner = async (command, args, options) => {
    if (!(command === "git" && args[0] === "merge")) return torn.runner(command, args, options);
    writeFileSync(path.join(r.clone, "app.txt"), "half of the new version\n");
    throw new Error("the power went out");
  };
  await expect(runUpdate({ root: r.clone, runner: cut, choice: "main", pnpm: torn.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined })).rejects.toThrow("the power went out");

  await startApp();
  await vi.waitFor(() => expect(fake.spawned).toHaveLength(1));
  expect(fake.spawned[0]!.args).toContain("--finish");
  // The updater main asked for is a stand-in here, so the same command is run in its place, on the test checkout.
  const again = fakePnpm();
  const code = await runCli({
    root: r.clone, argv: ["--data-dir", r.data, "--finish"],
    defaultDataDir: r.data, pnpm: again.pnpm, runner: again.runner, appRunning: () => null, relaunch: vi.fn(), print: () => undefined, platform: "linux",
  });
  expect(code).toBe(1);
  end(fake.spawned[0]!.pid);

  await vi.waitFor(() => expect(said("Gates Local did not start.")).toBe(true), { timeout: 5000 });
  const page = fake.loaded.at(-1)!;
  expect(page).toContain("was cut off while it was changing files, so this copy is part way between two versions.");
  expect(page).toContain("app.txt");
  expect(page).toContain("Copy those somewhere safe first.");
  expect(page).toContain("git reset --hard");
  expect(page).toContain("pnpm run app-update");
  // Nothing was started, nothing was cleaned up, and nothing was tried a second time.
  expect(fake.started).not.toHaveBeenCalled();
  expect(fake.relaunch).not.toHaveBeenCalled();
  expect(fake.spawned).toHaveLength(1);
  expect(head(r.clone)).toBe(old);
  expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("half of the new version\n");
  expect(readTransaction(r.clone)).toMatchObject({ phase: "forward" });
});

it("while an update is running the start waits and says so, and starts no server", async () => {
  const updater = realSpawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  children.push(updater.pid!);
  expect(acquireLock(r.clone, { pid: updater.pid! }).ok).toBe(true);

  await startApp();
  expect(fake.started).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(said("Gates Local is updating.")).toBe(true));
  expect(fake.spawned).toEqual([]);
  expect(fake.started).not.toHaveBeenCalled();

  // The update ends with nothing left: the waiting start opens the app as a new process, and is never the app itself.
  end(updater.pid!);
  await vi.waitFor(() => expect(fake.relaunch).toHaveBeenCalledTimes(1), { timeout: 5000 });
  expect(fake.started).not.toHaveBeenCalled();
});

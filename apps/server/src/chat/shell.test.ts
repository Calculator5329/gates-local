import { expect, it } from "vitest";
import { createProbe, PROBE_RETRY_MS, SCOPE_LIMITS, type SandboxHost, type SandboxProbe } from "@gates-local/harness/sandbox";
import { createShellStatus } from "./shell.ts";

it("ready with sqlite3 is plain ready; without it the status says what cannot be done", async () => {
  const lines: string[] = [];
  expect(await createShellStatus(async () => ({ available: true, arch: "x64", sqlite: true }), (l) => lines.push(l))()).toEqual({ state: "ready" });
  const status = await createShellStatus(async () => ({ available: true, arch: "x64", sqlite: false }), (l) => lines.push(l))();
  expect(status).toEqual({ state: "ready", word: "Ready, without sqlite3", reason: "Databases in your Library can't be read: this machine has no sqlite3 (/usr/bin/sqlite3)." });
  expect(lines).toEqual(["shell sandbox: ready", "shell sandbox: ready, no /usr/bin/sqlite3 (database reads will fail)"]);
});

const CAPS = `${SCOPE_LIMITS.memoryMaxBytes}\n0\n${SCOPE_LIMITS.tasksMax}`;
const sandboxHost = (works: () => boolean, runs: string[]): SandboxHost => ({
  platform: "linux",
  arch: "x64",
  exists: () => true,
  run: async (_command, args) => {
    if (!args.includes("/usr/bin/true")) return { code: 0, output: CAPS };
    runs.push("sandbox");
    return works() ? { code: 0, output: "" } : { code: 1, output: "bwrap: no permissions to create new namespace" };
  },
});

it("asks the sandbox again only after a failed check has stood a while, and never again once it passed", async () => {
  let now = 0;
  let works = false;
  const runs: string[] = [];
  const status = createShellStatus(createProbe(sandboxHost(() => works, runs), () => now), () => undefined);
  expect(await status()).toMatchObject({ state: "off" });
  works = true;
  expect(await status()).toMatchObject({ state: "off" });
  expect(runs).toHaveLength(1);
  now += PROBE_RETRY_MS;
  expect(await status()).toEqual({ state: "ready" });
  expect(runs).toHaveLength(2);
  works = false;
  now += 10 * PROBE_RETRY_MS;
  expect(await status()).toEqual({ state: "ready" });
  now += PROBE_RETRY_MS;
  expect(await status()).toEqual({ state: "ready" });
  expect(runs).toHaveLength(2);
});

it("on Windows Run commands is off as Linux only, and the probe runs no command", async () => {
  const runs: string[] = [];
  const windows: SandboxHost = { ...sandboxHost(() => true, runs), platform: "win32", run: async (command) => { runs.push(command); return { code: 0, output: "" }; } };
  const status = createShellStatus(createProbe(windows), () => undefined);
  expect(await status()).toEqual({ state: "off", word: "Linux only", reason: "The shell tool runs only on Linux." });
  expect(runs).toEqual([]);
});

it("asking for the status again with nothing changed logs the probe once, and logs again when it changes", async () => {
  const lines: string[] = [];
  let probe: SandboxProbe = { available: false, word: "Off", reason: "The sandbox could not start.", detail: "bwrap: no permissions to create new namespace" };
  const status = createShellStatus(async () => probe, (l) => lines.push(l));
  await status();
  await status();
  await status();
  expect(lines).toEqual(["shell sandbox: off, The sandbox could not start. (bwrap: no permissions to create new namespace)"]);
  probe = { available: true, arch: "x64", sqlite: true };
  await status();
  await status();
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("shell sandbox: ready");
});

it("when Run commands is off the probe's own words go to the log and never into the status the screen shows", async () => {
  const lines: string[] = [];
  const detail = "Failed to start transient scope unit: Access denied";
  const status = await createShellStatus(async () => ({ available: false, word: "Off", reason: "The sandbox could not start.", detail }), (l) => lines.push(l))();
  expect(status).toEqual({ state: "off", word: "Off", reason: "The sandbox could not start." });
  expect(JSON.stringify(status)).not.toContain(detail);
  expect(lines.join("\n")).toContain(detail);
});

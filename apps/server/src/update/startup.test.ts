import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acknowledgeStartup, readStartupAck, reportStartupFailure, waitForStartup } from "./startup.ts";
import { readTransaction, saveTransaction } from "./transaction.ts";
import { type Repos, makeRepos, removeRepos, testEnv, commit, publish, head, git } from "./testing.ts";
import { takeRecord } from "./record.ts";
import { runUpdate } from "./apply.ts";
import { fakePnpm } from "./testing.ts";
import { BUILD_DESKTOP_ARGS, BUILD_WEB_ARGS, INSTALL_ARGS } from "./apply.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

let repos: Repos;
beforeEach(() => { repos = makeRepos(); for (const [key, value] of Object.entries(testEnv(repos.base))) vi.stubEnv(key, value); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); removeRepos(repos); });

function launchTransaction() {
  const from = { commit: head(repos.clone), label: "old" };
  const to = { commit: commit(repos.seed, "New app"), label: "new" };
  publish(repos.seed); git(repos.clone, "pull", "--ff-only");
  const transaction = { channel: "main" as const, branch: "main", from, to, changes: 1, phase: "launch" as const, startupToken: "this-start" };
  saveTransaction(repos.clone, transaction);
  return transaction;
}

it("AW-02 a later updater cannot reset a saved Windows startup whose root vanished", async () => {
  const transaction = launchTransaction();
  saveTransaction(repos.clone, { ...transaction, running: { pid: 99999999, start: "owned-start", uptime: 0 } });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const fake = fakePnpm();
    const result = await runUpdate({ root: repos.clone, runner: fake.runner, choice: "main", pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined });
    expect(result).toMatchObject({ outcome: "refused", refusal: { reason: "still-running", pid: 99999999 } });
    expect(head(repos.clone)).toBe(transaction.to.commit);
    expect(fake.calls.map(call => call.args)).toEqual([["--version"]]);
    expect(readTransaction(repos.clone)?.phase).toBe("launch");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

it.each(["previous", "newer"])("AW-05 hand-moved HEAD at %s repairs the install before clearing the Windows launch", async repair => {
  const transaction = launchTransaction();
  const repaired = repair === "newer" ? commit(repos.clone, "Manual repair moves beyond the failed target") : transaction.from.commit;
  if (repair === "previous") {
    git(repos.clone, "reset", "--keep", repaired);
    git(repos.origin, "update-ref", "refs/heads/main", repaired);
  }
  saveTransaction(repos.clone, { ...transaction, running: { pid: 99999999, start: "owned-start", uptime: 0 } });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const fake = fakePnpm();
    const result = await runUpdate({ root: repos.clone, runner: fake.runner, choice: "main", pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined, startApp: async ({ token }) => {
      acknowledgeStartup(repos.clone, repos.data, token);
      return { code: 0, stdout: "", stderr: "" };
    } });
    expect(readTransaction(repos.clone)).toBeNull();
    expect(head(repos.clone)).toBe(repaired);
    expect(result).toMatchObject({ outcome: "updated", from: { commit: repaired }, to: { commit: repaired }, changes: 0 });
    expect(fake.calls.map(call => call.args)).toEqual([["--version"], INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS]);
    expect(fake.calls.every(call => call.head === repaired)).toBe(true);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

it("AW-04 unusable boot evidence preserves the unfinished transaction without claiming a restart", () => {
  const transaction = launchTransaction();
  saveTransaction(repos.clone, { ...transaction, running: { pid: 4242, start: "owned", uptime: 1000, boot: "not-a-boot-time" } });
  expect(readTransaction(repos.clone)).toEqual({ ...transaction, running: { pid: 4242, start: "owned", uptime: 1000 } });
});

it.runIf(process.platform === "linux")("AW-04 a later Windows boot releases real transaction recovery after uptime has passed", async () => {
  const transaction = launchTransaction();
  saveTransaction(repos.clone, { ...transaction, running: { pid: 99999999, start: "owned-start", uptime: 0, boot: "133000000000000000" } });
  const bin = path.join(repos.base, "fake-bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "powershell.exe"), `#!${process.execPath}\nprocess.stdout.write(process.argv.at(-1).includes("LastBootUpTime") ? "133000100000000000" : "owned-start");\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const fake = fakePnpm();
    const result = await runUpdate({ root: repos.clone, runner: fake.runner, choice: "main", pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined });
    expect(result).toMatchObject({ outcome: "stopped", step: "start" });
    expect(head(repos.clone)).toBe(transaction.from.commit);
    expect(readTransaction(repos.clone)).toBeNull();
    expect(fake.calls.map(call => call.args[0])).toEqual(["--version", "install", "--filter", "--filter"]);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

it("AV-04 only the expected ready server clears the launch transaction and records success", () => {
  const transaction = launchTransaction();
  expect(acknowledgeStartup(repos.clone, repos.data, "previous-start")).toBe(false);
  expect(readTransaction(repos.clone)).toEqual(transaction);
  expect(acknowledgeStartup(repos.clone, repos.data, "this-start")).toBe(true);
  expect(readTransaction(repos.clone)).toBeNull();
  expect(readStartupAck(repos.data, "this-start", transaction.to.commit)?.state).toBe("ready");
  expect(takeRecord(repos.data)).toMatchObject({ outcome: "updated", to: transaction.to });
});

it("AV-04 startup timeout stops its owned app once and retains the transaction for rollback", async () => {
  const transaction = launchTransaction();
  vi.useFakeTimers();
  const stop = vi.fn(async () => true);
  const pending = waitForStartup({ root: repos.clone, dataDir: repos.data, token: "this-start", commit: transaction.to.commit, app: { pid: process.pid, stop }, timeoutMs: 200, alive: () => true });
  await vi.advanceTimersByTimeAsync(200);
  expect(await pending).toMatchObject({ code: 1, stderr: expect.stringContaining("timed out") });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(readTransaction(repos.clone)?.phase).toBe("launch");
});

it("AV-04 an initialization failure cannot permit reset while the app tree is still alive", async () => {
  const transaction = launchTransaction();
  reportStartupFailure(repos.clone, repos.data, "this-start", "Initialization crashed");
  const stop = vi.fn(async () => false);
  expect(await waitForStartup({ root: repos.clone, dataDir: repos.data, token: "this-start", commit: transaction.to.commit, app: { pid: process.pid, stop }, alive: () => true })).toMatchObject({ code: 1, treeStillRunning: true, stderr: "Initialization crashed" });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(readTransaction(repos.clone)?.phase).toBe("launch");
});

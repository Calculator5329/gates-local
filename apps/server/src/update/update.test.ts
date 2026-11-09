// The updater against real git repositories built in a temporary folder
// (testing.ts), with a fake pnpm. Nothing here runs outside that folder: the
// guard refuses it, and the last tests prove the guard does.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_DESKTOP_ARGS, BUILD_WEB_ARGS, INSTALL_ARGS, runUpdate } from "./apply.ts";
import { runCli, type Relaunch } from "./cli.ts";
import { acknowledgeStartup } from "./startup.ts";
import { UpdateGuardError } from "./guard.ts";
import { RECORD_FILE } from "./record.ts";
import { createRunner, endTree, groupExists, realRunner, type Runner } from "./run.ts";
import { type Repos, commit, fakePnpm, git, head, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";
import { TRANSACTION_FILE, readTransaction } from "./transaction.ts";

let r: Repos;
const survivors = new Set<number>();

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});

afterEach(() => {
  for (const pid of survivors) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  survivors.clear();
  vi.unstubAllEnvs();
  removeRepos(r);
});

const isPnpm = (args: readonly string[], want: readonly string[]) => args.join(" ") === want.join(" ");

async function cli(argv: string[], fake = fakePnpm(), handoff: { approvalBeforeUptime?: number; uptime?: () => number } = {}) {
  const lines: string[] = [];
  const relaunch = vi.fn((spec: Relaunch) => {
    spec.onStart?.(process.pid);
    if (spec.startup) acknowledgeStartup(r.clone, r.data, spec.startup.token);
    return { pid: process.pid, stop: async () => true };
  });
  const code = await runCli({
    root: r.clone,
    argv: ["--data-dir", r.data, ...argv],
    defaultDataDir: r.data,
    pnpm: fake.pnpm,
    runner: fake.runner,
    appRunning: () => null,
    relaunch,
    print: (line) => lines.push(line),
    now: () => 1_762_500_000_000,
    platform: "linux",
    ...handoff,
  });
  return { code, lines, text: lines.join("\n"), relaunch, fake };
}

const update = (fake = fakePnpm(), choice: "auto" | "main" | "release" = "auto") =>
  runUpdate({ root: r.clone, runner: fake.runner, choice, pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined, startApp: async ({ token }) => {
    acknowledgeStartup(r.clone, r.data, token);
    return { code: 0, stdout: "", stderr: "" };
  } });

const record = () => JSON.parse(readFileSync(path.join(r.data, RECORD_FILE), "utf8")) as Record<string, unknown>;

describe("checking and updating", () => {
  it("AV-01 an updater whose handoff expired cannot install after admission reopened", async () => {
    const before = head(r.clone);
    const approved = commit(r.seed, "Approved before the desktop stalled"); publish(r.seed);
    const run = await cli(["--wait-pid", "99999999", "--restart", "--target-commit", approved], fakePnpm(), { approvalBeforeUptime: 1, uptime: () => 2 });
    expect(run.code).toBe(1);
    expect(head(r.clone)).toBe(before);
    expect(run.fake.calls).toEqual([]);
    expect(run.relaunch).not.toHaveBeenCalled();
    expect(existsSync(path.join(r.data, RECORD_FILE))).toBe(false);
  });
  it("AV-04 a successful launcher alone cannot finish an unacknowledged transaction", async () => {
    const before = head(r.clone); commit(r.seed, "Builds without a ready acknowledgement"); publish(r.seed);
    const fake = fakePnpm();
    const options = { root: r.clone, runner: fake.runner, choice: "main" as const, pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined, startApp: async () => ({ code: 0, stdout: "", stderr: "" }) };
    expect(await runUpdate(options)).toMatchObject({ outcome: "stopped", step: "start" });
    expect(head(r.clone)).toBe(before);
  });
  it.each(["initialization crashed", "startup timed out"])("AV-04 rolls back a build that never reaches server readiness: %s", async reason => {
    const before = head(r.clone);
    commit(r.seed, "Builds but cannot start"); publish(r.seed);
    const fake = fakePnpm();
    const startApp = vi.fn(async () => ({ code: 1, stdout: "", stderr: reason }));
    const options = { root: r.clone, runner: fake.runner, choice: "main" as const, pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined, startApp };
    expect(await runUpdate(options)).toMatchObject({ outcome: "stopped", step: "start", reason });
    expect(head(r.clone)).toBe(before);
    expect(startApp).toHaveBeenCalledTimes(1);
    expect(readTransaction(r.clone)).toBeNull();
  });
  it("AU-02 refuses a remote commit that was not the approved full target", async () => {
    const before = head(r.clone);
    const approvedCommit = commit(r.seed, "Approved B");
    const newer = commit(r.seed, "Unapproved C");
    publish(r.seed);
    const fake = fakePnpm();
    const options = { root: r.clone, runner: fake.runner, choice: "main" as const, pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined, approvedCommit };
    expect(await runUpdate(options)).toMatchObject({ outcome: "refused", refusal: { reason: "target-changed", target: { commit: newer } } });
    expect(head(r.clone)).toBe(before);
    expect(fake.calls.filter((call) => call.args[0] === "install")).toHaveLength(0);
  });

  it("AU-02 installs exactly the approved commit through the detached CLI option", async () => {
    const approved = commit(r.seed, "Approved B");
    publish(r.seed);
    const run = await cli(["--target-commit", approved]);
    expect(run.code).toBe(0);
    expect(head(r.clone)).toBe(approved);
    expect(record()).toMatchObject({ outcome: "updated", to: { commit: approved } });
  });

  it("AU-02 the detached CLI refuses a changed target and reopens the old app", async () => {
    const before = head(r.clone);
    const approved = commit(r.seed, "Approved B");
    commit(r.seed, "Unapproved C");
    publish(r.seed);
    const run = await cli(["--wait-pid", "99999999", "--restart", "--target-commit", approved]);
    expect(run.code).toBe(1);
    expect(head(r.clone)).toBe(before);
    expect(record()).toMatchObject({ outcome: "refused", reason: expect.stringContaining("target changed") });
    expect(run.relaunch).toHaveBeenCalledTimes(1);
  });

  it("says up to date when the clone has the newest commit, and runs no install or build", async () => {
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(run.text).toContain("Gates Local is up to date");
    expect(run.fake.calls.map((c) => c.args.join(" "))).toEqual(["--version"]);
  });

  it("lists the changes it would bring, newest first, and changes nothing with --check", async () => {
    const before = head(r.clone);
    commit(r.seed, "Add the updates group");
    commit(r.seed, "Fix the picker");
    publish(r.seed);
    const run = await cli(["--check"]);
    expect(run.code).toBe(0);
    expect(run.text).toMatch(/2 changes from \w+ to \w+:\n {2}- Fix the picker\n {2}- Add the updates group/);
    expect(head(r.clone)).toBe(before);
    expect(run.fake.calls).toEqual([]);
  });

  it("lists at most 20 subjects and counts the rest", async () => {
    for (let i = 1; i <= 23; i++) commit(r.seed, `Change ${i}`);
    publish(r.seed);
    const run = await cli(["--check"]);
    expect(run.text).toContain("23 changes from");
    expect(run.text).toContain("  - Change 23");
    expect(run.text).toContain("  - Change 4");
    expect(run.text).not.toContain("  - Change 3\n");
    expect(run.text).toContain("  …and 3 more");
  });

  it("fast-forwards, then installs and builds both apps on the new commit, and writes the result", async () => {
    const target = commit(r.seed, "Add the updates group");
    publish(r.seed);
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(head(r.clone)).toBe(target);
    expect(run.fake.calls.slice(1)).toEqual([
      { args: INSTALL_ARGS, head: target },
      { args: BUILD_WEB_ARGS, head: target },
      { args: BUILD_DESKTOP_ARGS, head: target },
    ]);
    expect(run.text).toMatch(/Updated to \w+, 1 change\./);
    expect(record()).toMatchObject({ outcome: "updated", channel: "main", changes: 1, to: { commit: target } });
  });

  it("refuses tracked changes, names the files, and leaves HEAD and the files alone", async () => {
    commit(r.seed, "Upstream change");
    publish(r.seed);
    const before = head(r.clone);
    writeFileSync(path.join(r.clone, "app.txt"), "my own edit\n");
    const run = await cli([]);
    expect(run.code).toBe(1);
    expect(run.text).toContain("These files have changes that are not saved in git:\n  app.txt\nNothing was changed.");
    expect(run.text).toContain("git stash");
    expect(head(r.clone)).toBe(before);
    expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("my own edit\n");
    expect(run.fake.calls.map((c) => c.args.join(" "))).toEqual(["--version"]);
  });

  it("updates past untracked and ignored files and keeps them", async () => {
    const target = commit(r.seed, "Upstream change");
    publish(r.seed);
    writeFileSync(path.join(r.clone, "notes.txt"), "mine\n");
    mkdirSync(path.join(r.clone, "ignored"));
    writeFileSync(path.join(r.clone, "ignored", "cache"), "x\n");
    expect((await update()).outcome).toBe("updated");
    expect(head(r.clone)).toBe(target);
    expect(readFileSync(path.join(r.clone, "notes.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(path.join(r.clone, "ignored", "cache"))).toBe(true);
  });

  it("refuses a clone with commits of its own and changes nothing", async () => {
    commit(r.seed, "Upstream change");
    publish(r.seed);
    const mine = commit(r.clone, "My own commit");
    const run = await cli([]);
    expect(run.code).toBe(1);
    expect(run.text).toContain("This copy has a commit of its own that the update does not have:\n  - My own commit");
    expect(run.text).toContain("Nothing was changed");
    expect(head(r.clone)).toBe(mine);
  });
});

describe("a failed step goes back to the old commit", () => {
  it("install fails: back on the old commit, installed and built again there", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Breaks the install");
    publish(r.seed);
    // Only the install on the new commit fails.
    const fake = fakePnpm((args, n) => isPnpm(args, INSTALL_ARGS) && n === 2);
    const run = await cli([], fake);
    expect(run.code).toBe(1);
    expect(head(r.clone)).toBe(old);
    expect(fake.calls.slice(1)).toEqual([
      { args: INSTALL_ARGS, head: target },
      { args: INSTALL_ARGS, head: old },
      { args: BUILD_WEB_ARGS, head: old },
      { args: BUILD_DESKTOP_ARGS, head: old },
    ]);
    expect(run.text).toMatch(/The update to \w+ stopped at installing packages: ERR_PNPM_TEST the fake pnpm failed here\. Gates Local is still on \w+\./);
    expect(record()).toMatchObject({ outcome: "stopped", step: "install", from: { commit: old }, to: { commit: target } });
    expect(String(record()["logPath"])).toContain(path.join(r.data, "update-logs"));
  });

  it("build fails: back on the old commit, installed and built again there", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Breaks the desktop build");
    publish(r.seed);
    const fake = fakePnpm((args, n) => isPnpm(args, BUILD_DESKTOP_ARGS) && n === 4);
    const run = await cli([], fake);
    expect(run.code).toBe(1);
    expect(head(r.clone)).toBe(old);
    expect(fake.calls.slice(1).map((c) => [c.args, c.head])).toEqual([
      [INSTALL_ARGS, target],
      [BUILD_WEB_ARGS, target],
      [BUILD_DESKTOP_ARGS, target],
      [INSTALL_ARGS, old],
      [BUILD_WEB_ARGS, old],
      [BUILD_DESKTOP_ARGS, old],
    ]);
    expect(run.text).toContain("stopped at building the desktop app");
  });

  it("when going back fails too, prints the exact commands that finish it", async () => {
    const old = head(r.clone);
    commit(r.seed, "Breaks every install");
    publish(r.seed);
    const run = await cli([], fakePnpm((args) => isPnpm(args, INSTALL_ARGS)));
    expect(run.code).toBe(1);
    expect(run.text).toContain(`  git reset --keep ${old}\n  pnpm install --frozen-lockfile --config.confirmModulesPurge=false\n  pnpm --filter @gates-local/web build\n  pnpm --filter @gates-local/desktop build`);
    expect(record()).toMatchObject({ outcome: "rollback-failed" });
  });
});

describe("channels", () => {
  it("follows main while the remote has no release tag", async () => {
    const target = commit(r.seed, "Newest on main");
    publish(r.seed);
    const run = await update();
    expect(run).toMatchObject({ outcome: "updated", channel: "main" });
    expect(head(r.clone)).toBe(target);
  });

  it("follows releases once the remote has a v* tag, and stops at the tag, not main", async () => {
    const tagged = commit(r.seed, "Release one");
    git(r.seed, "tag", "-a", "v0.1.0", "-m", "First release\n\nThe updates group.");
    commit(r.seed, "After the release");
    publish(r.seed);
    const run = await cli(["--check"]);
    expect(run.text).toContain("to v0.1.0:\n  First release");
    expect(run.text).toContain("Following releases.");
    expect(await update()).toMatchObject({ outcome: "updated", channel: "release", to: { label: "v0.1.0" } });
    expect(head(r.clone)).toBe(tagged);
  });

  it("orders releases by version, so v0.10.0 comes after v0.9.0", async () => {
    const ten = commit(r.seed, "Ten");
    git(r.seed, "tag", "v0.10.0");
    commit(r.seed, "Later commit");
    // Tagged last and sorting after v0.10.0 as text: a text or date order would pick it.
    git(r.seed, "tag", "v0.9.0", ten);
    publish(r.seed);
    expect(await update()).toMatchObject({ outcome: "updated", to: { label: "v0.10.0", commit: ten } });
  });

  it("never goes backwards: a copy past the newest release is up to date", async () => {
    commit(r.seed, "Release");
    git(r.seed, "tag", "v0.1.0");
    const newer = commit(r.seed, "Past the release");
    publish(r.seed);
    git(r.clone, "pull", "--quiet", "--ff-only");
    expect(head(r.clone)).toBe(newer);
    const run = await update();
    expect(run.outcome).toBe("up-to-date");
    expect(head(r.clone)).toBe(newer);
  });

  it("main pinned in Settings ignores the tags", async () => {
    commit(r.seed, "Release");
    git(r.seed, "tag", "v0.1.0");
    const newest = commit(r.seed, "Newest on main");
    publish(r.seed);
    writeFileSync(path.join(r.data, "settings.json"), JSON.stringify({ version: 1, settings: { updateEveryChange: true } }));
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(head(r.clone)).toBe(newest);
    expect(record()).toMatchObject({ outcome: "updated", channel: "main" });
  });

  it("--channel main overrides releases too", async () => {
    commit(r.seed, "Release");
    git(r.seed, "tag", "v0.1.0");
    const newest = commit(r.seed, "Newest on main");
    publish(r.seed);
    await cli(["--channel", "main"]);
    expect(head(r.clone)).toBe(newest);
  });
});

/** A commit in the seed that starts tracking ignored/private.txt; the clone has its own file there. */
function collidingCommit(): void {
  mkdirSync(path.join(r.seed, "ignored"));
  writeFileSync(path.join(r.seed, "ignored", "private.txt"), "upstream content\n");
  git(r.seed, "add", "-f", "ignored/private.txt");
  git(r.seed, "commit", "--quiet", "-m", "Start tracking a file");
  publish(r.seed);
  mkdirSync(path.join(r.clone, "ignored"));
  writeFileSync(path.join(r.clone, "ignored", "private.txt"), "the person's own content\n");
}

describe("a file of the person's where the new version puts one", () => {
  it("leaves an ignored file alone, says so in a sentence, and changes nothing", async () => {
    const before = head(r.clone);
    collidingCommit();
    const run = await cli([]);
    expect(run.code).toBe(1);
    expect(readFileSync(path.join(r.clone, "ignored", "private.txt"), "utf8")).toBe("the person's own content\n");
    expect(head(r.clone)).toBe(before);
    expect(run.fake.calls.map((c) => c.args.join(" "))).toEqual(["--version"]);
    expect(run.text).toMatch(/stopped at switching to the new version: your own file ignored\/private\.txt is where the new version puts a file of the same name\. It was left as it was; move or rename it and try again\. Gates Local is still on \w+\./);
    expect(run.text).not.toMatch(/error:|Aborting|overwritten/);
    expect(record()).toMatchObject({ outcome: "stopped", step: "switch", from: { commit: before } });
  });

  it("updates once the file has been moved", async () => {
    collidingCommit();
    await cli([]);
    rmSync(path.join(r.clone, "ignored", "private.txt"));
    const target = head(r.seed);
    expect((await cli([])).code).toBe(0);
    expect(head(r.clone)).toBe(target);
  });

  it("names several files in one sentence, and an untracked one the same way", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      writeFileSync(path.join(r.seed, name), "upstream\n");
      writeFileSync(path.join(r.clone, name), "mine\n");
    }
    git(r.seed, "add", ".");
    git(r.seed, "commit", "--quiet", "-m", "Add four files");
    publish(r.seed);
    const run = await cli([]);
    expect(run.text).toContain("your own files a.txt, b.txt, c.txt and 1 more are where the new version puts files of the same name. They were left as they were; move or rename them and try again.");
    expect(readFileSync(path.join(r.clone, "d.txt"), "utf8")).toBe("mine\n");
  });
});

/** A runner that stops at the first merge until released. */
function pausedAtMerge(fake: ReturnType<typeof fakePnpm>) {
  let reached!: () => void;
  let release!: () => void;
  const atMerge = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runner: Runner = async (command, args, options) => {
    if (command === "git" && args[0] === "merge") {
      reached();
      await gate;
    }
    return fake.runner(command, args, options);
  };
  return { fake: { ...fake, runner }, atMerge, release };
}

describe("one update of a checkout at a time", () => {
  it("refuses a second update while the first is paused, and the first one finishes", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const a = pausedAtMerge(fakePnpm());
    const first = update(a.fake);
    await a.atMerge;
    const b = fakePnpm();
    const run = await cli([], b);
    expect(run.code).toBe(1);
    expect(run.text).toContain(`Another update of this copy is already running (process ${process.pid}).`);
    expect(run.text).toContain("Nothing was changed. Wait for it to finish, or end that process, then try again.");
    expect(run.text).toContain(path.join(r.clone, ".git", "gates-local-update.lock"));
    expect(b.commands).toEqual([]);
    expect(run.relaunch).not.toHaveBeenCalled();
    expect(head(r.clone)).toBe(old);
    a.release();
    expect(await first).toMatchObject({ outcome: "updated", to: { commit: target } });
    expect(head(r.clone)).toBe(target);
  });

  it("a loser never rolls back the winner: two started together, one update", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    // Every install fails for the loser, were it to get that far.
    const winner = fakePnpm();
    const loser = fakePnpm((args) => isPnpm(args, INSTALL_ARGS));
    const runs = await Promise.all([update(winner), update(loser)]);
    expect(runs.map((x) => x.outcome)).toEqual(["updated", "refused"]);
    expect(loser.commands).toEqual([]);
    expect(head(r.clone)).toBe(target);
  });

  it("lets the next update run once the first has finished", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    expect((await update()).outcome).toBe("updated");
    const next = commit(r.seed, "Newer still");
    publish(r.seed);
    expect((await update()).outcome).toBe("updated");
    expect(head(r.clone)).toBe(next);
  });

  it("--check says an update is running instead of reading a checkout in the middle of one", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const a = pausedAtMerge(fakePnpm());
    const first = update(a.fake);
    await a.atMerge;
    const run = await cli(["--check"]);
    expect(run.code).toBe(1);
    expect(run.text).toContain("Another update of this copy is already running");
    a.release();
    await first;
  });

  it("releases the checkout when the run throws", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), (c, a) => c === "git" && a[0] === "fetch"))).rejects.toThrow("the power went out");
    expect((await update()).outcome).toBe("updated");
  });
});

/** A runner that throws at the first matching command, the way a crash ends a run there. */
function crashing(fake: ReturnType<typeof fakePnpm>, when: (command: string, args: readonly string[]) => boolean) {
  let crashed = false;
  const runner: Runner = async (command, args, options) => {
    if (!crashed && when(command, args)) {
      crashed = true;
      throw new Error("the power went out");
    }
    return fake.runner(command, args, options);
  };
  return { ...fake, runner };
}

const isCommand = (want: readonly string[]) => (command: string, args: readonly string[]) => command === "fake-pnpm" && isPnpm(args, want);

describe("an update that was cut off", () => {
  it("finishes the install and builds after a crash that followed the switch, instead of saying up to date", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    expect(head(r.clone)).toBe(target);
    const run = await cli([]);
    expect(run.text).not.toContain("up to date");
    expect(run.code).toBe(0);
    expect(run.fake.calls.slice(1)).toEqual([
      { args: INSTALL_ARGS, head: target },
      { args: BUILD_WEB_ARGS, head: target },
      { args: BUILD_DESKTOP_ARGS, head: target },
    ]);
    expect(record()).toMatchObject({ outcome: "updated", from: { commit: old }, to: { commit: target }, changes: 1 });
    // Finished: the next run has nothing left to do.
    const again = await cli([]);
    expect(again.text).toContain("is up to date");
    expect(again.fake.calls.map((c) => c.args.join(" "))).toEqual(["--version"]);
  });

  it("--check says the update did not finish and runs nothing", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(BUILD_WEB_ARGS)))).rejects.toThrow("the power went out");
    const run = await cli(["--check"]);
    expect(run.code).toBe(1);
    expect(run.text).toContain("did not finish");
    expect(run.text).not.toContain("up to date");
    expect(run.fake.calls).toEqual([]);
  });

  it("goes back when finishing fails", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    const fake = fakePnpm((args, n) => isPnpm(args, BUILD_WEB_ARGS) && n === 3);
    const run = await cli([], fake);
    expect(run.code).toBe(1);
    expect(head(r.clone)).toBe(old);
    expect(fake.calls.slice(1).map((c) => [c.args, c.head])).toEqual([
      [INSTALL_ARGS, target],
      [BUILD_WEB_ARGS, target],
      [INSTALL_ARGS, old],
      [BUILD_WEB_ARGS, old],
      [BUILD_DESKTOP_ARGS, old],
    ]);
  });

  it("starts over when the crash came before the switch", async () => {
    const old = head(r.clone);
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), (c, a) => c === "git" && a[0] === "merge"))).rejects.toThrow("the power went out");
    expect(head(r.clone)).toBe(old);
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(head(r.clone)).toBe(target);
  });

  it("finishes going back after a crash that followed the reset", async () => {
    const old = head(r.clone);
    commit(r.seed, "Breaks the install");
    publish(r.seed);
    // The install on the new commit fails; the one going back is where the power goes.
    let installs = 0;
    const failing = fakePnpm((args) => isPnpm(args, INSTALL_ARGS) && installs === 1);
    const crash = crashing(failing, (c, a) => c === "fake-pnpm" && isPnpm(a, INSTALL_ARGS) && ++installs === 2);
    await expect(update(crash)).rejects.toThrow("the power went out");
    expect(head(r.clone)).toBe(old);
    const run = await cli([]);
    expect(run.code).toBe(1);
    expect(run.fake.calls.slice(1)).toEqual([
      { args: INSTALL_ARGS, head: old },
      { args: BUILD_WEB_ARGS, head: old },
      { args: BUILD_DESKTOP_ARGS, head: old },
    ]);
    expect(run.text).toMatch(/stopped at installing packages: ERR_PNPM_TEST the fake pnpm failed here\. Gates Local is still on \w+\./);
    // Back and finished: the next run tries the update again from the top.
    expect((await update()).outcome).toBe("updated");
  });

  it("after a rollback that failed, the next run takes it up again", async () => {
    const old = head(r.clone);
    commit(r.seed, "Breaks the install");
    publish(r.seed);
    expect((await update(fakePnpm((args) => isPnpm(args, INSTALL_ARGS)))).outcome).toBe("rollback-failed");
    expect(head(r.clone)).toBe(old);
    const run = await cli([]);
    expect(run.text).not.toContain("up to date");
    expect(run.fake.calls.slice(1).map((c) => c.head)).toEqual([old, old, old]);
  });

  it("AW-05 reinstalls and builds a clone pulled by hand after a crash without moving its commit", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    const newest = commit(r.seed, "Newer still");
    publish(r.seed);
    git(r.clone, "pull", "--quiet", "--ff-only");
    expect(head(r.clone)).toBe(newest);
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(run.text).toContain("Repaired");
    expect(head(r.clone)).toBe(newest);
    expect(run.fake.calls.map(c => c.args)).toEqual([["--version"], INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS]);
    expect(run.fake.calls.every(c => c.head === newest)).toBe(true);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("AW-05 a failed repair keeps the hand-moved commit and gives commands for that commit", async () => {
    commit(r.seed, "Newer"); publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    const repaired = commit(r.clone, "Chosen manual repair");
    const fake = fakePnpm(args => isPnpm(args, INSTALL_ARGS));
    const run = await cli([], fake);
    expect(run.code).toBe(1);
    expect(record()).toMatchObject({ outcome: "rollback-failed", from: { commit: repaired }, to: { commit: repaired } });
    expect(head(r.clone)).toBe(repaired);
    expect(resets(fake)).toEqual([`git reset --keep ${repaired}`]);
    expect(fake.calls.map(c => c.args)).toEqual([["--version"], INSTALL_ARGS, INSTALL_ARGS]);
    expect(readTransaction(r.clone)).toMatchObject({ phase: "back", from: { commit: repaired }, to: { commit: repaired } });
    expect(run.text).toContain("Repairing");
    expect(run.text).toContain("Retrying the repair did not finish either");
    expect(run.text).not.toContain("Going back");
    for (const words of [`git reset --keep ${repaired}`, ...[INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS].map(args => `pnpm ${args.join(" ")}`)]) expect(run.text).toContain(words);
    const retry = await cli([]);
    expect(retry.code).toBe(1);
    expect(retry.text).toContain("The repair of");
    expect(retry.text).not.toContain("Going back");
    expect(readTransaction(r.clone)).toBeNull();
    expect(head(r.clone)).toBe(repaired);
  });

  it("AW-05 a repair interrupted during its builds runs install and both builds again", async () => {
    commit(r.seed, "Newer"); publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    const repaired = commit(r.clone, "Chosen manual repair");
    await expect(update(crashing(fakePnpm(), isCommand(BUILD_WEB_ARGS)))).rejects.toThrow("the power went out");
    expect(readTransaction(r.clone)).toMatchObject({ phase: "forward", from: { commit: repaired }, to: { commit: repaired } });
    const run = await cli([]);
    expect(run.code).toBe(0);
    expect(run.text).toContain("Repaired");
    expect(run.fake.calls.map(call => call.args)).toEqual([["--version"], INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS]);
    expect(head(r.clone)).toBe(repaired);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("leaves another branch alone: it was switched to by hand after the crash", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    git(r.clone, "switch", "--quiet", "-c", "mine");
    const run = await cli([]);
    expect(run.fake.calls.map((c) => c.args.join(" "))).toEqual(["--version"]);
    expect(head(r.clone)).toBe(target);
  });

  it("refuses to pick it up over a tracked edit made since, and keeps the edit", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isCommand(INSTALL_ARGS)))).rejects.toThrow("the power went out");
    writeFileSync(path.join(r.clone, "app.txt"), "edited after the crash\n");
    const run = await cli([]);
    expect(run.code).toBe(1);
    expect(run.text).toContain("These files have changes that are not saved in git:\n  app.txt");
    expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("edited after the crash\n");
    expect(head(r.clone)).toBe(target);
    expect(run.fake.calls.map((c) => c.args.join(" "))).toEqual(["--version"]);
  });
});

/** A real process in its own group, standing in for a pnpm that outlived its time limit. */
function survivor(): number {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  survivors.add(child.pid!);
  return child.pid!;
}

async function endSurvivor(pid: number): Promise<void> {
  process.kill(-pid, "SIGKILL");
  survivors.delete(pid);
  await vi.waitFor(() => expect(groupExists(pid)).toBe(false), { timeout: 5000, interval: 25 });
}

/** The matching command starts and then cannot be stopped. */
function stuckAt(fake: ReturnType<typeof fakePnpm>, when: (command: string, args: readonly string[]) => boolean, pid: number) {
  const runner: Runner = async (command, args, options) => {
    if (!when(command, args)) return fake.runner(command, args, options);
    options.onStart?.(pid);
    return { code: null, stdout: "", stderr: "", failure: "timeout", treeStillRunning: true };
  };
  return { ...fake, runner };
}

const isMerge = (command: string, args: readonly string[]) => command === "git" && args[0] === "merge";
const pnpmWords = (fake: ReturnType<typeof fakePnpm>) => fake.calls.map((c) => c.args.join(" "));
const resets = (fake: ReturnType<typeof fakePnpm>) => fake.commands.filter((c) => c.startsWith("git reset"));

describe.skipIf(process.platform === "win32")("a step that would not stop", () => {
  it("AW-02 an exited Windows command retains its record and blocks a non-launch retry", async () => {
    commit(r.seed, "Newer"); publish(r.seed);
    const fake = fakePnpm();
    const taskkill = vi.fn(async () => 128);
    const windows = createRunner({ platform: "win32", exists: () => false, taskkill });
    let group: number | undefined;
    const runner: Runner = (command, args, options) => {
      if (!isCommand(INSTALL_ARGS)(command, args)) return fake.runner(command, args, options);
      return windows("sh", ["-c", "sleep 5 &"], { ...options, timeoutMs: 200, onStart: pid => { group = pid; options.onStart?.(pid); } });
    };
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      const first = await update({ ...fake, runner });
      expect(first).toMatchObject({ outcome: "refused", refusal: { reason: "still-running", pid: group } });
      expect(readTransaction(r.clone)).toMatchObject({ phase: "forward", running: { pid: group } });
      expect(taskkill).not.toHaveBeenCalled();
      Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
      const check = await cli(["--check"]);
      expect.soft(check.text).toContain("not been confirmed stopped");
      expect.soft(check.text).toContain("Restart");
      const retry = await update(fake);
      expect.soft(retry).toMatchObject({ outcome: "refused", refusal: { reason: "still-running", pid: group } });
      expect.soft(readTransaction(r.clone)).toMatchObject({ phase: "forward", running: { pid: group } });
      expect(fake.calls.map(call => call.args)).toEqual([["--version"], ["--version"]]);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      if (group !== undefined) await endTree(group);
    }
  });

  it("keeps refusing until its processes have ended, never goes back beside them and does not reopen the app", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    const fake = fakePnpm();
    const first = await cli(["--restart"], stuckAt(fake, isCommand(INSTALL_ARGS), pid));
    expect(first.code).toBe(1);
    expect(first.relaunch).not.toHaveBeenCalled();
    expect(first.text).toContain(`(process ${pid})`);
    expect(first.text).toContain("restart the computer");
    expect(first.text).toContain("git pull");
    expect(resets(fake)).toEqual([]);
    expect(readTransaction(r.clone)).toMatchObject({ phase: "forward", running: { pid } });

    const retry = await cli([]);
    expect(retry.code).toBe(1);
    expect(retry.text).toContain(`(process ${pid})`);
    expect(pnpmWords(retry.fake)).toEqual(["--version"]);
    expect(head(r.clone)).toBe(target);

    await endSurvivor(pid);
    const after = await cli([]);
    expect(after.code).toBe(0);
    expect(after.fake.calls.slice(1).map((c) => c.args)).toEqual([INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS]);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("the merge itself: nothing runs until it has ended", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    const run = await cli(["--restart"], stuckAt(fakePnpm(), isMerge, pid));
    expect(run.code).toBe(1);
    expect(run.relaunch).not.toHaveBeenCalled();
    expect(readTransaction(r.clone)).toMatchObject({ phase: "forward", running: { pid } });
    expect(head(r.clone)).toBe(old);
    expect((await cli(["--check"])).text).toContain("did not finish");
    await endSurvivor(pid);
  });

  it("an updater killed outright leaves its command's identity behind, so the next run waits for it", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => {
      if (!isCommand(INSTALL_ARGS)(command, args)) return fake.runner(command, args, options);
      options.onStart?.(pid);
      throw new Error("the power went out");
    };
    await expect(update({ ...fake, runner })).rejects.toThrow("the power went out");
    const next = await cli([]);
    expect(next.code).toBe(1);
    expect(next.text).toContain(`(process ${pid})`);
    expect(pnpmWords(next.fake)).toEqual(["--version"]);
    await endSurvivor(pid);
  });

  it("a finished step leaves no process in the saved state", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    const fake = fakePnpm();
    let during: ReturnType<typeof readTransaction> | undefined;
    let atBuild: ReturnType<typeof readTransaction> | undefined;
    const runner: Runner = async (command, args, options) => {
      if (isCommand(INSTALL_ARGS)(command, args)) {
        options.onStart?.(pid);
        during = readTransaction(r.clone);
      }
      if (isCommand(BUILD_WEB_ARGS)(command, args)) atBuild = readTransaction(r.clone);
      return fake.runner(command, args, options);
    };
    expect((await update({ ...fake, runner })).outcome).toBe("updated");
    expect(during).toMatchObject({ running: { pid } });
    expect(atBuild).not.toHaveProperty("running");
    await endSurvivor(pid);
  });

  it("--check names a process still running before it offers the manual path, and changes nothing", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => {
      if (!isCommand(INSTALL_ARGS)(command, args)) return fake.runner(command, args, options);
      options.onStart?.(pid);
      throw new Error("the power went out");
    };
    await expect(update({ ...fake, runner })).rejects.toThrow("the power went out");
    const saved = path.join(r.clone, ".git", TRANSACTION_FILE);
    const before = readFileSync(saved, "utf8");

    const check = await cli(["--check"]);
    expect(check.code).toBe(1);
    expect(check.text).toContain(`(process ${pid})`);
    expect(check.text).toContain("End that process");
    expect(check.text).toContain("Or by hand, once it has ended");
    expect(check.text.indexOf("End that process")).toBeLessThan(check.text.indexOf("git pull"));
    expect(readFileSync(saved, "utf8")).toBe(before);
    expect(pnpmWords(check.fake)).toEqual([]);
    expect(groupExists(pid)).toBe(true);

    await endSurvivor(pid);
    const after = await cli(["--check"]);
    expect(after.text).not.toContain(`(process ${pid})`);
    expect(after.text).toContain("Or by hand: close Gates Local");
  });
});

/** A real write error from here on, where the updater writes its saved state. */
const failSaves = () => mkdirSync(path.join(r.clone, ".git", `${TRANSACTION_FILE}.${process.pid}.tmp`));
const allowSaves = () => rmSync(path.join(r.clone, ".git", `${TRANSACTION_FILE}.${process.pid}.tmp`), { recursive: true });

describe("the saved state cannot be written", () => {
  it("does not start the merge, and leaves the copy where it was", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => {
      if (isCommand(["--version"])(command, args)) failSaves();
      return fake.runner(command, args, options);
    };
    const run = await update({ ...fake, runner });
    expect(run).toMatchObject({ outcome: "refused", refusal: { reason: "cannot-save", pid: null } });
    expect(fake.commands.filter((c) => c.startsWith("git merge "))).toEqual([]);
    expect(head(r.clone)).toBe(old);
    expect(readTransaction(r.clone)).toBeNull();
  });

  it("does not start the install, says why, and the next run finishes it", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => {
      const result = await fake.runner(command, args, options);
      if (isMerge(command, args)) failSaves();
      return result;
    };
    const run = await cli([], { ...fake, runner });
    expect(run.code).toBe(1);
    expect(run.text).toContain("EISDIR");
    expect(run.text).toContain("pnpm run app-update");
    expect(run.text).toContain("git pull");
    expect(pnpmWords(fake)).toEqual(["--version"]);
    expect(head(r.clone)).toBe(target);
    expect(readTransaction(r.clone)).toMatchObject({ phase: "forward" });

    allowSaves();
    const next = await cli([]);
    expect(next.code).toBe(0);
    expect(next.fake.calls.slice(1).map((c) => c.args)).toEqual([INSTALL_ARGS, BUILD_WEB_ARGS, BUILD_DESKTOP_ARGS]);
  });

  it.skipIf(process.platform === "win32")("ends a step at once when its process cannot be saved, and nothing runs after it", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const fake = fakePnpm();
    let started = 0;
    const runner: Runner = (command, args, options) => {
      if (!isCommand(INSTALL_ARGS)(command, args)) return fake.runner(command, args, options);
      // The save before the step worked; the one naming its process does not.
      failSaves();
      return realRunner("sleep", ["60"], {
        ...options,
        onStart: (pid) => {
          started = pid;
          survivors.add(pid);
          options.onStart?.(pid);
        },
      });
    };
    const run = await update({ ...fake, runner });
    expect(run).toMatchObject({ outcome: "refused", refusal: { reason: "cannot-save", pid: null } });
    expect(started).toBeGreaterThan(0);
    expect(groupExists(started)).toBe(false);
    expect(pnpmWords(fake)).toEqual(["--version"]);
  });

  it.skipIf(process.platform === "win32")("names a process it could neither save nor stop, and does not reopen the app", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    const fake = fakePnpm();
    const runner: Runner = async (command, args, options) => {
      if (!isCommand(INSTALL_ARGS)(command, args)) return fake.runner(command, args, options);
      failSaves();
      try {
        options.onStart?.(pid);
      } catch {
        // The real runner stops the command here and reports whether that worked.
      }
      return { code: null, stdout: "", stderr: "", failure: "spawn-error", treeStillRunning: true };
    };
    const run = await cli(["--restart"], { ...fake, runner });
    expect(run.code).toBe(1);
    expect(run.text).toContain(`(process ${pid})`);
    expect(run.text).toContain("restart the computer");
    expect(run.relaunch).not.toHaveBeenCalled();
    await endSurvivor(pid);
  });
});

/** The first install fails, after `change` has run: the person editing while it installed. */
function failsAfter(change: () => void) {
  const fake = fakePnpm((args, n) => isPnpm(args, INSTALL_ARGS) && n === 2);
  const runner: Runner = async (command, args, options) => {
    if (isCommand(INSTALL_ARGS)(command, args) && fake.calls.length === 1) change();
    return fake.runner(command, args, options);
  };
  return { ...fake, runner };
}

function unrelatedFile(): void {
  writeFileSync(path.join(r.seed, "other.txt"), "committed\n");
  git(r.seed, "add", "other.txt");
  git(r.seed, "commit", "--quiet", "-m", "Add a file the update does not touch");
  publish(r.seed);
  git(r.clone, "pull", "--quiet", "--ff-only");
}

const stageThenEdit = () => {
  writeFileSync(path.join(r.clone, "other.txt"), "staged\n");
  git(r.clone, "add", "other.txt");
  writeFileSync(path.join(r.clone, "other.txt"), "working\n");
};

const scripts = (file: string) => (JSON.parse(readFileSync(path.join(import.meta.dirname, "../../../..", file), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("the person changes the copy while it installs", () => {
  it("keeps a staged version and the working copy: no automatic reset, and the steps by hand", async () => {
    unrelatedFile();
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const fake = failsAfter(stageThenEdit);
    const run = await cli([], fake);
    expect(run.code).toBe(1);
    expect(resets(fake)).toEqual([]);
    expect(head(r.clone)).toBe(target);
    expect(git(r.clone, "show", ":other.txt")).toBe("staged");
    expect(readFileSync(path.join(r.clone, "other.txt"), "utf8")).toBe("working\n");
    expect(run.text).toContain("other.txt");
    expect(run.text).toContain("git pull");
    expect(readTransaction(r.clone)).not.toBeNull();
  });

  // After a commit of your own the updater finds nothing newer and says "up to date" without building, so it cannot be the advice.
  it.each([
    ["files", stageThenEdit],
    ["branch", () => git(r.clone, "switch", "--quiet", "-c", "mine")],
    ["commit", () => git(r.clone, "commit", "--quiet", "--allow-empty", "-m", "Mine")],
  ])("after a change to the %s, the advice installs and builds what is there", async (_kind, change) => {
    unrelatedFile();
    commit(r.seed, "Newer");
    publish(r.seed);
    const { text } = await cli([], failsAfter(change));
    expect(text).toContain("close Gates Local, then run `pnpm install`, then `pnpm start`");
    expect(text).not.toContain("then run `pnpm run app-update`");
    expect(scripts("package.json")["start"]).toContain("build");
    expect(scripts("apps/desktop/package.json")["start"]).toContain("build");
  });

  it("leaves a branch switched to during the install", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const fake = failsAfter(() => git(r.clone, "switch", "--quiet", "-c", "mine"));
    expect(await update(fake)).toMatchObject({ outcome: "refused", refusal: { reason: "changed-during-update", changed: "branch" } });
    expect(resets(fake)).toEqual([]);
    expect(git(r.clone, "symbolic-ref", "--short", "HEAD")).toBe("mine");
    expect(head(r.clone)).toBe(target);
  });

  it("leaves a commit made during the install", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    let mine = "";
    const fake = failsAfter(() => {
      git(r.clone, "commit", "--quiet", "--allow-empty", "-m", "Mine");
      mine = head(r.clone);
    });
    expect(await update(fake)).toMatchObject({ outcome: "refused", refusal: { reason: "changed-during-update", changed: "commit" } });
    expect(resets(fake)).toEqual([]);
    expect(head(r.clone)).toBe(mine);
  });

  it("still goes back when nothing was touched", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    const fake = failsAfter(() => undefined);
    expect(await update(fake)).toMatchObject({ outcome: "stopped", step: "install" });
    expect(head(r.clone)).toBe(old);
  });
});

/** The merge writes part of the new version and is then cut off. */
function cutOffMerge(result: "timeout" | "crash") {
  const fake = fakePnpm();
  const runner: Runner = async (command, args, options) => {
    if (!isMerge(command, args)) return fake.runner(command, args, options);
    writeFileSync(path.join(r.clone, "app.txt"), "half of the new version\n");
    if (result === "crash") throw new Error("the power went out");
    return { code: null, stdout: "", stderr: "", failure: "timeout" };
  };
  return { ...fake, runner };
}

describe("a checkout left part way between two versions", () => {
  it("a merge cut off with its files half written keeps the saved update and says how to get back", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    const run = await cli([], cutOffMerge("timeout"));
    expect(run.code).toBe(1);
    expect(run.text).toContain("part way");
    expect(run.text).toContain("app.txt");
    expect(run.text).toContain("git reset --hard");
    expect(run.text).toContain("git pull");
    expect(readTransaction(r.clone)).toMatchObject({ phase: "forward" });
    expect(head(r.clone)).toBe(old);
    expect(readFileSync(path.join(r.clone, "app.txt"), "utf8")).toBe("half of the new version\n");
  });

  it("after a crash there: the next run keeps the saved update and changes nothing, as many times as it is asked", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(cutOffMerge("crash"))).rejects.toThrow("the power went out");
    for (const _ of [1, 2]) {
      const run = await cli([]);
      expect(run.code).toBe(1);
      expect(run.text).toContain("part way");
      expect(run.fake.commands.filter((c) => c.startsWith("git merge --ff-only") || c.startsWith("git reset"))).toEqual([]);
      expect(readTransaction(r.clone)).not.toBeNull();
    }
  });

  it("names the lock git left behind", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isMerge))).rejects.toThrow("the power went out");
    writeFileSync(path.join(r.clone, ".git", "index.lock"), "");
    const run = await cli([]);
    expect(run.code).toBe(1);
    expect(run.text).toContain(path.join(r.clone, ".git", "index.lock"));
    expect(readTransaction(r.clone)).not.toBeNull();
  });

  it("sees a merge in progress", async () => {
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isMerge))).rejects.toThrow("the power went out");
    writeFileSync(path.join(r.clone, ".git", "MERGE_HEAD"), `${head(r.clone)}\n`);
    expect(await update()).toMatchObject({ outcome: "refused", refusal: { reason: "partial-checkout" } });
    expect(readTransaction(r.clone)).not.toBeNull();
  });

  it("a rollback cut off the same way is not called the person's edits", async () => {
    const old = head(r.clone);
    commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm((args) => isPnpm(args, INSTALL_ARGS)), (c, a) => c === "git" && a[0] === "reset"))).rejects.toThrow("the power went out");
    writeFileSync(path.join(r.clone, "app.txt"), "half of the old version\n");
    expect(head(r.clone)).not.toBe(old);
    expect(await update()).toMatchObject({ outcome: "refused", refusal: { reason: "partial-checkout" } });
  });
});

const finishesByHand = async () => {
  git(r.clone, "pull", "--quiet", "--ff-only");
  const run = await cli([]);
  expect(run.code).toBe(0);
  expect(readTransaction(r.clone)).toBeNull();
};

describe("the manual path works from every state the updater leaves", () => {
  it.skipIf(process.platform === "win32")("a step that would not stop, once it has ended", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    const pid = survivor();
    expect((await cli([], stuckAt(fakePnpm(), isCommand(INSTALL_ARGS), pid))).text).toContain("git pull");
    await endSurvivor(pid);
    await finishesByHand();
    expect(head(r.clone)).toBe(target);
  });

  it("files half written", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    expect((await cli([], cutOffMerge("timeout"))).text).toContain("git reset --hard, git pull, pnpm install, pnpm start");
    git(r.clone, "reset", "--quiet", "--hard");
    await finishesByHand();
    expect(head(r.clone)).toBe(target);
  });

  it("git's own lock left behind", async () => {
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    await expect(update(crashing(fakePnpm(), isMerge))).rejects.toThrow("the power went out");
    const lock = path.join(r.clone, ".git", "index.lock");
    writeFileSync(lock, "");
    expect((await cli([])).text).toContain(`delete ${lock}`);
    rmSync(lock);
    await finishesByHand();
    expect(head(r.clone)).toBe(target);
  });

  it("work saved while it installed", async () => {
    unrelatedFile();
    const target = commit(r.seed, "Newer");
    publish(r.seed);
    expect((await cli([], failsAfter(stageThenEdit))).text).toContain("git pull");
    git(r.clone, "stash", "--quiet");
    await finishesByHand();
    expect(head(r.clone)).toBe(target);
    git(r.clone, "stash", "pop", "--quiet", "--index");
    expect(git(r.clone, "show", ":other.txt")).toBe("staged");
    expect(readFileSync(path.join(r.clone, "other.txt"), "utf8")).toBe("working\n");
  });
});

describe("the test guard", () => {
  it("refuses a clone outside the test root before any command starts", async () => {
    // A fresh folder outside the root; never a real checkout.
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "gl-update-outside-")));
    const fake = fakePnpm();
    try {
      await expect(runUpdate({ root: outside, runner: fake.runner, choice: "auto", pnpm: fake.pnpm, appRunning: () => null, checkOnly: true, say: () => undefined, log: () => undefined })).rejects.toBeInstanceOf(UpdateGuardError);
      expect(() => realRunner("git", ["--version"], { cwd: outside })).toThrow(/outside the test root/);
      // A link inside the root that points out is outside too.
      symlinkSync(outside, path.join(r.base, "link-out"));
      expect(() => realRunner("git", ["--version"], { cwd: path.join(r.base, "link-out") })).toThrow(/outside the test root/);
      // Nothing ran: the look for an update in progress is refused first, before any git.
      expect(fake.commands).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses every command under vitest when no test root is set", async () => {
    vi.stubEnv("GATES_LOCAL_UPDATE_TEST_ROOT", "");
    expect(process.env["VITEST"]).toBeDefined();
    expect(() => realRunner("git", ["--version"], { cwd: r.clone })).toThrow(UpdateGuardError);
  });
});

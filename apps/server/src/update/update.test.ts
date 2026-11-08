// The updater against real git repositories built in a temporary folder
// (testing.ts), with a fake pnpm. Nothing here runs outside that folder: the
// guard refuses it, and the last tests prove the guard does.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_DESKTOP_ARGS, BUILD_WEB_ARGS, INSTALL_ARGS, runUpdate } from "./apply.ts";
import { runCli } from "./cli.ts";
import { UpdateGuardError } from "./guard.ts";
import { RECORD_FILE } from "./record.ts";
import { realRunner } from "./run.ts";
import { type Repos, commit, fakePnpm, git, head, makeRepos, publish, removeRepos, testEnv } from "./testing.ts";

let r: Repos;

beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

const isPnpm = (args: readonly string[], want: readonly string[]) => args.join(" ") === want.join(" ");

async function cli(argv: string[], fake = fakePnpm()) {
  const lines: string[] = [];
  const relaunch = vi.fn();
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
  });
  return { code, lines, text: lines.join("\n"), relaunch, fake };
}

const update = (fake = fakePnpm(), choice: "auto" | "main" | "release" = "auto") =>
  runUpdate({ root: r.clone, runner: fake.runner, choice, pnpm: fake.pnpm, appRunning: () => null, checkOnly: false, say: () => undefined, log: () => undefined });

const record = () => JSON.parse(readFileSync(path.join(r.data, RECORD_FILE), "utf8")) as Record<string, unknown>;

describe("checking and updating", () => {
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
      expect(fake.commands).toEqual(["git --version"]);
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

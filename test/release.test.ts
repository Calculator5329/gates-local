import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkTag, runReleaseCheck, runReleaseCommand, unitTotals, type ReleaseReport, cleanEnvironment, missingHostTools } from "../scripts/release.ts";
import { groupAlive, processAlive } from "../apps/server/src/process-state.ts";

const scratch: string[] = [];
const processCleanups: Array<() => void> = [];
const originalPath = process.env["PATH"];
afterEach(() => {
  for (const cleanup of processCleanups.splice(0)) cleanup();
  if (originalPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = originalPath;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function within<T>(work: Promise<T>, what: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), 20_000);
    })]);
  } finally { clearTimeout(deadline); }
}
function fixture(unitCommand = "node --test unit.cjs") {
  const dir = mkdtempSync(path.join(homedir(), ".cache", "release-test-"));
  scratch.push(dir);
  const remote = path.join(dir, "remote.git");
  const cwd = path.join(dir, "source");
  // Outside the checkout, so the real clean environment still resolves it
  // through PATH. Every fixture uses this local package-manager protocol.
  const toolchain = path.join(dir, "toolchain");
  mkdirSync(toolchain);
  writeFileSync(path.join(toolchain, "pnpm"), [
    '#!/usr/bin/env node',
    'if (process.argv[2] === "--filter") {',
    '  require("node:assert/strict").deepEqual(process.argv.slice(2), ["--filter", "@gates-local/desktop", "build"]);',
    '  require(require("node:path").join(process.cwd(), "desktop-build.cjs"));',
    `} else require(${JSON.stringify(new URL("./fixtures/release-pnpm.cjs", import.meta.url).pathname)});`,
  ].join("\n"), { mode: 0o755 });
  process.env["PATH"] = toolchain + path.delimiter + (process.env["PATH"] ?? "");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "--initial-branch=main", cwd], { stdio: "ignore" });
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.com");
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "release-fixture", private: true, packageManager: "pnpm@11.10.0", scripts: { verify: unitCommand, build: 'node -e "process.exit(0)"' } }));
  writeFileSync(path.join(cwd, "unit.cjs"), 'require("node:test")("planted unit test", () => require("node:assert/strict").fail("intentional unit failure"));');
  writeFileSync(path.join(cwd, "desktop-build.cjs"), 'require("node:fs").writeFileSync("desktop-built", "built");');
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd, stdio: "ignore" });
  git("add", "package.json", "pnpm-lock.yaml", "unit.cjs", "desktop-build.cjs");
  git("commit", "-m", "fixture");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const sha = git("rev-parse", "HEAD");
  const report: ReleaseReport = {
    schemaVersion: 1, commit: sha, remote, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 100,
    status: "passed", tools: { node: process.version, git: "test", pnpm: "test", playwright: "test" },
    steps: ["clone", "checkout", "install", "verify", "build", "desktop-build", "e2e"].map((name) => ({ name, blocking: true, status: "passed" as const, exitCode: 0, durationMs: 1 })),
    tests: { unit: { passed: 1, failed: 0, skipped: 0 }, e2e: { passed: 1, failed: 0, skipped: 0 } },
    failures: [], timing: { completed: false, exitCode: 134, reportPath: "informational.json" }, scratchRemoved: true,
  };
  return { dir, cwd, remote, git, sha, report };
}

/** Expire the command's deadline after its readiness event, keeping process I/O real. */
function commandDeadline() {
  const budget = 60_000;
  let expire: (() => void) | undefined;
  const realTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    const handle = realTimeout(callback, ms, ...args);
    // The comparison subtracts preparation time from its shared budget.
    if (ms !== undefined && ms > budget / 2 && ms <= budget) expire = () => {
      clearTimeout(handle);
      callback(...args);
    };
    return handle;
  });
  return { budget, expire: () => {
    if (!expire) throw new Error("The command did not schedule its deadline");
    expire();
  }, restore: () => timer.mockRestore() };
}

describe("release tag decisions against a local bare remote", () => {
  test.each(["reject", "replace", "before-create"])("RJ publication cleanup preserves only foreign tags (%s)", (mode) => {
    const f = fixture();
    f.git("tag", "-a", "v0.5.0", "-m", "unrelated tag");
    const foreign = f.git("rev-parse", "v0.5.0");
    const bin = path.join(f.dir, "bin"); mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), [
      '#!/usr/bin/env node',
      'const cp = require("node:child_process"); const args = process.argv.slice(2);',
      `const beforeCreate = ${JSON.stringify(mode)} === "before-create" && (args[0] === "tag" && args.includes("-a") || args[0] === "update-ref" && !args.includes("-d"));`,
      `if (beforeCreate || ${JSON.stringify(mode)} === "replace" && args.includes("push")) cp.execFileSync(${JSON.stringify(realGit)}, ["update-ref", "refs/tags/v1.0.0", ${JSON.stringify(foreign)}]);`,
      'if (args.includes("push")) process.exit(1);',
      `const result = cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"}); process.exit(result.status ?? 1);`,
    ].join("\n"), { mode: 0o755 });
    const reportPath = path.join(f.dir, "passed.json"); writeFileSync(reportPath, JSON.stringify(f.report));
    const result = spawnSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath, "--push"], { cwd: f.cwd, encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env["PATH"] } });
    expect(result.status).not.toBe(0);
    expect(f.git("rev-parse", "v0.5.0")).toBe(foreign);
    expect(f.git("ls-remote", "--tags", "origin")).not.toContain("refs/tags/v1.0.0");
    if (mode === "reject") {
      expect(f.git("tag", "--list", "v1.0.0"), "failed publication must remove its own local tag").toBe("");
      execFileSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath, "--push"], { cwd: f.cwd, stdio: "ignore" });
      expect(f.git("ls-remote", "--tags", "origin")).toContain("refs/tags/v1.0.0");
    } else expect(f.git("rev-parse", "v1.0.0")).toBe(foreign);
  });
  test("publication sends the checked tag even if the local ref is replaced before the push", () => {
    const f = fixture();
    const unchecked = f.git("commit-tree", "HEAD^{tree}", "-m", "unchecked commit");
    const bin = path.join(f.dir, "bin"); mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), [
      '#!/usr/bin/env node',
      'const cp = require("node:child_process"); const args = process.argv.slice(2);',
      `if (args.includes("push")) cp.execFileSync(${JSON.stringify(realGit)}, ["update-ref", "refs/tags/v1.0.0", ${JSON.stringify(unchecked)}]);`,
      `const result = cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"}); process.exit(result.status ?? 1);`,
    ].join("\n"), { mode: 0o755 });
    const reportPath = path.join(f.dir, "passed.json"); writeFileSync(reportPath, JSON.stringify(f.report));
    spawnSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath, "--push"], { cwd: f.cwd, encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env["PATH"] } });
    const remote = f.git("ls-remote", "--tags", "origin");
    expect(remote).toContain(`${f.sha}\trefs/tags/v1.0.0^{}`);
    expect(remote).not.toContain(unchecked);
  });
  test("a passing report permits dry run and explicit fixture push, ignoring timing information", async () => {
    const f = fixture();
    const result = await checkTag(f.cwd, "v1.0.0", f.report);
    expect(result.commit).toBe(f.sha);
    expect(result.message).not.toContain("Timing");
    expect(f.git("tag", "--list")).toBe("");
    const reportPath = path.join(f.dir, "passed.json");
    writeFileSync(reportPath, JSON.stringify(f.report));
    const output = execFileSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath], { cwd: f.cwd, encoding: "utf8" });
    expect(output).toContain("Would create annotated tag v1.0.0");
    expect(f.git("tag", "--list")).toBe("");
    // A user's followTags setting must not publish another annotated tag.
    f.git("tag", "-a", "v0.5.0", "-m", "unrelated fixture tag");
    f.git("config", "push.followTags", "true");
    execFileSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath, "--push"], { cwd: f.cwd, stdio: "ignore" });
    expect(f.git("cat-file", "-t", "refs/tags/v1.0.0")).toBe("tag");
    expect(f.git("tag", "-l", "v1.0.0", "--format=%(contents)")).not.toContain("Timing");
    const published = f.git("ls-remote", "--tags", "origin");
    expect(published).toContain("refs/tags/v1.0.0");
    expect(published).not.toContain("refs/tags/v0.5.0");
  });
  test("a report with a failed step cannot tag even when its top-level status says passed", async () => {
    const f = fixture();
    f.report.steps[3] = { name: "verify", blocking: true, status: "failed", exitCode: 1, durationMs: 1 };
    await expect(checkTag(f.cwd, "v1.0.0", f.report)).rejects.toThrow(/verify|failed/i);
  });
  test("a report for a different sha cannot tag", async () => {
    const f = fixture(); f.report.commit = "1".repeat(40);
    await expect(checkTag(f.cwd, "v1.0.0", f.report)).rejects.toThrow(/sha|commit/i);
  });
  test("RG-03: a report from another remote with the same commit cannot tag", async () => {
    const f = fixture();
    const fork = path.join(f.dir, "fork.git");
    execFileSync("git", ["clone", "--bare", f.remote, fork], { stdio: "ignore" });
    await expect(checkTag(f.cwd, "v1.0.0", { ...f.report, remote: fork })).rejects.toThrow(/remote.*origin|origin.*remote/i);
  });
  for (const change of ["main", "tag"] as const) test(`RG-04: refuses a ${change} race immediately before publishing`, () => {
    const f = fixture();
    const next = execFileSync("git", ["--git-dir", f.remote, "-c", "user.name=Release test", "-c", "user.email=release@example.com", "commit-tree", `${f.sha}^{tree}`, "-p", f.sha, "-m", "next fixture commit"], { encoding: "utf8" }).trim();
    const marker = path.join(f.dir, "race-triggered");
    const bin = path.join(f.dir, "bin");
    mkdirSync(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      `const result = require("node:child_process").spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:"inherit"});`,
      `if (result.status !== 0 || process.argv[2] !== "ls-remote" || fs.existsSync(${JSON.stringify(marker)})) process.exit(result.status ?? 1);`,
      `require("node:child_process").execFileSync("git", ${JSON.stringify(["--git-dir", f.remote, "update-ref", change === "main" ? "refs/heads/main" : "refs/tags/v2.0.0", change === "main" ? next : f.sha])});`,
      `fs.writeFileSync(${JSON.stringify(marker)}, "triggered");`,
    ].join("\n"), { mode: 0o755 });
    const reportPath = path.join(f.dir, "passed.json");
    writeFileSync(reportPath, JSON.stringify(f.report));
    const result = spawnSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath, "--push"], { cwd: f.cwd, encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env["PATH"] } });
    expect(existsSync(marker), result.stderr).toBe(true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(change === "main" ? /origin\/main.*moved|commit sha/i : /newer|greater|higher/i);
    expect(f.git("ls-remote", "--tags", "origin")).not.toContain("refs/tags/v1.0.0");
    expect(f.git("tag", "--list", "v1.0.0"), "RH-02: final refusal must leave no local tag").toBe("");
    if (change === "main") {
      f.git("merge", "--ff-only", "origin/main");
      writeFileSync(reportPath, JSON.stringify({ ...f.report, commit: next }));
      execFileSync("node", [path.resolve("scripts/release-tag.ts"), "v1.0.0", "--report", reportPath, "--push"], { cwd: f.cwd, stdio: "ignore" });
      expect(f.git("rev-parse", "v1.0.0^{}")).toBe(next);
      expect(f.git("ls-remote", "--tags", "origin")).toContain("refs/tags/v1.0.0");
    }
  });
  test("a version not greater than the newest remote tag cannot tag", async () => {
    const f = fixture(); f.git("tag", "v2.0.0"); f.git("push", "origin", "refs/tags/v2.0.0");
    await expect(checkTag(f.cwd, "v1.0.0", f.report)).rejects.toThrow(/greater|newer/i);
  });
  test("an existing remote tag cannot be re-created", async () => {
    const f = fixture(); f.git("tag", "v1.0.0"); f.git("push", "origin", "refs/tags/v1.0.0"); f.git("tag", "-d", "v1.0.0");
    await expect(checkTag(f.cwd, "v1.0.0", f.report)).rejects.toThrow(/exists/i);
  });
  test("an existing local tag cannot be re-created", async () => {
    const f = fixture(); f.git("tag", "v1.0.0");
    await expect(checkTag(f.cwd, "v1.0.0", f.report)).rejects.toThrow(/exists/i);
  });
  test("stale, future, incomplete, invalid-version and wrong-HEAD reports are refused", async () => {
    const f = fixture();
    await expect(checkTag(f.cwd, "1.0.0", f.report)).rejects.toThrow(/vX.Y.Z/);
    await expect(checkTag(f.cwd, "v1.0.0", { ...f.report, finishedAt: new Date(0).toISOString() })).rejects.toThrow(/24 hours/);
    await expect(checkTag(f.cwd, "v1.0.0", { ...f.report, finishedAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(/future/);
    await expect(checkTag(f.cwd, "v1.0.0", { ...f.report, steps: [] })).rejects.toThrow(/clone/);
    f.git("commit", "--allow-empty", "-m", "unpublished");
    await expect(checkTag(f.cwd, "v1.0.0", f.report)).rejects.toThrow(/HEAD/);
  });
});

test("the release check names the host tools it needs and stops before the clone when one is missing", async () => {
  // 0.2.0 and 0.2.1 were checked on a machine without bubblewrap: 28 of 30 sandbox tests skipped and the check passed.
  expect(missingHostTools("linux", file => file !== "/usr/bin/bwrap")).toEqual(["/usr/bin/bwrap"]);
  expect(missingHostTools("linux", () => false)).toEqual(["/usr/bin/bwrap", "/usr/bin/sqlite3"]);
  expect(missingHostTools("linux", () => true)).toEqual([]);
  expect(missingHostTools("win32", () => false)).toEqual([]);
  const f = fixture();
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "machine.json"), hostTools: () => ["/usr/bin/bwrap"] });
  expect(report.status).toBe("failed");
  expect(report.steps.map(s => s.name)).toEqual(["machine"]);
  expect(report.failures[0]).toMatchObject({ step: "machine" });
  expect(report.failures[0]!.message).toContain("/usr/bin/bwrap");
}, 30_000);

test("tests started by the release check may not skip for a missing host tool", () => {
  expect(cleanEnvironment("/h", "/t", "/c")["GATES_LOCAL_REQUIRE_HOST_TOOLS"]).toBe("1");
});

test("a failing unit command stops the clean-clone check and writes a failed report", async () => {
  const f = fixture();
  // Neither this untracked file nor a modified tracked file may enter the check.
  writeFileSync(path.join(f.cwd, "unit.cjs"), "process.exit(0)");
  writeFileSync(path.join(f.cwd, "private-state"), "must not be copied");
  const reportPath = path.join(f.dir, "report.json");
  const result = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath });
  const saved: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
  expect(saved).toMatchObject({ commit: f.sha, status: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "verify", status: "failed" })]) });
  expect(result.steps.some((s) => s.name === "e2e")).toBe(false);
  expect(result.failures.some((failure) => failure.message.includes("intentional unit failure"))).toBe(true);
  expect(existsSync(path.join(f.cwd, "private-state"))).toBe(true);
  expect(result.scratchRemoved).toBe(true);
  expect(result.tests.unit.failed).toBe(1);
  await expect(checkTag(f.cwd, "v1.0.0", result)).rejects.toThrow(/failed/);
}, 30_000);

test("unit totals count the final runner summary, including skips", () => {
  expect(unitTotals("Tests 1 failed\n Test Files 85 passed\n Tests 1295 passed | 1 skipped (1296)\n")).toEqual({ passed: 1295, failed: 0, skipped: 1 });
  expect(unitTotals("# pass 0\n# fail 1\n# skipped 0\n")).toEqual({ passed: 0, failed: 1, skipped: 0 });
});

function protocolFixture(extraCli: readonly string[] = []) {
  const f = fixture();
  // A local CLI protocol double exercises orchestration without starting a browser.
  const tool = path.join(f.cwd, "tools");
  mkdirSync(tool);
  writeFileSync(path.join(f.cwd, "unit.cjs"), 'require("node:test")("passing unit", () => require("node:assert/strict").ok(true));');
  writeFileSync(path.join(f.cwd, "package.json"), JSON.stringify({ name: "release-fixture", private: true, packageManager: "pnpm@11.10.0", scripts: { verify: "node --test unit.cjs", build: 'node -e "process.exit(0)"' }, devDependencies: { playwright: "file:tools" } }));
  writeFileSync(path.join(tool, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0", bin: { playwright: "cli.cjs" } }));
  writeFileSync(path.join(tool, "cli.cjs"), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("Playwright protocol fixture"); process.exit(0); }',
    'if (process.argv.includes("install")) process.exit(0);',
    'const name = process.argv.includes("--project=timing") ? "timing" : "e2e";',
    ...extraCli,
    'const failed = name === "timing";',
    'const status = failed ? "failed" : "passed";',
    'fs.mkdirSync(process.env.GL_E2E_RESULTS, { recursive: true });',
    'fs.writeFileSync(require("node:path").join(process.env.GL_E2E_RESULTS, "diagnostic.txt"), "protocol fixture, no browser");',
    `fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ stats: { expected: failed ? 0 : 1, unexpected: failed ? 1 : 0, flaky: 0, skipped: 0 }, suites: [{ title: "fixture", specs: [{ title: name, tests: [{ projectName: name, annotations: [{ type: "measured", description: "paint 200 ms" }, { type: "budget", description: "paint <120 ms" }], results: [{ status, errors: failed ? [{ message: "paint exceeded budget" }] : [] }] }] }] }] }));`,
    'process.exitCode = failed ? 1 : 0;',
  ].join("\n"), { mode: 0o755 });
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: f.cwd, stdio: "ignore" });
  f.git("add", "unit.cjs", "package.json", "pnpm-lock.yaml", "tools");
  f.git("commit", "-m", "passing protocol fixture");
  f.git("push", "origin", "main");
  const sha = f.git("rev-parse", "HEAD");
  return { ...f, sha };
}

function suppliedBrowserFixture() {
  const f = protocolFixture([
    'fs.writeFileSync(require("node:path").join(require("node:path").dirname(process.env.GATES_LOCAL_CHROMIUM), "environment.json"), JSON.stringify({ root: process.env.PLAYWRIGHT_BROWSERS_PATH, browser: process.env.GATES_LOCAL_CHROMIUM }));',
  ]);
  const local = createRequire(import.meta.url);
  const playwright = createRequire(local.resolve("@playwright/test/package.json"));
  const core = path.dirname(createRequire(playwright.resolve("playwright/package.json")).resolve("playwright-core/package.json"));
  // Use the installed toolchain's real registry without installing or launching a browser.
  const root = path.join(f.dir, "browsers");
  const pieces: Record<string, string> = JSON.parse(execFileSync(process.execPath, ["-e",
    'const {registry} = require(process.argv[1]).registry; console.log(JSON.stringify(Object.fromEntries(["chromium", "chromium-headless-shell", "ffmpeg"].map(name => [name, registry.findExecutable(name).executablePath()]))));',
    path.join(core, "lib/coreBundle.js"),
  ], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: root }, encoding: "utf8" }));
  for (const file of Object.values(pieces)) {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "toolchain fixture");
  }
  const browserPath = pieces["chromium"];
  if (!browserPath) throw new Error("Installed Playwright has no Chromium executable");
  mkdirSync(path.join(f.cwd, "tools/node_modules"));
  symlinkSync(core, path.join(f.cwd, "tools/node_modules/playwright-core"), "dir");
  f.git("add", "-f", "tools/node_modules/playwright-core");
  f.git("commit", "-m", "installed browser registry fixture"); f.git("push", "origin", "main");
  return { ...f, sha: f.git("rev-parse", "HEAD"), root, pieces, browserPath };
}

test("supplied browser shares its complete Playwright cache with the isolated environment without downloading", async () => {
  const f = suppliedBrowserFixture();
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, browserPath: f.browserPath, reportPath: path.join(f.dir, "supplied.json") });
  expect(report.status, JSON.stringify(report.failures)).toBe("passed");
  expect(JSON.parse(readFileSync(path.join(path.dirname(f.browserPath), "environment.json"), "utf8"))).toEqual({ root: f.root, browser: f.browserPath });
  expect(report.steps.some(step => step.name === "browser")).toBe(false);
  expect(report.limits).toContain("A supplied Playwright browser cache was shared with the fresh home; installing browsers into an empty cache was not proven.");
}, 30_000);

test("a supplied browser outside a Playwright cache fails setup and still reports the shared-cache limit", async () => {
  const f = suppliedBrowserFixture();
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, browserPath: path.join(f.dir, "chromium"), reportPath: path.join(f.dir, "outside.json") });
  expect(report.status).toBe("failed");
  expect(report.failures.map(failure => failure.message).join("\n")).toContain("chromium-<revision>");
  expect(report.limits).toContain("A supplied Playwright browser cache was shared with the fresh home; installing browsers into an empty cache was not proven.");
}, 30_000);

test.each(["chromium-headless-shell", "ffmpeg"])("supplied browser refuses missing %s before verify or browser tests", async piece => {
  const f = suppliedBrowserFixture();
  const file = f.pieces[piece];
  if (!file) throw new Error(`Installed Playwright has no ${piece}`);
  rmSync(file);
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, browserPath: f.browserPath, reportPath: path.join(f.dir, "missing.json") });
  expect(report.status).toBe("failed");
  expect(report.failures.map(failure => failure.message).join("\n")).toMatch(new RegExp(`Missing Playwright ${piece}.*playwright install chromium`, "s"));
  expect(report.steps.some(step => ["verify", "e2e"].includes(step.name))).toBe(false);
}, 30_000);

test("desktop build is blocking and completes before browser tests", async () => {
  const f = protocolFixture(['if (name === "e2e" && !fs.existsSync("desktop-built")) throw new Error("Electron app was not built");']);
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "desktop.json") });
  expect(report.status, JSON.stringify(report.failures)).toBe("passed");
  expect(report.steps.map(step => step.name)).toEqual(["clone", "checkout", "install", "verify", "build", "desktop-build", "browser", "e2e"]);
  expect(report.steps.find(step => step.name === "desktop-build")).toMatchObject({ blocking: true, status: "passed" });
  writeFileSync(path.join(f.cwd, "desktop-build.cjs"), 'throw new Error("desktop build failed");');
  f.git("add", "desktop-build.cjs"); f.git("commit", "-m", "failing desktop build fixture"); f.git("push", "origin", "main");
  const failed = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.git("rev-parse", "HEAD"), reportPath: path.join(f.dir, "desktop-failed.json") });
  expect(failed.steps.find(step => step.name === "desktop-build")).toMatchObject({ blocking: true, status: "failed" });
  expect(failed.steps.some(step => step.name === "e2e")).toBe(false);
  await expect(checkTag(f.cwd, "v1.0.0", { ...f.report, commit: f.git("rev-parse", "HEAD"), steps: f.report.steps.filter(step => step.name !== "desktop-build") })).rejects.toThrow(/desktop-build/);
}, 30_000);

test.each([
  ["crash", 'process.kill(process.pid,"SIGABRT");', {completed:false,exitCode:null,signal:"SIGABRT"}],
  ["ordinary failure", 'process.exit(1);', {completed:true,exitCode:1}],
  ["stale report", 'fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify({stats:{expected:1,unexpected:0,flaky:0,skipped:0},startTime:"2000-01-01",suites:[{specs:[{tests:[{projectName:"e2e",results:[{status:"passed"}]}]}]}]})); process.exit(0);', {completed:true,exitCode:0}],
  ["zero totals", 'fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify({stats:{expected:0,unexpected:0,flaky:0,skipped:0},suites:[{specs:[{tests:[{projectName:"timing",results:[{status:"passed"}]}]}]}]})); process.exit(0);', {completed:true,exitCode:0}],
] as const)("RJ informational timing cannot change a passing blocking verdict (%s)", async (_name, action, facts) => {
  const f = protocolFixture([`if (name === "timing") { ${action} }`]);
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir,"informational.json") });
  expect(report.status).toBe("passed");
  expect(report.timing).toMatchObject({...facts,reportPath:expect.stringContaining("timing.json")});
  expect(report.steps.find(step => step.name === "e2e")?.status).toBe("passed");
  await expect(checkTag(f.cwd,"v1.0.0",report)).resolves.toMatchObject({commit:f.sha});
}, 30_000);

// The pool runs the check as two jobs: the tests on any helper, the timing alone on a timing machine.
test("the check splits in two: the correctness half runs the tests and can tag, the timing half runs none and cannot", async () => {
  const f = protocolFixture();
  const correctness = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "correctness.json"), part: "correctness" });
  expect(correctness.status, JSON.stringify(correctness.failures)).toBe("passed");
  expect(correctness.steps.map(step => step.name)).toEqual(["clone", "checkout", "install", "verify", "build", "desktop-build", "browser", "e2e"]);
  expect(correctness.timing, "the correctness half starts no timing run").toBeUndefined();
  await expect(checkTag(f.cwd, "v1.0.0", correctness)).resolves.toMatchObject({ commit: f.sha });
  const timing = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "timing.json"), part: "timing" });
  expect(timing.steps.map(step => step.name)).toEqual(["clone", "checkout", "install", "build", "desktop-build", "browser"]);
  expect(timing.timing).toMatchObject({ completed: true, reportPath: expect.stringContaining("timing.json") });
  expect(timing.tests.unit.passed + timing.tests.e2e.passed).toBe(0);
  await expect(checkTag(f.cwd, "v1.0.0", timing)).rejects.toThrow(/timing-only report ran no tests/);
}, 30_000);

test("RJ tagging never reads timing information", async () => {
  const f = fixture();
  Object.defineProperty(f.report,"timing",{get:()=>{throw new Error("tagging read timing");}});
  Object.defineProperty(f.report,"performance",{get:()=>{throw new Error("tagging read performance");}});
  Object.defineProperty(f.report.tests,"timing",{get:()=>{throw new Error("tagging read timing totals");}});
  f.report.steps.push({name:"timing",blocking:true,status:"failed",exitCode:124,durationMs:1});
  f.report.failures.push({step:"timing",test:"legacy timing",message:"not part of the blocking verdict"});
  await expect(checkTag(f.cwd,"v1.0.0",f.report)).resolves.toMatchObject({commit:f.sha});
});

function performanceFixture(action = "") {
  const f = protocolFixture(['if (name === "e2e") fs.writeFileSync("correctness-passed", "yes");']);
  writeFileSync(path.join(f.cwd, "perf.cjs"), [
    'const fs = require("node:fs"), path = require("node:path");',
    'const args = process.argv.slice(2);',
    'if (!fs.existsSync("correctness-passed")) throw new Error("comparison ran before correctness");',
    'const out = args[args.indexOf("--out") + 1]; fs.mkdirSync(out, { recursive: true });',
    'if (args.includes("--prepare")) { fs.writeFileSync(path.join(out, "commits.json"), JSON.stringify({ base: args[1], candidate: args[2] })); process.exit(0); }',
    'if (args[args.indexOf("--rounds") + 1] !== "4" || args[args.indexOf("--samples") + 1] !== "2") throw new Error("unexpected sampling plan");',
    'const commits = JSON.parse(fs.readFileSync(path.join(args[args.indexOf("--prepared") + 1], "commits.json")));',
    'fs.writeFileSync(path.join(out, "partial.txt"), "retained tool diagnostic");',
    action,
    'fs.writeFileSync(path.join(out, "comparison.json"), JSON.stringify({ schema: 1, informational: true, commits, changes: [{ action: "picker", signal: "slower" }] }));',
    'fs.writeFileSync(path.join(out, "comparison.md"), "picker: slower; informational");',
  ].join("\n"));
  f.git("add", "perf.cjs"); f.git("commit", "-m", "comparison protocol fixture"); f.git("push", "origin", "main");
  return { ...f, sha: f.git("rev-parse", "HEAD") };
}

test.each(["released", "first release"])("release comparison records its exact base and retains slower results (%s)", async (mode) => {
  const f = performanceFixture();
  if (mode === "released") {
    f.git("tag", "v0.9.0", "HEAD~2"); f.git("tag", "-a", "v0.10.0", "HEAD~1", "-m", "previous release");
    f.git("tag", "v99.0.0-rc.1"); f.git("push", "origin", "--tags");
  }
  const base = f.git("rev-parse", mode === "released" ? "HEAD~1" : "HEAD~2");
  const reportPath = path.join(f.dir, "performance.json");
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath, performanceBase: f.git("rev-parse", "HEAD~2") });
  expect(report.status).toBe("passed");
  expect(report).toMatchObject({ performance: { status: "available", base, candidate: f.sha, baseSource: mode === "released" ? "release" : "fallback", exitCode: 0 } });
  if (mode === "released") expect(report.performance).toMatchObject({ releaseTag: "v0.10.0" });
  else expect(report.performance).toMatchObject({ note: expect.stringMatching(/no.*release/i) });
  expect(JSON.parse(readFileSync(reportPath + ".artifacts/performance/comparison.json", "utf8"))).toMatchObject({ commits: { base, candidate: f.sha }, changes: [{ signal: "slower" }] });
  expect(readFileSync(reportPath + ".artifacts/performance/comparison.md", "utf8")).toContain("slower");
  expect(report.scratchRemoved).toBe(true);
  await expect(checkTag(f.cwd, "v1.0.0", report)).resolves.toMatchObject({ commit: f.sha });
}, 30_000);

test.each(["lightweight", "off-branch"])("release comparison ignores %s stable-shaped tags before selecting a release", async mode => {
  const f = performanceFixture();
  const base = f.git("rev-parse", "HEAD~1");
  f.git("tag", "-a", "v1.0.0", base, "-m", "previous release");
  if (mode === "lightweight") f.git("tag", "v9.0.0", base);
  else {
    const unrelated = f.git("commit-tree", "HEAD^{tree}", "-m", "unrelated history");
    f.git("tag", "-a", "v9.0.0", unrelated, "-m", "off-branch tag");
  }
  f.git("push", "origin", "--tags");
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "qualified-base.json"), performanceBase: f.sha });
  expect(report.status).toBe("passed");
  expect(report.performance).toMatchObject({ base, baseSource: "release", releaseTag: "v1.0.0" });
  f.git("tag", "-d", "v1.0.0"); f.git("push", "origin", ":refs/tags/v1.0.0");
  const fallback = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "fallback-base.json"), performanceBase: f.sha });
  expect(fallback.performance).toMatchObject({ base: f.sha, baseSource: "fallback" });
}, 30_000);

test.each([
  ["command failure", "process.exit(17);", 17],
  ["missing report", "process.exit(0);", 0],
  ["wrong commits", 'commits.candidate = "0".repeat(40);', 0],
  ["malformed report", 'fs.writeFileSync(path.join(out, "comparison.json"), "not JSON"); process.exit(0);', 0],
] as const)("release comparison tool failure is unavailable, never a verdict (%s)", async (_name, action, exitCode) => {
  const f = performanceFixture(action);
  const reportPath = path.join(f.dir, "unavailable.json");
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath, performanceBase: f.sha });
  expect(report.status).toBe("passed");
  expect(report).toMatchObject({ performance: { status: "unavailable", exitCode, note: expect.any(String) } });
  expect(readFileSync(reportPath + ".artifacts/performance/partial.txt", "utf8")).toContain("diagnostic");
  await expect(checkTag(f.cwd, "v1.0.0", report)).resolves.toMatchObject({ commit: f.sha });
}, 30_000);

test.each(["timeout", "cancel"])("release comparison preserves bounded shutdown and whole-check cancellation (%s)", async (mode) => {
  const f = performanceFixture();
  const marker = path.join(f.dir, "performance-ready");
  const file = path.join(f.cwd, "perf.cjs");
  writeFileSync(file, readFileSync(file, "utf8").replace('const commits = JSON.parse', `fs.writeFileSync(${JSON.stringify(marker)}, "ready"); setInterval(() => {}, 1000);\nconst commits = JSON.parse`));
  f.git("add", "perf.cjs"); f.git("commit", "-m", "bounded comparison fixture"); f.git("push", "origin", "main");
  const abort = new AbortController();
  const watcher = watch(f.dir);
  const ready = new Promise<void>(resolve => watcher.on("change", () => { if (existsSync(marker)) resolve(); }));
  const clock = mode === "timeout" ? commandDeadline() : undefined;
  const checked = runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.git("rev-parse", "HEAD"), reportPath: path.join(f.dir, "bounded-performance.json"), performanceBase: f.sha, performanceTimeoutMs: clock?.budget, signal: abort.signal });
  try {
    await Promise.race([ready, checked.then(() => { throw new Error("comparison exited before readiness"); })]);
    if (mode === "cancel") abort.abort();
    else await clock?.expire();
    const report = await checked;
    expect(report.status).toBe(mode === "timeout" ? "passed" : "failed");
    expect(report.performance).toMatchObject({ status: "unavailable", timedOut: mode === "timeout" });
    expect(report.scratchRemoved).toBe(true);
    if (mode === "cancel") expect(report.interrupted).toBe(true);
    else await expect(checkTag(f.cwd, "v1.0.0", report)).resolves.toMatchObject({ commit: f.git("rev-parse", "HEAD") });
  } finally { clock?.restore(); watcher.close(); abort.abort(); await checked; }
}, 30_000);

test("release comparison states its default first-release base even when that commit is unavailable", async () => {
  const f = protocolFixture();
  const report = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "missing-base.json") });
  expect(report.status).toBe("passed");
  expect(report.performance).toMatchObject({ status: "unavailable", baseSource: "fallback", base: "a369f0a3b7280f33802d6f816287546814da99eb", exitCode: null, note: expect.stringMatching(/No previous release tag.*a369f0a/) });
}, 30_000);

test("RJ blocking functional failure still fails the release", async () => {
  const f = protocolFixture(['if (name === "e2e") { fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify({stats:{expected:0,unexpected:1,flaky:0,skipped:0},suites:[{specs:[{title:"functional companion",tests:[{results:[{status:"failed",errors:[{message:"rendered only 399 messages"}]}]}]}]}]})); process.exit(1); }']);
  const report = await runReleaseCheck({cwd:f.cwd,remote:f.remote,commit:f.sha,reportPath:path.join(f.dir,"functional.json")});
  expect(report.status).toBe("failed");
  expect(report.failures.some(failure=>failure.message.includes("399 messages"))).toBe(true);
  expect(report.timing).toBeUndefined();
  expect(report.performance).toBeUndefined();
  await expect(checkTag(f.cwd,"v1.0.0",report)).rejects.toThrow(/failed/);
},30_000);

test("RJ build failure blocks before the browser project", async () => {
  const f = protocolFixture();
  const file = path.join(f.cwd,"package.json");
  const pkg: unknown = JSON.parse(readFileSync(file,"utf8"));
  if (typeof pkg!=="object" || pkg===null || !("scripts" in pkg) || typeof pkg.scripts!=="object" || pkg.scripts===null) throw new Error("missing fixture scripts");
  Object.assign(pkg.scripts,{build:'node -e "process.exit(1)"'});
  writeFileSync(file,JSON.stringify(pkg));
  f.git("add","package.json"); f.git("commit","-m","failing build fixture"); f.git("push","origin","main");
  const report = await runReleaseCheck({cwd:f.cwd,remote:f.remote,commit:f.git("rev-parse","HEAD"),reportPath:path.join(f.dir,"build.json")});
  expect(report.status).toBe("failed");
  expect(report.steps.find(step=>step.name==="build")?.status).toBe("failed");
  expect(report.steps.some(step=>step.name==="e2e")).toBe(false);
  expect(report.performance).toBeUndefined();
},30_000);

test("RJ timing has its own bound and its timeout is informational", async () => {
  const f = protocolFixture();
  const marker = path.join(f.dir,"timing-ready");
  const file = path.join(f.cwd,"tools","cli.cjs");
  writeFileSync(file,readFileSync(file,"utf8").replace('const failed = name === "timing";',`if (name === "timing") { fs.writeFileSync(${JSON.stringify(marker)},"ready"); setInterval(()=>{},1000); }\nconst failed = name === "timing";`));
  f.git("add","tools/cli.cjs"); f.git("commit","-m","bounded informational fixture"); f.git("push","origin","main");
  const abort = new AbortController(); const watcher = watch(f.dir);
  const ready = new Promise<void>(resolve=>watcher.on("change",()=>{if(existsSync(marker))resolve();}));
  const clock = commandDeadline();
  const checked = runReleaseCheck({cwd:f.cwd,remote:f.remote,commit:f.git("rev-parse","HEAD"),reportPath:path.join(f.dir,"bounded.json"),signal:abort.signal,timingTimeoutMs:clock.budget});
  try {
    await Promise.race([ready, checked.then(() => { throw new Error("timing exited before readiness"); })]);
    await clock.expire();
    const report = await checked;
    expect(report.status).toBe("passed");
    expect(report.timing).toMatchObject({completed:false,timedOut:true});
  } finally {clock.restore();watcher.close();abort.abort();await checked;}
},30_000);

test("RJ inherited writers: the failed report discloses a possible escaped descendant", async () => {
  const f = fixture();
  const marker = path.join(f.dir, "escaped-report.pid");
  const worker = `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000);`;
  const bin = path.join(f.dir, "bin"); mkdirSync(bin);
  const realPnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(bin, "pnpm"), [
    '#!/usr/bin/env node',
    `if (process.argv[2] === "verify") { require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(worker)}],{detached:true,stdio:["ignore",1,2]}).unref(); setInterval(()=>{},1000); }`,
    `else { const result = require("node:child_process").spawnSync(${JSON.stringify(realPnpm)},process.argv.slice(2),{stdio:"inherit"}); process.exit(result.status ?? 1); }`,
  ].join("\n"), { mode: 0o755 });
  const priorPath = process.env["PATH"];
  process.env["PATH"] = bin + path.delimiter + priorPath;
  const abort = new AbortController(); const watcher = watch(f.dir);
  const started = new Promise<void>(resolve => watcher.on("change", () => { if (existsSync(marker) && readFileSync(marker,"utf8")) resolve(); }));
  const checked = runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "escaped-report.json"), signal: abort.signal });
  try {
    await started; abort.abort();
    const report = await checked;
    expect(processAlive(Number(readFileSync(marker,"utf8")))).toBe(true);
    expect(report.status).toBe("failed");
    expect(report.failures).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/outside.*group.*may still be running/i) }));
    expect(report.scratchRemoved).toBe(false);
    const retained = report.failures.find(failure => failure.step === "cleanup")?.message.match(/^Temporary data retained at (.+): /)?.[1];
    expect(retained?.startsWith(path.join(homedir(), ".cache", "gl-release") + path.sep)).toBe(true);
    if (retained) scratch.push(retained);
  } finally {
    watcher.close(); abort.abort();
    if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker,"utf8")), "SIGKILL"); } catch { /* already gone */ } }
    await checked;
    if (priorPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = priorPath;
  }
}, 30_000);

test("RJ whole-check cancellation fails even during informational timing", async () => {
  const f = protocolFixture(['if (name === "timing") { fs.mkdirSync(process.env.GL_E2E_RESULTS,{recursive:true}); fs.writeFileSync(require("node:path").join(process.env.GL_E2E_RESULTS,"canceled-trace.txt"),"retained cancellation diagnostic"); fs.writeFileSync(require("node:path").join(process.env.HOME,"timing-started"), "ready"); setInterval(() => {}, 1000); }']);
  // Watch the report directory for the timing command's explicit readiness marker.
  const marker = path.join(f.dir, "timing-ready");
  const tool = path.join(f.cwd, "tools", "cli.cjs");
  writeFileSync(tool, readFileSync(tool, "utf8").replace('require("node:path").join(process.env.HOME,"timing-started")', JSON.stringify(marker)));
  f.git("add", "tools/cli.cjs"); f.git("commit", "-m", "timing cancellation fixture"); f.git("push", "origin", "main");
  const abort = new AbortController();
  const watcher = watch(f.dir);
  const started = new Promise<void>((resolve) => watcher.on("change", () => { if (existsSync(marker)) resolve(); }));
  const reportPath = path.join(f.dir, "cancel-timing.json");
  const checked = runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.git("rev-parse", "HEAD"), reportPath, signal: abort.signal });
  try {
    await started; abort.abort();
    const report = await checked;
    expect(report.steps.find((s) => s.name === "e2e")?.status).toBe("passed");
    expect(report.status).toBe("failed");
    expect(report.interrupted).toBe(true);
    await expect(checkTag(f.cwd, "v1.0.0", report)).rejects.toThrow(/failed|interrupted/);
  } finally { watcher.close(); abort.abort(); await checked; }
}, 30_000);

test("RH-03: cancellation settles when an escaped session keeps stdout open", async () => {
  const f = fixture();
  const marker = path.join(f.dir, "escaped.pid");
  const worker = `require("node:fs").writeFileSync(${JSON.stringify(marker)},JSON.stringify({escaped:process.pid,owner:process.ppid})); setInterval(()=>{},1000);`;
  const owner = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(worker)}],{detached:true,stdio:["ignore",1,2]}).unref(); setInterval(()=>{},1000);`;
  const abort = new AbortController();
  const watcher = watch(f.dir);
  const started = new Promise<void>((resolve) => watcher.on("change", () => { if (existsSync(marker) && readFileSync(marker,"utf8")) resolve(); }));
  const checked = runReleaseCommand([process.execPath, "-e", owner], f.cwd, process.env, path.join(f.dir, "escaped.log"), abort.signal);
  const pids = () => {
    const value: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (typeof value !== "object" || value === null || !("escaped" in value) || !("owner" in value) || typeof value.escaped !== "number" || typeof value.owner !== "number") throw new Error("invalid process marker");
    return { escaped: value.escaped, owner: value.owner };
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    watcher.close(); abort.abort();
    if (!existsSync(marker)) return;
    let ids: ReturnType<typeof pids>;
    try { ids = pids(); } catch { return; }
    try { process.kill(ids.escaped, "SIGKILL"); } catch { /* Already gone. */ }
    try { process.kill(process.platform === "win32" ? ids.owner : -ids.owner, "SIGKILL"); } catch { /* Already gone. */ }
  };
  processCleanups.push(cleanup);
  try {
    await within(started, "escaped worker readiness");
    abort.abort();
    const result = await within(checked, "release cancellation with an escaped stdout writer");
    expect(groupAlive(pids().owner), "the owned group already ended").toBe(false);
    expect(processAlive(pids().escaped), "cancellation must not kill another session").toBe(true);
    expect(result).toMatchObject({ code: 130, interrupted: true });
    const ids = pids();
    let laterCleanupRan = false;
    processCleanups.push(() => { laterCleanupRan = true; });
    writeFileSync(marker, "{");
    try {
      expect(() => { for (const runCleanup of processCleanups.splice(0)) runCleanup(); }).not.toThrow();
      expect(laterCleanupRan).toBe(true);
    } finally {
      try { process.kill(ids.escaped, "SIGKILL"); } catch { /* Already gone. */ }
    }
  } finally {
    cleanup();
  }
}, 30_000);

test("RG-07: a focused blocking browser test is refused", async () => {
  const f = protocolFixture(['if (name === "e2e" && process.argv.includes("--forbid-only")) { console.error("focused test forbidden"); process.exit(1); }']);
  const result = await runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.sha, reportPath: path.join(f.dir, "focused.json") });
  expect(result.status).toBe("failed");
  expect(result.steps.find((s) => s.name === "e2e")?.status).toBe("failed");
  expect(readFileSync(path.join(f.dir, "focused.json.artifacts", "e2e.log"), "utf8")).toContain("focused test forbidden");
}, 30_000);

test("RG-06: cancellation stops a SIGTERM-ignoring descendant after the leader closes its pipes", async () => {
  const f = fixture("node unit.cjs");
  const marker = path.join(f.dir, "descendant.pid");
  const worker = `process.on("SIGTERM",()=>{}); require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000);`;
  writeFileSync(path.join(f.cwd, "unit.cjs"), `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(worker)}],{stdio:"ignore"}).unref(); setInterval(()=>{},1000);`);
  f.git("add", "unit.cjs"); f.git("commit", "-m", "closed pipe descendant fixture"); f.git("push", "origin", "main");
  const abort = new AbortController();
  const watcher = watch(f.dir);
  const started = new Promise<void>((resolve) => watcher.on("change", () => { if (existsSync(marker) && readFileSync(marker,"utf8")) resolve(); }));
  const checked = runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.git("rev-parse", "HEAD"), reportPath: path.join(f.dir,"descendant.json"), signal: abort.signal });
  try {
    await started; abort.abort();
    const report = await checked;
    expect(report.status).toBe("failed");
    expect(processAlive(Number(readFileSync(marker,"utf8")))).toBe(false);
    expect(report.scratchRemoved).toBe(true);
  } finally {
    watcher.close(); abort.abort(); await checked;
    if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker,"utf8")),"SIGKILL"); } catch { /* already gone */ } }
  }
}, 30_000);

test("interrupting a running check stops its child and preserves a failed report before cleanup", async () => {
  const f = fixture("node unit.cjs");
  const marker = path.join(f.dir, "unit-started");
  writeFileSync(path.join(f.cwd, "unit.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  f.git("add", "unit.cjs"); f.git("commit", "-m", "interrupt fixture"); f.git("push", "origin", "main");
  const abort = new AbortController();
  const watcher = watch(f.dir);
  const started = new Promise<void>((resolve) => watcher.on("change", () => { if (existsSync(marker)) resolve(); }));
  const reportPath = path.join(f.dir, "interrupted.json");
  const checked = runReleaseCheck({ cwd: f.cwd, remote: f.remote, commit: f.git("rev-parse", "HEAD"), reportPath, signal: abort.signal });
  try {
    await started;
    abort.abort();
    const result = await checked;
    expect(result.status).toBe("failed");
    expect(result.scratchRemoved, JSON.stringify(result.failures)).toBe(true);
    expect(result.steps.find((s) => s.name === "verify")?.exitCode).toBe(130);
    expect(existsSync(reportPath)).toBe(true);
    expect(processAlive(Number(readFileSync(marker, "utf8")))).toBe(false);
  } finally { watcher.close(); abort.abort(); await checked; }
}, 30_000);

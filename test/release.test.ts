import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkTag, runReleaseCheck, runReleaseCommand, unitTotals, type ReleaseReport } from "../scripts/release.ts";
import { groupAlive, processAlive } from "../apps/server/src/process-state.ts";

const scratch: string[] = [];
const originalPath = process.env["PATH"];
afterEach(() => {
  if (originalPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = originalPath;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(homedir(), ".cache", "release-test-"));
  scratch.push(dir);
  const remote = path.join(dir, "remote.git");
  const cwd = path.join(dir, "source");
  // Outside the checkout, so the real clean environment still resolves it
  // through PATH. Every fixture uses this local package-manager protocol.
  const toolchain = path.join(dir, "toolchain");
  mkdirSync(toolchain);
  writeFileSync(path.join(toolchain, "pnpm"), readFileSync(new URL("./fixtures/release-pnpm.cjs", import.meta.url)), { mode: 0o755 });
  process.env["PATH"] = toolchain + path.delimiter + (process.env["PATH"] ?? "");
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "--initial-branch=main", cwd], { stdio: "ignore" });
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.com");
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "release-fixture", private: true, packageManager: "pnpm@11.10.0", scripts: { verify: "node --test unit.cjs", build: 'node -e "process.exit(0)"' } }));
  writeFileSync(path.join(cwd, "unit.cjs"), 'require("node:test")("planted unit test", () => require("node:assert/strict").fail("intentional unit failure"));');
  execFileSync("pnpm", ["install", "--lockfile-only"], { cwd, stdio: "ignore" });
  git("add", "package.json", "pnpm-lock.yaml", "unit.cjs");
  git("commit", "-m", "fixture");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const sha = git("rev-parse", "HEAD");
  const report: ReleaseReport = {
    schemaVersion: 1, commit: sha, remote, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 100,
    status: "passed", tools: { node: process.version, git: "test", pnpm: "test", playwright: "test" },
    steps: ["clone", "checkout", "install", "verify", "build", "e2e"].map((name) => ({ name, blocking: true, status: "passed" as const, exitCode: 0, durationMs: 1 })),
    tests: { unit: { passed: 1, failed: 0, skipped: 0 }, e2e: { passed: 1, failed: 0, skipped: 0 } },
    failures: [], timing: { completed: false, exitCode: 134, reportPath: "informational.json" }, scratchRemoved: true,
  };
  return { dir, cwd, remote, git, sha, report };
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

test("RJ tagging never reads timing information", async () => {
  const f = fixture();
  Object.defineProperty(f.report,"timing",{get:()=>{throw new Error("tagging read timing");}});
  Object.defineProperty(f.report.tests,"timing",{get:()=>{throw new Error("tagging read timing totals");}});
  f.report.steps.push({name:"timing",blocking:true,status:"failed",exitCode:124,durationMs:1});
  f.report.failures.push({step:"timing",test:"legacy timing",message:"not part of the blocking verdict"});
  await expect(checkTag(f.cwd,"v1.0.0",f.report)).resolves.toMatchObject({commit:f.sha});
});

test("RJ blocking functional failure still fails the release", async () => {
  const f = protocolFixture(['if (name === "e2e") { fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify({stats:{expected:0,unexpected:1,flaky:0,skipped:0},suites:[{specs:[{title:"functional companion",tests:[{results:[{status:"failed",errors:[{message:"rendered only 399 messages"}]}]}]}]}]})); process.exit(1); }']);
  const report = await runReleaseCheck({cwd:f.cwd,remote:f.remote,commit:f.sha,reportPath:path.join(f.dir,"functional.json")});
  expect(report.status).toBe("failed");
  expect(report.failures.some(failure=>failure.message.includes("399 messages"))).toBe(true);
  expect(report.timing).toBeUndefined();
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
},30_000);

test("RJ timing has its own bound and its timeout is informational", async () => {
  const f = protocolFixture();
  const marker = path.join(f.dir,"timing-ready");
  const file = path.join(f.cwd,"tools","cli.cjs");
  writeFileSync(file,readFileSync(file,"utf8").replace('const failed = name === "timing";',`if (name === "timing") { fs.writeFileSync(${JSON.stringify(marker)},"ready"); setInterval(()=>{},1000); }\nconst failed = name === "timing";`));
  f.git("add","tools/cli.cjs"); f.git("commit","-m","bounded informational fixture"); f.git("push","origin","main");
  const abort = new AbortController(); const watcher = watch(f.dir);
  const ready = new Promise<void>(resolve=>watcher.on("change",()=>{if(existsSync(marker))resolve();}));
  const checked = runReleaseCheck({cwd:f.cwd,remote:f.remote,commit:f.git("rev-parse","HEAD"),reportPath:path.join(f.dir,"bounded.json"),signal:abort.signal,timingTimeoutMs:1000});
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready;
    const report = await Promise.race([checked,new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(new Error("timing did not settle within its own bound")),2500);})]);
    expect(report.status).toBe("passed");
    expect(report.timing).toMatchObject({completed:false,timedOut:true});
  } finally {if(deadline)clearTimeout(deadline);watcher.close();abort.abort();await checked;}
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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await started;
    abort.abort();
    const state = await Promise.race([checked.then(() => "settled"), new Promise<string>(resolve => { deadline = setTimeout(() => resolve("blocked on inherited stdout"), 1000); })]);
    expect(groupAlive(pids().owner), "the owned group already ended").toBe(false);
    expect(state).toBe("settled");
    expect(processAlive(pids().escaped), "cancellation must not kill another session").toBe(true);
    expect(await checked).toMatchObject({ code: 130, interrupted: true });
  } finally {
    if (deadline) clearTimeout(deadline);
    watcher.close(); abort.abort();
    if (existsSync(marker)) { try { process.kill(pids().escaped, "SIGKILL"); } catch { /* already gone */ } }
    await checked;
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
  const f = fixture();
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
  const f = fixture();
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
    expect(result.scratchRemoved).toBe(true);
    expect(result.steps.find((s) => s.name === "verify")?.exitCode).toBe(130);
    expect(existsSync(reportPath)).toBe(true);
    expect(processAlive(Number(readFileSync(marker, "utf8")))).toBe(false);
  } finally { watcher.close(); abort.abort(); await checked; }
}, 30_000);

// Test repositories for the updater: a bare "origin", a "seed" clone that
// publishes to it, and the "clone" the updater works on, all inside one
// fresh temporary folder that is also the guard's test root (guard.ts). The
// git commands here run with the same ceiling, and refuse a folder outside
// the root before they start, so a slip in a test cannot reach a checkout.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pnpm } from "./apply.ts";
import { TEST_ROOT_ENV, guardTarget, inside } from "./guard.ts";
import { realRunner, type RunResult, type Runner } from "./run.ts";

export interface Repos {
  readonly base: string;
  readonly origin: string;
  readonly seed: string;
  readonly clone: string;
  /** The app's data folder for the CLI's log and result files. */
  readonly data: string;
}

/**
 * The environment every git in these tests sees, the updater's included (the
 * caller stubs process.env with it): no global or system config, so a
 * developer's hooks, signing or aliases never run against the test repos.
 */
export function testEnv(base: string): Record<string, string> {
  const empty = path.join(base, "gitconfig");
  writeFileSync(empty, "");
  return {
    [TEST_ROOT_ENV]: base,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: base,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

let current: string | undefined;

/** git in a test repo; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  if (current === undefined || !inside(current, realpathSync(cwd))) throw new Error(`test git refused outside the test root: ${cwd}`);
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...testEnv(current) }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fresh root with origin, seed and clone; set process.env from testEnv(base) before running the updater. */
export function makeRepos(): Repos {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "gl-update-")));
  current = base;
  const origin = path.join(base, "origin.git");
  const seed = path.join(base, "seed");
  const clone = path.join(base, "clone");
  const data = path.join(base, "data");
  mkdirSync(data);
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(base, "clone", "--quiet", origin, seed);
  writeFileSync(path.join(seed, ".gitignore"), "ignored/\n");
  writeFileSync(path.join(seed, "app.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "First commit");
  git(seed, "push", "--quiet", "origin", "HEAD:main");
  git(base, "clone", "--quiet", origin, clone);
  return { base, origin, seed, clone, data };
}

/** Removes the root makeRepos made; only a folder this module made. */
export function removeRepos(r: Repos): void {
  if (r.base !== current || !path.basename(r.base).startsWith("gl-update-")) throw new Error(`test cleanup refused: ${r.base}`);
  rmSync(r.base, { recursive: true, force: true });
  current = undefined;
}

/** One commit in repo that changes app.txt; returns its full hash. */
export function commit(repo: string, subject: string): string {
  writeFileSync(path.join(repo, "app.txt"), `${subject}\n`);
  git(repo, "commit", "--quiet", "-am", subject);
  return git(repo, "rev-parse", "HEAD");
}

/** Push the seed's main and tags to origin. */
export function publish(seed: string): void {
  git(seed, "push", "--quiet", "--follow-tags", "origin", "HEAD:main");
  git(seed, "push", "--quiet", "--tags", "origin");
}

export const head = (repo: string) => git(repo, "rev-parse", "HEAD");

export interface PnpmCall {
  readonly args: readonly string[];
  /** The clone's commit when the call ran. */
  readonly head: string;
}

/**
 * A pnpm that runs nothing: it records each call and the commit it ran on,
 * and fails when fail(args, call number) says so. Every other command (git)
 * goes to the real runner, guard included.
 */
export function fakePnpm(fail: (args: readonly string[], n: number) => boolean = () => false): { pnpm: Pnpm; runner: Runner; calls: PnpmCall[]; commands: string[] } {
  const calls: PnpmCall[] = [];
  const commands: string[] = [];
  const runner: Runner = async (command, args, options) => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command !== "fake-pnpm") return realRunner(command, args, options);
    guardTarget(options.cwd);
    calls.push({ args, head: git(options.cwd, "rev-parse", "HEAD") });
    const failed = fail(args, calls.length);
    const result: RunResult = failed ? { code: 1, stdout: "", stderr: "ERR_PNPM_TEST the fake pnpm failed here" } : { code: 0, stdout: "", stderr: "" };
    return result;
  };
  return { pnpm: { command: "fake-pnpm", prefix: [], shell: false }, runner, calls, commands };
}

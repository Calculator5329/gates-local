import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import setup from "./global-setup.ts";

const PREFIX = "gates-local-test-run-";
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
const parents: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const parent of parents.splice(0)) rmSync(parent, { recursive: true, force: true });
});

function parentForRun() {
  const parent = mkdtempSync(path.join(tmpdir(), "setup-probe-"));
  parents.push(parent);
  for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, parent);
  return parent;
}

test("workers and their children use the disposable run root", () => {
  const root = tmpdir();
  expect(path.basename(root)).toMatch(/^gates-local-test-run-/);
  expect(process.env["TMP"]).toBe(root);
  expect(process.env["TEMP"]).toBe(root);
  mkdtempSync(path.join(root, "worker-"));
  const childRoot = execFileSync(process.execPath, ["-e", 'const os = require("node:os"); const fs = require("node:fs"); const path = require("node:path"); fs.mkdtempSync(path.join(os.tmpdir(), "child-")); process.stdout.write(os.tmpdir());'], { encoding: "utf8" });
  expect(childRoot).toBe(root);
});

test("teardown removes the run folder and restores the calling environment", () => {
  const parent = parentForRun();
  const teardown = setup({ config: { env: {} } });
  const root = tmpdir();
  expect(path.dirname(root)).toBe(parent);
  expect(path.basename(root)).toMatch(/^gates-local-test-run-/);
  expect(existsSync(root)).toBe(true);
  teardown();
  expect(existsSync(root)).toBe(false);
  expect(tmpdir()).toBe(parent);
});

test("teardown can remove a child whose owner permissions were cleared", () => {
  parentForRun();
  const teardown = setup({ config: { env: {} } });
  const root = tmpdir();
  const locked = path.join(root, "locked");
  mkdirSync(path.join(locked, "child"), { recursive: true });
  chmodSync(locked, 0o000);
  try {
    expect(() => teardown()).not.toThrow();
    expect(existsSync(root)).toBe(false);
  } finally { if (existsSync(locked)) chmodSync(locked, 0o700); }
});

test("setup sweeps only old run folders with its own exact prefix", () => {
  const parent = parentForRun();
  const old = path.join(parent, PREFIX + "old");
  const fresh = path.join(parent, PREFIX + "fresh");
  const foreign = path.join(parent, "another-test-old");
  for (const dir of [old, fresh, foreign]) mkdirSync(dir);
  const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
  for (const dir of [old, foreign]) utimesSync(dir, yesterday, yesterday);
  const teardown = setup({ config: { env: {} } });
  try {
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  } finally { teardown(); }
});

test.skipIf(process.platform === "win32")("stale cleanup repairs directories without changing linked outside entries", () => {
  const parent = parentForRun();
  const stale = path.join(parent, PREFIX + "locked");
  const locked = path.join(stale, "locked");
  const outside = path.join(parent, "outside");
  const outsideFile = path.join(parent, "outside-file");
  mkdirSync(locked, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "kept"), "outside contents");
  symlinkSync(outside, path.join(stale, "link"));
  writeFileSync(outsideFile, "hard-linked contents", { mode: 0o400 });
  linkSync(outsideFile, path.join(stale, "hard-link"));
  chmodSync(outside, 0o500);
  chmodSync(locked, 0o000);
  // Keep the first removal from unlinking the link before it finds the locked child.
  chmodSync(stale, 0o000);
  const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stale, yesterday, yesterday);
  const teardown = setup({ config: { env: {} } });
  try {
    expect(existsSync(stale)).toBe(false);
    expect(statSync(outside).mode & 0o777).toBe(0o500);
    expect(readFileSync(path.join(outside, "kept"), "utf8")).toBe("outside contents");
    expect(statSync(outsideFile).mode & 0o777).toBe(0o400);
    expect(readFileSync(outsideFile, "utf8")).toBe("hard-linked contents");
  } finally {
    teardown();
    chmodSync(outside, 0o700);
    if (existsSync(stale)) chmodSync(stale, 0o700);
    if (existsSync(locked)) chmodSync(locked, 0o700);
  }
});

test("empty temp environment values count as unset", () => {
  const parent = parentForRun();
  vi.stubEnv("TMPDIR", "");
  vi.stubEnv("TEMP", "");
  const teardown = setup({ config: { env: {} } });
  try { expect(path.dirname(tmpdir())).toBe(parent); }
  finally { teardown(); }
});

test("cleanup warns once and restores the environment if removal stays blocked", () => {
  const parent = parentForRun();
  const teardown = setup({ config: { env: {} } });
  const root = tmpdir();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const blocked = () => { throw new Error(`Removal is busy: ${root}`); };
  vi.mocked(rmSync).mockImplementationOnce(blocked).mockImplementationOnce(blocked);
  expect(() => teardown()).not.toThrow();
  expect(warning).toHaveBeenCalledOnce();
  expect(warning.mock.calls[0]?.[0]).toContain(root);
  expect(existsSync(root)).toBe(true);
  expect(tmpdir()).toBe(parent);
});

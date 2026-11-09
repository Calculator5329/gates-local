import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

const PREFIX = "gates-local-test-run-";
const DAY = 24 * 60 * 60 * 1000;

/** Restore only owner permissions; never follow links outside the run tree. */
function restoreOwnerAccess(root: string) {
  const info = lstatSync(root);
  if (!info.isDirectory()) return;
  chmodSync(root, info.mode | 0o700);
  for (const entry of readdirSync(root)) restoreOwnerAccess(path.join(root, entry));
}

/** A failed cleanup is diagnostic, so it cannot turn a green suite red. */
function removeRun(root: string) {
  try {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
    catch {
      restoreOwnerAccess(root);
      rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  } catch (error) { console.warn(`Test scratch folder could not be removed: ${root}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** One disposable scratch tree per invocation, also inherited by child processes. */
export default function setup(project: { config: Pick<TestProject["config"], "env"> }) {
  const fallback = path.join(homedir(), ".cache", "gates-local-test-tmp");
  const parent = process.platform === "win32"
    ? process.env["TEMP"] || process.env["TMP"] || fallback
    : process.env["TMPDIR"] || process.env["TMP"] || process.env["TEMP"] || fallback;
  mkdirSync(parent, { recursive: true });
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const folder = path.join(parent, entry.name);
    try { if (Date.now() - lstatSync(folder).mtimeMs > DAY) removeRun(folder); }
    catch { /* Another invocation may have removed its own folder. */ }
  }
  const root = mkdtempSync(path.join(parent, PREFIX));
  const previous = { TMPDIR: process.env["TMPDIR"], TMP: process.env["TMP"], TEMP: process.env["TEMP"] };
  const env = { TMPDIR: root, TMP: root, TEMP: root };
  Object.assign(process.env, env);
  project.config.env = { ...project.config.env, ...env };
  return () => {
    try { removeRun(root); }
    finally {
      for (const key of ["TMPDIR", "TMP", "TEMP"] as const) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  };
}

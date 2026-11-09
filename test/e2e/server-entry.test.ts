import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ROOT } from "./env.ts";
import { e2eServerEntry } from "./server-entry.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("ordinary E2E uses the offline Library server with no opt-in flag (DD-03)", () => {
  vi.stubEnv("GATES_LOCAL_E2E_LIBRARY", undefined);
  expect(e2eServerEntry(ROOT)).toBe(path.join(ROOT, "test/e2e/library-server.ts"));
});

it("a missing offline fixture refuses setup even when a production entry exists (DD-03)", () => {
  vi.stubEnv("GATES_LOCAL_E2E_LIBRARY", "1");
  const root = mkdtempSync(path.join(tmpdir(), "e2e-entry-")); roots.push(root);
  mkdirSync(path.join(root, "apps/server/src"), { recursive: true });
  writeFileSync(path.join(root, "apps/server/src/main.ts"), "throw new Error('production entry must not run');");
  expect(() => e2eServerEntry(root)).toThrow(/offline.*fixture|fixture.*missing/i);
});

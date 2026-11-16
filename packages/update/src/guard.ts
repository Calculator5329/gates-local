import { realpathSync } from "node:fs";
import path from "node:path";

export const TEST_ROOT_ENV = "GATES_LOCAL_UPDATE_TEST_ROOT";

export class UpdateGuardError extends Error {
  override readonly name = "UpdateGuardError";
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The test root when one is set, resolved; undefined outside tests. Throws under vitest without one. */
export function testRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env[TEST_ROOT_ENV];
  if (root === undefined || root === "") {
    if (env["VITEST"] !== undefined) throw new UpdateGuardError(`refused: a test ran the updater without ${TEST_ROOT_ENV}`);
    return undefined;
  }
  return real(root);
}

export function inside(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Keeps the updater's tests off a real checkout: with a test root set, a
 * command runs only in that folder or inside it (links resolved); under vitest
 * without one, every command is refused. Outside tests it does nothing.
 */
export function guardTarget(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = testRoot(env);
  if (root === undefined) return;
  const target = real(dir);
  if (!inside(root, target)) throw new UpdateGuardError(`refused: ${target} is outside the test root ${root}`);
}

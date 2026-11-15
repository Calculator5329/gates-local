// The one safety catch between the updater's tests and a real checkout.
//
// The updater fast-forwards, resets and rebuilds a git clone. A test that
// pointed it at the developer's own checkout could reset that checkout, so
// every command the updater runs (git and pnpm alike, see run.ts) first
// passes through guardTarget:
//
// - With GATES_LOCAL_UPDATE_TEST_ROOT set, the folder a command runs in must
//   be that folder or inside it (after resolving links), or the command is
//   refused before anything starts.
// - Under vitest (VITEST is set) with no test root, every command is refused:
//   a test that forgot to set the root fails instead of reaching a checkout.
//
// Outside tests neither variable is set and the guard does nothing.
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

/** True when dir is root or inside it. */
export function inside(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Throws unless a command may run in dir (see the file comment). */
export function guardTarget(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = testRoot(env);
  if (root === undefined) return;
  const target = real(dir);
  if (!inside(root, target)) throw new UpdateGuardError(`refused: ${target} is outside the test root ${root}`);
}

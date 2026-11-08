// Tests make scratch folders with os.tmpdir(); the vitest config points it
// under ~/.cache so a plain `pnpm test` never writes to /tmp.
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("os.tmpdir() is under ~/.cache in every test", () => {
  const rel = path.relative(path.join(homedir(), ".cache"), tmpdir());
  expect(rel.startsWith("..") || path.isAbsolute(rel)).toBe(false);
});

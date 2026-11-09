// Workers use their invocation's disposable scratch folder, wherever its
// caller placed the temp parent. The same rule holds on Windows.
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("os.tmpdir() is inside this invocation's run folder", () => {
  const root = process.env["TMPDIR"] ?? "";
  expect(path.basename(root)).toMatch(/^gates-local-test-run-/);
  const rel = path.relative(root, tmpdir());
  expect(rel.startsWith("..") || path.isAbsolute(rel)).toBe(false);
});

// Immutable offline import data, prepared once per backend worker.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function prepareLibraryFixture(parent = tmpdir()): string {
  const root = mkdtempSync(path.join(parent, "library-browser-"));
  const file = path.join(root, "sample.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE albums (title TEXT); INSERT INTO albums VALUES ('Fixture album');"); db.close();
  const seed = path.join(root, "seed"); mkdirSync(seed);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: seed, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-global") } });
  git("init", "--quiet"); git("config", "user.name", "Library fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(path.join(seed, "README.md"), "A small public documentation fixture"); git("add", "."); git("commit", "--quiet", "-m", "Fixture");
  const bare = path.join(root, "fixture.git"); git("clone", "--bare", seed, bare);
  
  return root;
}

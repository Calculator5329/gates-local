// E2E entry with explicit transports. Production main has no environment switch
// that can replace the pinned samples or allow a local repository URL.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { main } from "../../apps/server/src/main.ts";
import { SAMPLES } from "../../apps/server/src/sources/samples.ts";
import { runGit } from "../../apps/server/src/sources/clone.ts";

const root = mkdtempSync(path.join(tmpdir(), "library-browser-"));
const file = path.join(root, "sample.db");
const db = new DatabaseSync(file);
db.exec("CREATE TABLE albums (title TEXT); INSERT INTO albums VALUES ('Fixture album');"); db.close();
const bytes = readFileSync(file);
const samples = SAMPLES.map(s => ({ ...s, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
const seed = path.join(root, "seed"); mkdirSync(seed);
const git = (...args: string[]) => execFileSync("git", args, { cwd: seed, stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-global") } });
git("init", "--quiet"); git("config", "user.name", "Library fixture"); git("config", "user.email", "fixture@example.test");
writeFileSync(path.join(seed, "README.md"), "A small public documentation fixture"); git("add", "."); git("commit", "--quiet", "-m", "Fixture");
const bare = path.join(root, "fixture.git"); git("clone", "--bare", seed, bare);
let northwindAttempts = 0;
let failedClone = false;
await main({ imports: {
  samples,
  fetch: async (input, init) => {
    const url = String(input);
    if (url.includes("northwind") && northwindAttempts++ === 0) throw new TypeError("fetch failed");
    // Enough time for a screenshot burst and cancel, without a public request.
    return new Response(new ReadableStream({
      async start(controller) {
        try {
          for (let offset = 0; offset < bytes.length; offset += 512) {
            await setTimeout(200, undefined, { signal: init?.signal ?? undefined });
            controller.enqueue(bytes.subarray(offset, offset + 512));
          }
          controller.close();
        } catch (e) { controller.error(e); }
      },
    }));
  },
  git: async call => {
    if (call.args.includes("clone")) await setTimeout(1800, undefined, { signal: call.signal });
    if (!failedClone && call.args.includes("https://github.com/example/retry-failed")) { failedClone = true; throw new Error("This repository is unavailable. Retry."); }
    return runGit({ ...call, args: ["-c", "protocol.file.allow=always", ...call.args.map(a => a.startsWith("https://github.com/") ? `file://${bare}` : a)], env: { ...call.env, GIT_ALLOW_PROTOCOL: "file" } });
  },
} });

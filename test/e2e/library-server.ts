// E2E entry with explicit transports. Production main has no environment switch
// that can replace the pinned samples or allow a local repository URL.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { main } from "../../apps/server/src/main.ts";
import { SAMPLES } from "../../apps/server/src/sources/samples.ts";
import { runGit } from "../../apps/server/src/sources/clone.ts";

const root = process.env["GL_E2E_LIBRARY_FIXTURE"];
if (!root) throw new Error("The offline Library fixture must be prepared by the test stack.");
const bytes = readFileSync(path.join(root, "sample.db"));
const samples = SAMPLES.map(s => ({ ...s, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
const bare = path.join(root, "fixture.git");
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

// Child process for the kill-mid-write test in src/usage/store.test.ts. Run
// with plain `node` (type stripping): node usage-crash-writer.ts <file>.
// Records requests across a few models and hours as fast as it can, prints
// "ready" once some are on disk, and keeps writing until the parent SIGKILLs it.

import { openUsageStore } from "../src/usage/store.ts";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: usage-crash-writer.ts <file>\n");
  process.exit(2);
}
setTimeout(() => process.exit(3), 10_000).unref();

let t = Date.UTC(2026, 10, 1);
const usage = openUsageStore(file, { now: () => t });
let n = 0;
const step = (): void => {
  for (let i = 0; i < 50; i++, n++) {
    t += 97_000;
    usage.record(`model-${n % 9}:1`, { promptTokens: 10, completionTokens: 1 }, true);
  }
  if (n === 200) process.stdout.write("ready\n");
  setImmediate(step);
};
step();

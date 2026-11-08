import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests make their scratch folders with os.tmpdir(). Point it under ~/.cache,
// so a plain `pnpm test` never writes to /tmp. TEMP and TMP are what Windows reads.
const TEST_TMP = path.join(homedir(), ".cache", "gates-local-test-tmp");
mkdirSync(TEST_TMP, { recursive: true });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    env: { TMPDIR: TEST_TMP, TEMP: TEST_TMP, TMP: TEST_TMP },
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts", "packages/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    // Many tests start real Git and child processes. On a busy machine those
    // miss the 5s default without anything being wrong. This only limits hangs:
    // a test about speed has to assert its own measured time.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

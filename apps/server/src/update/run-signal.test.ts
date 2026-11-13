// Ctrl+C can arrive the moment a command starts. The stop-signal handling has
// to be in place before the command exists, or the signal ends the updater by
// its default action and the command's group is left running.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Repos, makeRepos, removeRepos, testEnv } from "./testing.ts";

const atSpawn: number[] = [];
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof real.spawn>) => {
    atSpawn.push(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP"));
    return real.spawn(...args);
  }) as typeof real.spawn;
  return { ...real, spawn };
});

let r: Repos;
beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
  atSpawn.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  removeRepos(r);
});

it.skipIf(process.platform === "win32")("listens for Ctrl+C before a command starts, and stops listening when it ends", async () => {
  const { realRunner } = await import("./run.ts");
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP")];
  const result = await realRunner("sh", ["-c", "true"], { cwd: r.clone });
  expect(result.code).toBe(0);
  expect(atSpawn).toEqual(before.map(count => count + 1));
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"), process.listenerCount("SIGHUP")]).toEqual(before);
});

it.skipIf(process.platform === "win32")("stops listening when a command cannot start", async () => {
  const { realRunner } = await import("./run.ts");
  const before = process.listenerCount("SIGINT");
  const result = await realRunner("gates-no-such-command", [], { cwd: r.clone });
  expect(result.failure).toBe("not-found");
  expect(atSpawn[0]).toBe(before + 1);
  expect(process.listenerCount("SIGINT")).toBe(before);
});

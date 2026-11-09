// Real DownloadTab ownership and session actions over the in-memory wire.
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, tick, until, type Browser } from "./harness.ts";

const hooks = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.states)) hooks.states[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.states[i], (next: unknown) => { hooks.states[i] = typeof next === "function" ? next(hooks.states[i]) : next; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock("../src/store.ts", async original => {
  const actual = await original<typeof import("../src/store.ts")>();
  return { ...actual, useStore: <T>(select: (s: ReturnType<typeof actual.getState>) => T) => select(actual.getState()) };
});

let browser: Browser;
let store: typeof import("../src/store.ts");
let DownloadTab: typeof import("../src/ModelDownloads.tsx")["DownloadTab"];
let disconnect: (() => void) | undefined;
const name = "qwen3.5:latest";
const model = { ...methodSamples["models.list"].result[0]!, name };
beforeEach(async () => {
  browser = installBrowser(); vi.resetModules(); hooks.states = []; hooks.effects = [];
  const session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  DownloadTab = (await import("../src/ModelDownloads.tsx")).DownloadTab;
  disconnect = session.connect();
  await until(() => store.getState().hydrationSettled);
  store.setState({ models: [], pulls: {}, catalog: [{ name, label: "Review", purpose: "Review", downloadBytes: 100, recommended: false, installed: false }] });
  browser.server.answer("models.pull", ({ name: tag }) => ({ name: tag, state: "queued", completedBytes: 0 }));
});
afterEach(async () => {
  disconnect?.(); browser.server.accepting = false;
  for (const socket of browser.server.sockets) socket.close();
  await tick(); vi.unstubAllGlobals();
});

function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
interface Actions {
  start(name: string): Promise<boolean>;
  cancel(name: string): void;
  error(name: string): string | null;
}
function isActions(a: unknown): a is Actions {
  return typeof a === "object" && a !== null && "start" in a && typeof a.start === "function" && "cancel" in a && typeof a.cancel === "function" && "error" in a && typeof a.error === "function";
}
function actions(): Actions {
  hooks.cursor = 0; hooks.effects = [];
  const tree = DownloadTab();
  for (const effect of hooks.effects) effect();
  const a = nodes(tree).find(n => n.props.actions)?.props.actions;
  if (!isActions(a)) throw new Error("Missing download actions");
  return a;
}
async function refuse(message: string) {
  const held = browser.server.hold("models.pull");
  const pending = actions().start(name);
  (await held).fail("internal", message);
  expect(await pending).toBe(false);
}

it("FR-04 keeps a disconnected custom failure for an already installed alias", async () => {
  store.setState({ models: [model], catalog: [{ name, label: "Review", purpose: "Review", downloadBytes: 100, recommended: false, installed: true }] });
  disconnect?.(); await tick();
  expect(await actions().start("  QWEN3.5  ")).toBe(false);
  expect(actions().error("qwen3.5")).toEqual(expect.any(String));
  // A refresh of the same installation is not evidence of a successful retry.
  store.setState({ models: [{ ...model }] });
  expect(actions().error(name)).toEqual(expect.any(String));
  store.setState({ models: [{ ...model, digest: "new-installation" }] });
  expect(actions().error(name)).toBeNull();
});

for (const state of ["cancelled", "error", "queued"] as const) {
  it(`FR-05 keeps a restart failure after a late ${state} push`, async () => {
    expect(await actions().start(name)).toBe(true);
    actions().cancel(name); await tick();
    await refuse("Restart refused");
    expect(actions().error(name)).toContain("Restart refused");
    browser.server.push("models.pull", { name, state, completedBytes: 0 });
    await tick();
    expect(actions().error("QWEN3.5")).toContain("Restart refused");
    browser.server.push("models.pull", { name, state: "downloading", completedBytes: 8, totalBytes: 16 });
    await tick();
    expect(actions().error(name)).toBeNull();
  });
}

it("FR-08 keeps a refused pending retry after old progress, then clears it on a real successful retry", async () => {
  expect(await actions().start(name)).toBe(true);
  actions().cancel(name); await tick();
  const held = browser.server.hold("models.pull");
  const retry = actions().start(name);
  const request = await held;
  for (const state of ["downloading", "verifying"] as const) {
    browser.server.push("models.pull", { name, state, completedBytes: 8, totalBytes: 16 });
    await tick(); actions(); // Run the actual retirement effect before the RPC answers.
  }
  request.fail("internal", "Pending retry refused");
  expect(await retry).toBe(false);
  expect(actions().error(name)).toContain("Pending retry refused");
  const accepted = browser.server.hold("models.pull");
  const success = actions().start(name);
  (await accepted).respond({ name, state: "queued", completedBytes: 0 });
  expect(await success).toBe(true);
  browser.server.push("models.pull", { name, state: "downloading", completedBytes: 12, totalBytes: 16 });
  await tick();
  expect(actions().error(name)).toBeNull();
});

// Exercise real Connect/session/store functions over the in-memory socket.
// React only supplies hook values and an element tree; no DOM or mic is used.
import { type ReactNode, isValidElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

let b: Browser;
let session: typeof import("../src/session.ts");
let store: typeof import("../src/store.ts");
let VoiceSettings: typeof import("../src/VoiceSettings.tsx")["VoiceSettings"];
let stop: () => void;
const settings = { ...methodSamples["settings.get"].result, whisperUrl: "http://127.0.0.1:18078" };
const disconnected = { ...settings, whisperUrl: undefined };

function connectButton(node: ReactNode): (() => unknown) | undefined {
  if (Array.isArray(node)) return node.map(connectButton).find((click) => click !== undefined);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => unknown }>(node)) return undefined;
  if (node.type === "button" && node.props.children === "Connect") return node.props.onClick;
  return connectButton(node.props.children);
}

function startConnect() {
  const click = connectButton(VoiceSettings());
  expect(click).toBeTypeOf("function"); click?.();
}

beforeEach(async () => {
  b = installBrowser(); vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  ({ VoiceSettings } = await import("../src/VoiceSettings.tsx"));
  b.server.answer("settings.get", () => settings);
  // Successful saves push their real provenance, so a bad reconnect by A
  // would be replayed after B's Disconnect and leave dictation connected.
  b.server.answer("settings.update", (patch) => {
    const next = { ...settings, whisperUrl: patch.whisperUrl ?? undefined };
    b.server.push("settings.changed", { ...next, voiceChange: patch.voiceChange });
    return next;
  });
  stop = session.connect();
  await until(() => store.getState().imageStatus !== undefined, 2000, "boot"); await tick();
});

afterEach(async () => {
  stop?.(); b.server.accepting = false;
  for (const socket of b.server.sockets) socket.close();
  await tick(); vi.unstubAllGlobals();
});

it.each(["before", "after"].flatMap((order) => [true, false].map((tagged) => ({ order, tagged }))))("VF-01: Connect started $order a buffered foreign Disconnect (tagged=$tagged) respects receipt order", async ({ order, tagged }) => {
  const models = b.server.hold("models.list");
  b.server.socket.close();
  const hydration = await models;
  const healthRequest = b.server.hold("voice.check");
  if (order === "before") startConnect();
  b.server.push("settings.changed", { ...disconnected, ...(tagged ? { voiceChange: "window-b-disconnect" } : {}) });
  expect(store.getState().settings).toMatchObject(settings);
  if (order === "after") startConnect();
  const health = await healthRequest;
  const version = store.getState().voiceConnectionVersion;
  if (order === "before") {
    health.respond(methodSamples["voice.check"].result); await tick();
    expect(b.server.calls("settings.update")).toHaveLength(0);
  }
  hydration.respond(methodSamples["models.list"].result); await tick();
  expect(store.getState().voiceConnectionVersion).toBe(version);
  if (order === "after") {
    health.respond(methodSamples["voice.check"].result); await tick();
    expect(b.server.calls("settings.update")).toHaveLength(1);
  }
  expect(b.server.calls("settings.update")).toHaveLength(order === "before" ? 0 : 1);
  const savedSettings = store.getState().settings;
  expect(savedSettings).toMatchObject(methodSamples["settings.get"].result);
  expect(savedSettings === store.NA ? undefined : savedSettings?.whisperUrl).toBe(order === "before" ? undefined : settings.whisperUrl);
});

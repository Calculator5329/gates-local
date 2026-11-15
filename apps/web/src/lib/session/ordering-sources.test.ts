// The Library's list and its imports at the client boundary: a read answered with number n that
// lands after a push numbered n+1 must not undo the push, and an import's progress reaches the
// window by push, with no read repeated on a timer.
import { afterEach, expect, it, vi } from "vitest";
import type { MethodName, Params, Source, SourceImports, SyncDomain, SyncMetadata } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { installBrowser, type FakeServer, type FakeSocket } from "../../../test/harness.ts";
import { drain } from "../../../test/ordering-world.ts";

const EPOCH = "sources-process";
const SERVES: readonly SyncDomain[] = ["settings", "sources"];
const older: Source = { ...methodSamples["sources.list"].result[0]!, id: "s-old", label: "Read before the push" };
const newer: Source = { ...older, id: "s-new", label: "Pushed after the read began" };
const job = { id: "i1", key: "chinook", label: "Chinook", kind: "sample", state: "downloading", total: 2048 } as const;
const imports = (bytes: number): SourceImports => ({ samples: [], jobs: [{ ...job, bytes }] });

type Request = Parameters<FakeServer["handle"]>[1];
type Scope = "settings" | "sources" | "source-imports";
interface Slow { respond(result: unknown, rev: number): void }
const sync = (scope: Scope, rev: number): SyncMetadata => ({ epoch: EPOCH, changes: [{ scope, kind: "snapshot", rev }] });
const domain = (scope: Scope): SyncDomain => scope === "settings" ? "settings" : "sources";

/** The fake server, numbering what the real one numbers on a connection that ordered it. */
function numbering(server: FakeServer) {
  let ordered: readonly SyncDomain[] = [];
  const slow = new Map<MethodName, (slow: Slow) => void>();
  const reply = (socket: FakeSocket, request: Request, result: unknown, scope: "settings" | "sources" | "source-imports", rev: number) =>
    socket.frame({ type: "response", id: request.id, ok: true, result, ...(ordered.includes(domain(scope)) ? { sync: sync(scope, rev) } : {}) });
  const scopes: Partial<Record<MethodName, "settings" | "sources" | "source-imports">> = { "settings.get": "settings", "sources.list": "sources", "sources.imports": "source-imports" };
  const base = server.handle.bind(server);
  server.handle = (socket, request) => {
    if (request.method === "sync.negotiate") {
      server.log.push(request);
      ordered = SERVES.filter(d => (request.params as Params<"sync.negotiate">).ordered.includes(d));
      socket.frame({ type: "response", id: request.id, ok: true, result: { epoch: EPOCH, ordered } });
      return;
    }
    const scope = scopes[request.method];
    if (scope === undefined) return base(socket, request);
    server.log.push(request);
    const held = slow.get(request.method);
    slow.delete(request.method);
    const result = request.method === "sources.list" ? [older] : request.method === "sources.imports" ? imports(0) : methodSamples["settings.get"].result;
    if (held) held({ respond: (value, rev) => reply(socket, request, value, scope, rev) });
    else reply(socket, request, result, scope, 0);
  };
  return {
    /** The next call of `method` waits for the test. */
    hold: (method: MethodName) => new Promise<Slow>(resolve => slow.set(method, resolve)),
    push: (channel: "sources.changed" | "sources.imports", payload: unknown, rev: number) => {
      const scope = channel === "sources.changed" ? "sources" : "source-imports";
      server.socket.frame({ type: "push", channel, payload, ...(ordered.includes(domain(scope)) ? { sync: sync(scope, rev) } : {}) });
    },
  };
}

async function boot() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const browser = installBrowser();
  const server = numbering(browser.server);
  vi.resetModules();
  const session = await import("./index.ts");
  const store = await import("../store/store.ts");
  return { browser, server, session, store };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("a slow Library list answer never undoes a newer list push", async () => {
  const { browser, server, session, store } = await boot();
  const listing = server.hold("sources.list");
  const close = session.connect();
  const slow = await listing;
  server.push("sources.changed", [newer], 1);
  await drain();
  slow.respond([older], 0);
  await drain();
  expect(store.getState().sources).toEqual([newer]);
  expect(browser.server.calls("sources.list")).toHaveLength(1);
  close();
});

it("an import's progress arrives by push, and a slow read of the imports never undoes it", async () => {
  const { browser, server, session, store } = await boot();
  const reading = server.hold("sources.imports");
  const close = session.connect();
  const slow = await reading;
  server.push("sources.imports", imports(512), 1);
  await drain();
  slow.respond(imports(0), 0);
  await drain();
  expect(store.getState().sourceImports).toEqual(imports(512));
  server.push("sources.imports", imports(1024), 2);
  await drain();
  expect(store.getState().sourceImports).toEqual(imports(1024));
  await vi.advanceTimersByTimeAsync(3000);
  expect(browser.server.calls("sources.imports")).toHaveLength(1);
  close();
});

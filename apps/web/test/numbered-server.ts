// The fake server numbering ordered data the way the real one does, for the window's boundary
// tests: a read answers with the number its thing had when the read was handled (so a held read
// delivered late carries an old number), an action that changes the thing answers with a new
// number, and a push takes the next number. A kind the real socket numbers itself (the models
// kind) takes the next number at every read as it is handled, as the socket server does. Only on
// a connection that ordered the kind.
import { SENT_IN_ORDER, methodSync, pushSync, scopesOf, type Channel, type MethodName, type Params, type Payload, type SyncDomain, type SyncMetadata, type SyncRow } from "@gates-local/contracts";
import type { FakeServer, FakeSocket } from "./harness.ts";

type Request = Parameters<FakeServer["handle"]>[1];

export interface Numbering {
  /** Push `payload` on `channel` as a new value of its thing: the next number, when ordered. */
  push<C extends Channel>(channel: C, payload: Payload<C>): void;
  /** The next number a push on `channel` carries, taken now, for a test that frames the push to one socket itself; undefined when not ordered. */
  stamp<C extends Channel>(channel: C): SyncMetadata | undefined;
  /** The domains the last negotiation ordered. */
  ordered(): readonly SyncDomain[];
}

/**
 * `serves`: the domains this fake numbers when a window asks for them, on top of any the server
 * underneath already numbers (it answers the negotiation first; its epoch is kept). `commits`:
 * methods whose answer is a new value of their thing (an action), not a read of the current one.
 */
export function numberServer(server: FakeServer, options: { serves: readonly SyncDomain[]; commits?: readonly MethodName[] }): Numbering {
  let ordered: readonly SyncDomain[] = [];
  let epoch = "";
  const revs = new Map<string, number>();
  const sync = (row: SyncRow, rev: number): SyncMetadata => ({ epoch, changes: [{ scope: row.scope, kind: "snapshot", rev }] });
  /** A kind the real socket numbers itself (SENT_IN_ORDER): every read takes the next numbers as it is handled. */
  const take = (row: SyncRow): SyncMetadata => ({ epoch, changes: scopesOf(row).map(scope => {
    const rev = (revs.get(scope) ?? 0) + 1;
    revs.set(scope, rev);
    return { scope, kind: "snapshot" as const, rev };
  }) });
  const numbered = (row: SyncRow | undefined): row is SyncRow => row !== undefined && options.serves.includes(row.domain) && ordered.includes(row.domain);
  const base = server.handle.bind(server);
  server.handle = (socket: FakeSocket, request: Request) => {
    if (request.method === "sync.negotiate") {
      const asked = (request.params as Params<"sync.negotiate">).ordered;
      const merging = Object.create(socket) as FakeSocket;
      merging.frame = (value: unknown) => {
        const frame = value as { ok?: boolean; result?: { epoch: string; ordered: readonly SyncDomain[] } };
        if (frame.ok !== true || frame.result === undefined) return socket.frame(value);
        epoch = frame.result.epoch;
        ordered = [...new Set([...frame.result.ordered, ...options.serves.filter(d => asked.includes(d))])];
        socket.frame({ ...frame, result: { epoch, ordered } });
      };
      base(merging, request);
      return;
    }
    const row = methodSync(request.method);
    if (!numbered(row)) return base(socket, request);
    if (SENT_IN_ORDER.includes(row.domain)) {
      const taken = take(row);
      const stamped = Object.create(socket) as FakeSocket;
      stamped.frame = (value: unknown) => {
        const frame = value as { type?: string; ok?: boolean };
        socket.frame(frame.type === "response" && frame.ok === true ? { ...frame, sync: taken } : value);
      };
      base(stamped, request);
      return;
    }
    const commits = options.commits?.includes(request.method) === true;
    const read = revs.get(row.scope) ?? 0;
    // The answer goes out whenever the test lets it (a hold), with the number fixed now for a read.
    const stamping = Object.create(socket) as FakeSocket;
    stamping.frame = (value: unknown) => {
      const frame = value as { type?: string; ok?: boolean };
      if (frame.type !== "response" || frame.ok !== true) return socket.frame(value);
      const rev = commits ? (revs.get(row.scope) ?? 0) + 1 : read;
      if (commits) revs.set(row.scope, rev);
      socket.frame({ ...frame, sync: sync(row, rev) });
    };
    base(stamping, request);
  };
  const stamp = (channel: Channel): SyncMetadata | undefined => {
    const row = pushSync(channel);
    if (!numbered(row)) return undefined;
    const rev = (revs.get(row.scope) ?? 0) + 1;
    revs.set(row.scope, rev);
    return sync(row, rev);
  };
  return {
    push(channel, payload) {
      const stamped = stamp(channel);
      if (stamped === undefined) server.push(channel, payload);
      else server.push(channel, payload, stamped);
    },
    stamp,
    ordered: () => ordered,
  };
}

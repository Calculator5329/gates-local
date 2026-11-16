// The update status is ordered data: every status the module announces, and every answer of the
// update methods (the read and the three actions), carries the number it was committed with.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClient, type SocketLike, type SyncChange, type SyncMetadata, type UpdateStatus } from "@gates-local/contracts";
import { WebSocket } from "ws";
import { type Repos, commit, fakePnpm, makeRepos, publish, removeRepos, testEnv } from "@gates-local/update/testing";
import { writeRecord } from "@gates-local/update/record";
import { startWsServer, type HandlerContext, type WsServer } from "../ws/server.ts";
import { createUpdateHandlers, createUpdateModule } from "./module.ts";

let r: Repos;
const cleanup: Array<() => unknown> = [];
beforeEach(() => {
  r = makeRepos();
  for (const [k, v] of Object.entries(testEnv(r.base))) vi.stubEnv(k, v);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  vi.unstubAllEnvs();
  removeRepos(r);
});

const revs = (changes: readonly SyncChange[] | undefined) => changes?.map(change => change.kind === "snapshot" ? [change.scope, change.rev] : change);
async function captured<T>(run: (ctx: HandlerContext) => T | Promise<T>): Promise<{ value: T; changes: readonly SyncChange[] | undefined }> {
  let changes: readonly SyncChange[] | undefined;
  const value = await run({ clientId: 1, capture: c => { changes = c; } });
  return { value, changes };
}

it("every status the module announces is numbered, and each update answer carries the number of the status it holds", async () => {
  commit(r.seed, "A newer change"); publish(r.seed);
  writeRecord(r.data, { at: 5, outcome: "updated", to: { commit: "a".repeat(40), label: "v0.2.0" }, changes: 3 });
  const announced: Array<[string | undefined, number]> = [];
  const update = createUpdateModule({
    root: r.clone, dataDir: r.data, runner: fakePnpm().runner, everyChange: () => true,
    changed: (status, change) => announced.push([status.lastCheck?.state, change.kind === "snapshot" ? change.rev : -1]),
  });
  cleanup.push(() => update.close());
  const handlers = createUpdateHandlers(update);

  const first = await captured(ctx => handlers["update.status"]({}, ctx));
  expect(revs(first.changes)).toEqual([["update", 0]]);
  expect(first.value.canControl).toBe(true);
  const again = await captured(ctx => handlers["update.status"]({}, ctx));
  expect(revs(again.changes), "nothing changed, so the same number").toEqual([["update", 0]]);

  const checked = await captured(ctx => handlers["update.check"]({}, ctx));
  expect(checked.value.lastCheck?.state).toBe("available");
  expect(revs(checked.changes), "the check's answer is the status it left").toEqual([["update", 1]]);
  const dismissed = await captured(ctx => handlers["update.dismissResult"]({}, ctx));
  expect(dismissed.value.result).toBeNull();
  expect(revs(dismissed.changes)).toEqual([["update", 2]]);
  expect(announced).toEqual([["available", 1], ["available", 2]]);
  // A copy is not what was given out: it has no number.
  expect(() => update.stamp({ ...update.status() })).toThrow(/not committed/);
});

it("a clone's Download is refused with its reason, not answered with a status that hides it", async () => {
  const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: fakePnpm().runner, everyChange: () => true });
  cleanup.push(() => update.close());
  await expect(createUpdateHandlers(update)["update.download"]({}, { clientId: 1 })).rejects.toThrow(/nothing to download here/);
});

it("the socket server refuses an unnumbered status push", async () => {
  let server: WsServer | undefined;
  const update = createUpdateModule({ root: r.clone, dataDir: r.data, runner: fakePnpm().runner, everyChange: () => true, changed: (status, change) => server?.push("update.changed", status, [change]) });
  cleanup.push(() => update.close());
  server = await startWsServer({ port: 0, token: "fixture", allowedOrigins: [], handlers: createUpdateHandlers(update) as never });
  cleanup.push(() => server?.close());
  const client = createClient(new WebSocket(`ws://127.0.0.1:${server.port}/?token=fixture`) as unknown as SocketLike);
  cleanup.push(() => client.close());
  expect(await client.negotiate()).toMatchObject({ epoch: expect.any(String) });
  const pushes: Array<{ check: string | undefined; sync: SyncMetadata | undefined }> = [];
  client.subscribe("update.changed", (status: UpdateStatus, sync) => pushes.push({ check: status.lastCheck?.state, sync }));

  let readSync: SyncMetadata | undefined;
  await client.call("update.status", {}, { onMetadata: sync => { readSync = sync; } });
  expect(revs(readSync?.changes)).toEqual([["update", 0]]);
  let checkSync: SyncMetadata | undefined;
  await client.call("update.check", {}, { onMetadata: sync => { checkSync = sync; } });
  expect(revs(checkSync?.changes)).toEqual([["update", 1]]);
  await vi.waitFor(() => expect(pushes).toHaveLength(1));
  expect(pushes[0]?.sync).toEqual({ epoch: readSync?.epoch, changes: [{ scope: "update", kind: "snapshot", rev: 1 }] });

  expect(() => server?.push("update.changed", update.status())).toThrow(/did not capture update metadata/);
});

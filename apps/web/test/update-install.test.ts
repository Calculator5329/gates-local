// An update whose start throws is an error the person sees, never a quiet success.
import { expect, it, vi } from "vitest";
import type { UpdateStatus } from "@gates-local/contracts";
import type { ActionCall } from "../src/session/connection.ts";
import { installUpdate } from "../src/update-install.ts";

const OFFERED: UpdateStatus = {
  version: { kind: "commit", commit: "abc1234", date: 1 },
  result: null,
  lastCheck: { state: "available", checkedAt: 1, channel: "main", current: "abc1234", target: "bbbbbbb", targetCommit: "b".repeat(40), total: 1, changes: ["B"] },
  approval: "approval-b",
  activity: [],
};

it("a start that throws returns and shows Couldn't start the update, and releases the reservation", async () => {
  const calls: string[] = [];
  const act = (async (method: string) => {
    calls.push(method);
    if (method === "update.status") return { ok: true, value: OFFERED };
    if (method === "update.prepare") return { ok: true, value: { state: "ready", reservation: "reservation-b", target: "b".repeat(40) } };
    if (method === "update.cancel") return { ok: true, value: { cancelled: true } };
    throw new Error(`unexpected ${method}`);
  }) as unknown as ActionCall;
  const start = vi.fn(async () => { throw new Error("spawn ENOENT"); });
  const applied: Record<string, unknown>[] = [];
  const result = await installUpdate(act, start, "b".repeat(40), (patch) => { applied.push(patch as Record<string, unknown>); }, "approval-b");
  expect(start).toHaveBeenCalledWith({ reservation: "reservation-b", target: "b".repeat(40) });
  expect(result).toContain("Couldn't start the update (spawn ENOENT)");
  expect(applied.at(-1)).toEqual({ updateInstalling: false, updateError: result });
  expect(calls).toEqual(["update.status", "update.prepare", "update.cancel"]);
});

const READY: UpdateStatus = {
  version: { kind: "installed", version: "1.2.3" },
  result: null,
  lastCheck: { state: "newer", checkedAt: 1, current: "1.2.3", target: "1.3.0", forThisCopy: true, lines: ["Version 1.3.0 is downloaded and checked."], page: "https://example.invalid/latest", download: "ready", restart: true },
  approval: "approval-i",
  activity: [],
};
const PINNED = `1.3.0:${"c".repeat(128)}`;

it("UW-05 an installed copy reserves the version-and-list target the server pinned and hands exactly that to the desktop app", async () => {
  const calls: string[] = [];
  const act = (async (method: string, params: unknown) => {
    calls.push(method);
    if (method === "update.status") return { ok: true, value: READY };
    if (method === "update.prepare") { expect(params).toEqual({ approval: "approval-i" }); return { ok: true, value: { state: "ready", reservation: "reservation-i", target: PINNED } }; }
    throw new Error(`unexpected ${method}`);
  }) as unknown as ActionCall;
  const start = vi.fn(async () => ({ ok: true as const }));
  expect(await installUpdate(act, start, "1.3.0", () => undefined, "approval-i")).toBeNull();
  expect(start).toHaveBeenCalledWith({ reservation: "reservation-i", target: PINNED });
  // No check: the approval came with the checked download.
  expect(calls).toEqual(["update.status", "update.prepare"]);
});

it("UW-05 an installed copy whose reservation names another version starts nothing and releases it", async () => {
  const calls: string[] = [];
  const act = (async (method: string) => {
    calls.push(method);
    if (method === "update.status") return { ok: true, value: READY };
    if (method === "update.prepare") return { ok: true, value: { state: "ready", reservation: "reservation-i", target: `1.4.0:${"c".repeat(128)}` } };
    if (method === "update.cancel") return { ok: true, value: { cancelled: true } };
    throw new Error(`unexpected ${method}`);
  }) as unknown as ActionCall;
  const start = vi.fn(async () => ({ ok: true as const }));
  expect(await installUpdate(act, start, "1.3.0", () => undefined, "approval-i")).toContain("changed");
  expect(start).not.toHaveBeenCalled();
  expect(calls).toEqual(["update.status", "update.prepare", "update.cancel"]);
});

it("UW-05 an installed copy that cannot restart says the server's words and asks nothing", async () => {
  const refused: UpdateStatus = { ...READY, approval: undefined, lastCheck: { ...READY.lastCheck as Extract<NonNullable<UpdateStatus["lastCheck"]>, { state: "newer" }>, restart: undefined, lines: ["Gates Local cannot replace its own file because its folder is read-only."] } };
  const act = (async (method: string) => {
    if (method === "update.status") return { ok: true, value: refused };
    throw new Error(`unexpected ${method}`);
  }) as unknown as ActionCall;
  const start = vi.fn(async () => ({ ok: true as const }));
  expect(await installUpdate(act, start, "1.3.0", () => undefined)).toBe("Gates Local cannot replace its own file because its folder is read-only.");
  expect(start).not.toHaveBeenCalled();
});

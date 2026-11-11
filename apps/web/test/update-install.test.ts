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
    if (method === "update.prepare") return { ok: true, value: { state: "ready", reservation: "reservation-b", targetCommit: "b".repeat(40) } };
    if (method === "update.cancel") return { ok: true, value: { cancelled: true } };
    throw new Error(`unexpected ${method}`);
  }) as unknown as ActionCall;
  const start = vi.fn(async () => { throw new Error("spawn ENOENT"); });
  const applied: Record<string, unknown>[] = [];
  const result = await installUpdate(act, start, "b".repeat(40), (patch) => { applied.push(patch as Record<string, unknown>); }, "approval-b");
  expect(start).toHaveBeenCalledWith({ reservation: "reservation-b", targetCommit: "b".repeat(40) });
  expect(result).toContain("Couldn't start the update (spawn ENOENT)");
  expect(applied.at(-1)).toEqual({ updateInstalling: false, updateError: result });
  expect(calls).toEqual(["update.status", "update.prepare", "update.cancel"]);
});

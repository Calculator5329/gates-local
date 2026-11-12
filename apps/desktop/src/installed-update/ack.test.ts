// The token launch's ack (rows L2 and B4): only this token's ready counts,
// and the wait ends on the ack, on the launch's exit, or at the time limit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ackFile, readAck, waitForAck, writeAck } from "./ack.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dataDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "iu-ack-"));
  roots.push(root);
  mkdirSync(path.join(root, "updates"));
  return root;
}
const record = { pid: 4242, start: "s", uptime: 1 };

describe("ack", () => {
  it("AK-01 only the ack carrying this token is ready", () => {
    const dir = dataDir();
    expect(readAck(dir, "T1")).toBe(false);
    writeAck(dir, "T1");
    expect(readAck(dir, "T1")).toBe(true);
    expect(readAck(dir, "T2")).toBe(false);
    writeFileSync(ackFile(dir), '{"token":"T1","sta');
    expect(readAck(dir, "T1")).toBe(false);
    writeFileSync(ackFile(dir), JSON.stringify({ token: "T1", state: "failed" }));
    expect(readAck(dir, "T1")).toBe(false);
  });

  it("AK-02 the wait ends ready on the ack, exited when the launch ends first, timeout at the limit", async () => {
    const dir = dataDir();
    let clock = 0;
    const timing = { now: () => clock, sleep: async (ms: number) => { clock += ms; } };
    // The ack appears on the third look.
    let looks = 0;
    const ready = await waitForAck({ dataDir: dir, token: "T1", record, timeoutMs: 60_000, ...timing, treeGone: () => { if (++looks === 3) writeAck(dir, "T1"); return false; } });
    expect(ready).toBe("ready");
    expect(await waitForAck({ dataDir: dir, token: "T2", record, timeoutMs: 60_000, ...timing, treeGone: () => true })).toBe("exited");
    clock = 0;
    expect(await waitForAck({ dataDir: dir, token: "T3", record, timeoutMs: 60_000, ...timing, treeGone: () => false })).toBe("timeout");
    expect(clock).toBeGreaterThanOrEqual(60_000);
    expect(clock).toBeLessThan(60_200);
  });

  it("AK-03 an ack written just before the launch ended still counts as ready", async () => {
    const dir = dataDir();
    const result = await waitForAck({ dataDir: dir, token: "T1", record, timeoutMs: 60_000, now: () => 0, sleep: async () => undefined, treeGone: () => { writeAck(dir, "T1"); return true; } });
    expect(result).toBe("ready");
  });
});

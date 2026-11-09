import { expect, it } from "vitest";
import { type SyncMetadata, decodeServerMessage, encodePush, encodeResult } from "../src/index.ts";

const sync: SyncMetadata = { epoch: "process-a", changes: [
  { scope: "settings", kind: "snapshot", rev: 0 },
  { scope: "thread:one", kind: "patch", baseRev: 1, rev: 2 },
  { scope: "fit:model:8192", kind: "invalidate", rev: Number.MAX_SAFE_INTEGER },
] };

it("round-trips optional metadata without changing response or push payloads", () => {
  const frames = [encodeResult("1", "threads.list", [], sync), encodePush("threads.changed", { threadId: "one" }, sync)];
  for (const frame of frames) {
    if (!frame.ok) throw frame.error;
    const decoded = decodeServerMessage(frame.value);
    expect(decoded.ok && decoded.value.sync).toEqual(sync);
  }
  const plain = encodeResult("1", "threads.list", []);
  expect(plain).toEqual({ ok: true, value: '{"type":"response","id":"1","ok":true,"result":[]}' });
  expect(decodeServerMessage(plain.ok ? plain.value : "")).toEqual({ ok: true, value: { type: "response", id: "1", ok: true, result: [] } });
});

it("rejects malformed present metadata, including unsafe counters and unknown scopes", () => {
  const invalid = [
    { ...sync, epoch: "" },
    { ...sync, changes: [{ scope: "settings", kind: "snapshot", rev: -1 }] },
    { ...sync, changes: [{ scope: "settings", kind: "snapshot", rev: 0.5 }] },
    { ...sync, changes: [{ scope: "settings", kind: "snapshot", rev: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...sync, changes: [{ scope: "thread:one", kind: "patch", rev: 2 }] },
    { ...sync, changes: [{ scope: "thread:one", kind: "patch", baseRev: -1, rev: 2 }] },
    { ...sync, changes: [{ scope: "invented", kind: "snapshot", rev: 0 }] },
    { ...sync, changes: [{ scope: "thread:", kind: "snapshot", rev: 0 }] },
    { ...sync, changes: [{ scope: "settings", kind: "invented", rev: 0 }] },
    null,
  ];
  for (const metadata of invalid) {
    expect(decodeServerMessage(JSON.stringify({ type: "response", id: "1", ok: true, result: [], sync: metadata })).ok, JSON.stringify(metadata)).toBe(false);
    expect(decodeServerMessage(JSON.stringify({ type: "push", channel: "threads.changed", payload: { threadId: "one" }, sync: metadata })).ok).toBe(false);
    expect(encodeResult("1", "threads.list", [], metadata as SyncMetadata).ok).toBe(false);
    expect(encodePush("threads.changed", { threadId: "one" }, metadata as SyncMetadata).ok).toBe(false);
  }
});

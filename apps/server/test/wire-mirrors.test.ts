// Each server module keeps plain TypeScript copies of the wire shapes. The
// type checks below fail `tsc` when a copy drifts from packages/contracts;
// the tests fail when a real module output does not encode on the wire
// (contracts strip unknown keys and refuse fractional byte counts).
import {
  type FitReport as WireFitReport,
  type Message as WireMessage,
  type ModelInfo as WireModelInfo,
  type ModelSpeed as WireModelSpeed,
  type RuntimeStatus as WireRuntimeStatus,
  type Thread as WireThread,
  decodeResult,
  encodeResult,
} from "@gates-local/contracts";
import { describe, expect, it } from "vitest";

import type { Message as ChatMessage } from "../src/chat/types.ts";
import { decideFit } from "../src/fit/fit.ts";
import type { FitReport as FitFitReport } from "../src/fit/types.ts";
import type { ModelInfo as RuntimeModelInfo, RuntimeStatus as RuntimeRuntimeStatus } from "../src/runtime/types.ts";
import type { Message as StoreMessage, Thread as StoreThread } from "../src/threads/types.ts";
import type { ModelSpeed as StoreModelSpeed } from "../src/threads/store.ts";

type Assignable<From, To> = [From] extends [To] ? true : false;

// A `false` here is a tsc error: that module's copy no longer fits the wire.
export const mirrorsFit: [
  Assignable<StoreThread, WireThread>,
  Assignable<StoreMessage, WireMessage>,
  Assignable<ChatMessage, WireMessage>,
  Assignable<FitFitReport, WireFitReport>,
  Assignable<RuntimeRuntimeStatus, WireRuntimeStatus>,
  Assignable<RuntimeModelInfo, WireModelInfo>,
  Assignable<StoreModelSpeed, WireModelSpeed>,
] = [true, true, true, true, true, true, true];

const MIB = 1024 * 1024;

describe("real module outputs survive the wire", () => {
  // Free VRAM and the estimate are from lane E's real qwen3.5:9b run on 2026-11-07.
  const cases = [
    { name: "fits", freeVramBytes: 10082 * MIB, memAvailableBytes: 40e9 },
    { name: "spills", freeVramBytes: 6000 * MIB, memAvailableBytes: 40e9 },
    { name: "refuse", freeVramBytes: 3000 * MIB, memAvailableBytes: 3e9 },
  ];
  for (const c of cases) {
    it(`a ${c.name} FitReport keeps every field, message included`, () => {
      const report = decideFit({
        model: "qwen3.5:9b",
        numCtx: 16384,
        needBytes: 8_205_087_447,
        freeVramBytes: c.freeVramBytes,
        memAvailableBytes: c.memAvailableBytes,
        measuredAt: 1_762_520_000_000,
      });
      expect(report.verdict).toBe(c.name);
      // A fit table row is the report without its reading, which the table holds once.
      const { measuredAt, ...row } = report;
      const table = { reading: { boot: "b", seq: 1, measuredAt }, memory: { kind: "cpu" as const }, rows: [{ ...row, stops: [] }] };
      const frame = encodeResult("req-1", "fit.table", table);
      if (!frame.ok) throw frame.error;
      const back = decodeResult("fit.table", JSON.parse(frame.value).result);
      if (!back.ok) throw back.error;
      expect(back.value).toEqual(table);
    });
  }
});

// Each server module keeps plain TypeScript copies of the wire shapes. The
// type checks below fail `tsc` when a copy drifts from packages/contracts;
// the tests fail when a real module output does not encode on the wire
// (contracts strip unknown keys and refuse fractional byte counts).
import {
  type ChatEvent as WireChatEvent,
  type FitReport as WireFitReport,
  type Message as WireMessage,
  type ModelInfo as WireModelInfo,
  type RuntimeStatus as WireRuntimeStatus,
  type Thread as WireThread,
  decodePayload,
  decodeResult,
  encodePush,
  encodeResult,
} from "@gates-local/contracts";
import { describe, expect, it } from "vitest";

import type { ChatEvent, Message as ChatMessage } from "../src/chat/types.ts";
import { decideFit } from "../src/fit/fit.ts";
import type { FitReport as FitFitReport } from "../src/fit/types.ts";
import type { ModelInfo as RuntimeModelInfo, RuntimeStatus as RuntimeRuntimeStatus } from "../src/runtime/types.ts";
import type { Message as StoreMessage, Thread as StoreThread } from "../src/threads/types.ts";

type Assignable<From, To> = [From] extends [To] ? true : false;

// A `false` here is a tsc error: that module's copy no longer fits the wire.
export const mirrorsFit: [
  Assignable<StoreThread, WireThread>,
  Assignable<StoreMessage, WireMessage>,
  Assignable<ChatMessage, WireMessage>,
  Assignable<ChatEvent, WireChatEvent>,
  Assignable<FitFitReport, WireFitReport>,
  Assignable<RuntimeRuntimeStatus, WireRuntimeStatus>,
  Assignable<RuntimeModelInfo, WireModelInfo>,
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
      const frame = encodeResult("req-1", "fit.check", report);
      if (!frame.ok) throw frame.error;
      const back = decodeResult("fit.check", JSON.parse(frame.value).result);
      if (!back.ok) throw back.error;
      expect(back.value).toEqual(report);
    });
  }

  it("a finished turn's done event keeps stopReason and the message", () => {
    const message: ChatMessage = { id: "m1", threadId: "t1", role: "assistant", content: "Two plus two equals four.", thinking: "add them", model: "qwen3.5:9b", createdAt: 1_762_520_000_007, stats: { promptTokens: 24, completionTokens: 7, numCtx: 16384 } };
    const event: ChatEvent = { type: "done", message, stopReason: "length" };
    const frame = encodePush("chat.event", { turnId: "turn-1", threadId: "t1", event });
    if (!frame.ok) throw frame.error;
    const back = decodePayload("chat.event", JSON.parse(frame.value).payload);
    if (!back.ok) throw back.error;
    expect(back.value.payload).toEqual({ turnId: "turn-1", threadId: "t1", event });
  });
});

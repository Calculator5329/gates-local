// A call the person's Stop cut short travels as state "error" with stopped: true.
// A build that knows only "running" | "done" | "error" and no `stopped` field
// (the first public release) must still encode and decode it, or its server
// cannot send the thread holding that step and its client drops the socket on
// the push. The old shape is written out here as that build had it.
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { describe, expect, it } from "vitest";
import { Message, Thread, type ToolStep, decodePayload, decodeResult, encodePush, encodeResult } from "../src/index.ts";

const OldToolStep = S.Struct({
  callId: S.String,
  name: S.String,
  state: S.Literals(["running", "done", "error"]),
  summary: S.String,
  detail: S.optional(S.String),
  durationMs: S.optional(S.Finite),
  links: S.optional(S.Array(S.String)),
});
const OldThreadsGet = S.Struct({ thread: Thread, messages: S.Array(S.Struct({ ...Message.fields, tools: S.optional(S.Array(OldToolStep)) })) });
const OldToolEvent = S.Struct({ turnId: S.String, threadId: S.String, event: S.Struct({ type: S.Literal("tool"), step: OldToolStep }) });

const ok = (r: Result.Result<unknown, unknown>) => Result.isSuccess(r);
const thread = { id: "t1", title: "Images", createdAt: 1, updatedAt: 1 };
const cut: ToolStep = { callId: "c1", name: "image", state: "error", stopped: true, summary: "Making an image" };
const saved = { thread, messages: [{ id: "m1", threadId: "t1", role: "assistant" as const, content: "", createdAt: 2, interrupted: true as const, tools: [cut] }] };
const push = { turnId: "turn", threadId: "t1", event: { type: "tool" as const, step: cut } };

describe("a stopped step and a build that predates it", () => {
  it("threads.get: this server sends the mark, an old client reads the result, an old server encodes the saved row", () => {
    const frame = encodeResult("1", "threads.get", saved);
    if (!frame.ok) throw frame.error;
    const result = (JSON.parse(frame.value) as { result: unknown }).result;
    expect(result).toMatchObject({ messages: [{ tools: [{ state: "error", stopped: true }] }] });
    expect(decodeResult("threads.get", result)).toMatchObject({ ok: true, value: { messages: [{ tools: [{ stopped: true }] }] } });
    expect(ok(S.decodeUnknownResult(OldThreadsGet)(result)), "an old client decodes it").toBe(true);
    const oldServer = S.encodeUnknownResult(OldThreadsGet)(saved);
    expect(ok(oldServer), "an old server encodes the row this build saved").toBe(true);
    expect(JSON.stringify(Result.getOrThrow(oldServer))).not.toContain("stopped");
  });

  it("chat.event: an old client decodes the pushed step and keeps its socket", () => {
    const frame = encodePush("chat.event", push);
    if (!frame.ok) throw frame.error;
    const payload = (JSON.parse(frame.value) as { payload: unknown }).payload;
    expect(payload).toMatchObject({ event: { step: { state: "error", stopped: true } } });
    expect(decodePayload("chat.event", payload)).toMatchObject({ ok: true });
    expect(ok(S.decodeUnknownResult(OldToolEvent)(payload)), "an old client decodes it").toBe(true);
  });

  it("the old shape refuses a fourth state, which is why the mark is a field", () => {
    expect(ok(S.decodeUnknownResult(OldToolEvent)({ ...push, event: { type: "tool", step: { ...cut, stopped: undefined, state: "stopped" } } }))).toBe(false);
  });

  it("this build refuses a fourth state too: nothing here may start sending one", () => {
    const fourth = { ...push, event: { type: "tool", step: { callId: "c1", name: "image", state: "stopped", summary: "Making an image" } } };
    expect(decodePayload("chat.event", fourth)).toMatchObject({ ok: false });
    expect(encodePush("chat.event", fourth as never)).toMatchObject({ ok: false });
  });
});

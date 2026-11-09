import { describe, expect, it } from "vitest";
import {
  type Channel,
  type MethodName,
  channelNames,
  decodePayload,
  decodeRequest,
  decodeResult,
  decodeServerMessage,
  encodePush,
  encodeRequest,
  encodeResult,
  methodNames,
} from "../src/index.ts";
import { methodSamples, pushSamples } from "../src/testing.ts";

function refusal(raw: unknown) {
  const r = decodeRequest(raw);
  if (r.ok) throw new Error(`expected a refusal for ${String(raw)}`);
  return r;
}

describe("codec round trip", () => {
  it.each(methodNames)("%s params and result survive encode and decode", (method: MethodName) => {
    const { params, result } = methodSamples[method];
    const frame = encodeRequest("7", method, params as never);
    if (!frame.ok) throw frame.error;
    const req = decodeRequest(frame.value);
    expect(req).toEqual({ ok: true, value: { id: "7", method, params } });

    const res = encodeResult("7", method, result as never);
    if (!res.ok) throw res.error;
    const env = decodeServerMessage(res.value);
    if (!env.ok || env.value.type !== "response" || !env.value.ok) throw new Error("bad envelope");
    expect(decodeResult(method, env.value.result)).toEqual({ ok: true, value: result });
  });

  it.each(channelNames)("%s payloads survive encode and decode", (channel: Channel) => {
    for (const payload of pushSamples[channel]) {
      const frame = encodePush(channel, payload as never);
      if (!frame.ok) throw frame.error;
      const env = decodeServerMessage(frame.value);
      if (!env.ok || env.value.type !== "push") throw new Error("bad envelope");
      expect(decodePayload(env.value.channel, env.value.payload)).toEqual({ ok: true, value: { channel, payload } });
    }
  });
});

describe("boundary refusals", () => {
  it("names malformed JSON bad-message with no id", () => {
    const r = refusal("{not json");
    expect(r.error.code).toBe("bad-message");
    expect(r.error.name).toBe("WireError");
    expect(r.id).toBeUndefined();
  });

  it("names a wrong envelope bad-message and salvages a string id", () => {
    const r = refusal(JSON.stringify({ type: "reqest", id: "9", method: "threads.list", params: {} }));
    expect(r.error.code).toBe("bad-message");
    expect(r.id).toBe("9");
    expect(refusal(JSON.stringify({ type: "request", id: 9, method: "threads.list", params: {} })).id).toBeUndefined();
    expect(refusal(JSON.stringify({ type: "request", id: "3", method: "threads.list" })).error.code).toBe("bad-message");
  });

  it("names an unknown method, including prototype keys", () => {
    for (const method of ["threads.nuke", "toString", "__proto__", "constructor"]) {
      const r = refusal(JSON.stringify({ type: "request", id: "1", method, params: {} }));
      expect(r.error.code).toBe("unknown-method");
      expect(r.id).toBe("1");
    }
  });

  it("names bad params", () => {
    const cases: Array<[string, unknown]> = [
      ["threads.get", {}],
      ["threads.get", { threadId: 4 }],
      ["threads.rename", { threadId: "t1" }],
      ["fit.check", { model: "m", numCtx: 0 }],
      ["fit.check", { model: "m", numCtx: 1.5 }],
      ["chat.send", { threadId: "t1", content: "x", model: "m" }],
      ["threads.list", null],
    ];
    for (const [method, params] of cases) {
      const r = refusal(JSON.stringify({ type: "request", id: "2", method, params }));
      expect(r.error.code, `${method} ${JSON.stringify(params)}`).toBe("bad-params");
      expect(r.id).toBe("2");
    }
  });

  it("never throws on garbage", () => {
    const garbage: unknown[] = [undefined, null, 42, Buffer.from("{}"), "", "null", "[]", "1", '"x"', "{}", '{"type":"request"}'];
    for (const g of garbage) {
      expect(() => decodeRequest(g)).not.toThrow();
      expect(decodeRequest(g).ok).toBe(false);
      expect(() => decodeServerMessage(g)).not.toThrow();
      expect(decodeServerMessage(g).ok).toBe(false);
    }
  });

  it("refuses a push payload or result that breaks its Schema before it leaves", () => {
    const push = encodePush("threads.changed", { threadId: 5 } as never);
    expect(push.ok ? "sent" : push.error.code).toBe("bad-payload");
    const res = encodeResult("1", "runtime.status", { state: "sleepy", owner: "app", baseUrl: "x" } as never);
    expect(res.ok ? "sent" : res.error.code).toBe("bad-result");
    expect(decodePayload("chat.nope", {}).ok).toBe(false);
  });
});

export function compileOnlyContractChecks(): void {
    // These lines exist for `tsc`; each must stay an error.
    // @ts-expect-error threadId is required
    encodeRequest("1", "threads.get", {});
    // @ts-expect-error numCtx is a number
    encodeRequest("1", "fit.check", { model: "m", numCtx: "16k" });
    // @ts-expect-error not a method
    encodeRequest("1", "threads.nuke", {});
    // @ts-expect-error not a channel
    encodePush("nope", {});
    // @ts-expect-error not a method
    encodeRequest("1", "constructor", {});
}

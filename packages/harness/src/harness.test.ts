import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseTextCalls, repairCall, toolBlock, trimOutput, runLoop } from "./index.ts";

describe("text tool calls", () => {
  for (const family of ["qwen", "gemma"]) {
    it(`parses the hand-written ${family} transcript and ignores thinking`, () => {
      const text = readFileSync(new URL(`./fixtures/${family}.txt`, import.meta.url), "utf8");
      const parsed = parseTextCalls(text);
      expect(parsed.calls).toHaveLength(1);
      expect(repairCall(parsed.calls[0])).toMatchObject({ name: "read", input: { path: "/library/docs", limit: 20 } });
      expect(parsed.errors).toEqual([]);
    });
  }
  it("never parses an unclosed thought or silently loses malformed calls", () => {
    expect(parseTextCalls('<think><tool_call>{"name":"shell"}</tool_call>').calls).toEqual([]);
    expect(parseTextCalls("<tool_call>{bad}</tool_call><tool_call>{").errors).toHaveLength(2);
    expect(repairCall({ name: "bash", arguments: '{"command":"ls","timeoutMs":"20"}' })).toMatchObject({ name: "shell", input: { timeoutMs: 20 } });
  });
  it("keeps the tool block under the 1000-token budget at an estimated 3 chars/token", () => {
    for (const platform of ["linux", "win32"] as const) expect(Math.ceil(toolBlock(platform).length / 3)).toBeLessThan(1000);
  });
});

describe("turn loop", () => {
  it("feeds 50k output back as the 5k head and 5k tail", async () => {
    const output = "a".repeat(25000) + "z".repeat(25000);
    expect(trimOutput(output)).toBe("a".repeat(5000) + "\n[40000 characters elided]\n" + "z".repeat(5000));
    const requests: unknown[] = [];
    const stream = vi.fn(async function* (messages) {
      requests.push(structuredClone(messages));
      if (requests.length === 1) yield { type: "complete" as const, content: "", calls: [{ name: "read", arguments: { path: "docs" } }], stopReason: "stop" };
      else yield { type: "complete" as const, content: "Finished", calls: [], stopReason: "stop" };
    });
    const events = [];
    for await (const event of runLoop({ messages: [], stream, execute: async () => ({ output, summary: "Read your file" }), signal: new AbortController().signal, native: true })) events.push(event);
    expect(JSON.stringify(requests[1])).toContain("40000 characters elided");
    expect(events.filter(e => e.type === "tool").map(e => e.step.state)).toEqual(["running", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "complete", content: "Finished", tools: [{ state: "done" }] });
  });
  it("a length stop fails every pending call without executing any", async () => {
    const execute = vi.fn();
    const events = [];
    for await (const event of runLoop({ messages: [], native: true, signal: new AbortController().signal, execute,
      stream: async function* () { yield { type: "complete", content: "", calls: [{ name: "read", arguments: {} }, { name: "shell", arguments: { command: "ls" } }], stopReason: "length" }; } })) events.push(event);
    expect(execute).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === "tool").map(e => e.step.state)).toEqual(["error", "error"]);
    expect(events.at(-1)).toMatchObject({ type: "complete", stopReason: "length" });
  });
  it("ends after three consecutive bad calls with a readable message", async () => {
    const stream = vi.fn(async function* () { yield { type: "complete" as const, content: "<tool_call>{bad}</tool_call>", calls: [], stopReason: "stop" }; });
    const events = [];
    for await (const event of runLoop({ messages: [], stream, execute: vi.fn(), native: false, signal: new AbortController().signal })) events.push(event);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toMatchObject({ type: "complete", content: expect.stringContaining("three invalid tool calls") });
  });
  it("closes a running tool step with an error when cancelled", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const consume = async () => {
      for await (const event of runLoop({ messages: [], native: true, signal: controller.signal,
        stream: async function* () { yield { type: "complete", content: "", calls: [{ name: "read", arguments: { path: "x" } }], stopReason: "stop" }; },
        execute: async () => { controller.abort(); throw new Error("cancelled"); },
      })) if (event.type === "tool") states.push(event.step.state);
    };
    await expect(consume()).rejects.toThrow();
    expect(states).toEqual(["running", "error"]);
  });
  it("resets the format budget in transcript order after a valid call", async () => {
    const stream = vi.fn(async function* () {
      yield { type: "complete" as const, content: stream.mock.calls.length === 1
        ? '<tool_call>bad</tool_call><tool_call>{"name":"read","arguments":{"path":"docs"}}</tool_call><tool_call>bad</tool_call><tool_call>bad</tool_call>'
        : "Finished", calls: [], stopReason: "stop" };
    });
    const events = [];
    for await (const e of runLoop({ messages: [], stream, execute: async () => ({ output: "ok", summary: "Read your file" }), native: false, signal: new AbortController().signal })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "complete", content: "Finished" });
  });
});

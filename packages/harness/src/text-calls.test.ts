import { describe, expect, it } from "vitest";
import { createCallHold, createTools, HOLD_LIMIT, looseCall, runLoop, toolDefinitions, type LoopInput } from "./index.ts";
import type { LoopEvent, ModelEvent, ModelMessage, ModelStream, ToolCall } from "./types.ts";

// A model wrote its tool call as the whole reply, in a JSON shape of its own,
// instead of a runtime tool call or the text-mode syntax. The owner's screenshot:
const PROMPT = "A cinematic sci-fi background featuring a massive, high-tech space station orbiting a ringed planet within a vibrant, colorful nebula. The scene includes distant stars, glowing energy fields, and intricate hull details on the station. High-resolution, 8k, photorealistic, epic scale, and dramatic lighting.";
const SCREENSHOT = `{ "action": "image", "action_input": "${PROMPT}" }`;

const withImage = toolDefinitions("linux", { image: true });
const withoutImage = toolDefinitions("linux");

/** Splits a reply into the small pieces a model streams. */
const pieces = (text: string, size = 7) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

interface Round { deltas?: string[]; content?: string; calls?: unknown[] }
async function run(native: boolean, rounds: Round[], options: { definitions?: typeof withImage; execute?: (call: ToolCall, signal: AbortSignal) => Promise<{ output: string; summary: string }>; log?: string[]; input?: Partial<LoopInput> } = {}) {
  const queued: string[] = [];
  const tools = createTools({ sources: [], image: true, queueImage: async (prompt) => { queued.push(prompt); return { jobId: "job" }; } });
  const requests: ModelMessage[][] = [];
  const executed: ToolCall[] = [];
  const events: LoopEvent[] = [];
  const stream = async function* (messages: readonly ModelMessage[]): AsyncGenerator<ModelEvent> {
    requests.push(structuredClone([...messages]));
    const round = rounds[requests.length - 1] ?? { content: "Finished" };
    const deltas = round.deltas ?? (native && round.content ? [round.content] : []);
    for (const text of deltas) { options.log?.push(`model:${text}`); yield { type: "delta", text }; }
    yield { type: "complete", content: round.content ?? deltas.join(""), calls: round.calls ?? [], stopReason: "stop" };
  };
  for await (const event of runLoop({ messages: [{ role: "user", content: "A sci fi background image" }], native, stream, signal: new AbortController().signal,
    definitions: options.definitions ?? withImage,
    execute: async (call, signal) => { executed.push(call); return options.execute ? options.execute(call, signal) : tools.execute(call, signal); },
    ...options.input,
  })) {
    if (event.type === "delta") options.log?.push(`shown:${event.text}`);
    events.push(event);
  }
  const complete = events.at(-1) as Extract<LoopEvent, { type: "complete" }>;
  const shown = events.flatMap(e => e.type === "delta" ? [e.text] : []).join("");
  return { queued, requests, executed, events, complete, shown };
}

describe("a tool call written as the whole reply is run, not shown (owner screenshot 2026-11-11)", () => {
  it("native path: the screenshot's reply, streamed with no tool_calls, queues one image with its prompt and shows no JSON", async () => {
    const { queued, complete, shown, requests } = await run(true, [{ deltas: pieces(SCREENSHOT) }]);
    expect(queued).toEqual([PROMPT]);
    expect(shown).toBe("");
    expect(complete).toMatchObject({ content: "", tools: [{ name: "image", state: "done" }] });
    expect(requests).toHaveLength(1);
  });
  it("text path: the same reply queues one image with its prompt and shows no JSON", async () => {
    const { queued, complete, shown, requests } = await run(false, [{ content: SCREENSHOT }]);
    expect(queued).toEqual([PROMPT]);
    expect(shown).toBe("");
    expect(complete).toMatchObject({ content: "", tools: [{ name: "image", state: "done" }] });
    expect(requests).toHaveLength(1);
  });
});

describe("looseCall: the accepted shapes", () => {
  const image = { name: "image", arguments: { prompt: "a ship" } };
  it.each([
    ['{"name":"image","arguments":{"prompt":"a ship"}}'],
    ['{"name":"image","parameters":{"prompt":"a ship"}}'],
    ['{"action":"image","action_input":{"prompt":"a ship"}}'],
    ['{"action":"image","action_input":"a ship"}'],
    ['{"tool":"image","tool_input":{"prompt":"a ship"}}'],
    ['{"tool":"image","tool_input":"a ship"}'],
    ['{"function":{"name":"image","arguments":{"prompt":"a ship"}}}'],
    ['{"function":{"name":"image","arguments":"{\\"prompt\\":\\"a ship\\"}"}}'],
    ['{"name":"image","arguments":"{\\"prompt\\":\\"a ship\\"}"}'],
    ['\n  {"name":"image","arguments":{"prompt":"a ship"}}  \n'],
    ['```json\n{"name":"image","arguments":{"prompt":"a ship"}}\n```'],
    ['```\n{"action":"image","action_input":"a ship"}\n```'],
    ['<think>The user wants a picture.</think>\n{"action":"image","action_input":"a ship"}'],
  ])("%s", (text) => {
    expect(looseCall(text, withImage)).toEqual(image);
  });
  it("maps a bare string to the one required string of other tools too, and repairs the way runtime calls are repaired", () => {
    expect(looseCall('{"action":"read","action_input":"/library/docs"}', withImage)).toEqual({ name: "read", arguments: { path: "/library/docs" } });
    expect(looseCall('{"action":"shell","action_input":"ls /library"}', withImage)).toEqual({ name: "shell", arguments: { command: "ls /library" } });
    expect(looseCall('{"name":"read","arguments":{"path":"/library/docs","limit":"20"}}', withImage)).toEqual({ name: "read", arguments: { path: "/library/docs", limit: 20 } });
  });
});

describe("looseCall: not a call", () => {
  it.each([
    ["prose beside the object", 'Here is an example tool call:\n{"name":"image","arguments":{"prompt":"a ship"}}'],
    ["prose after the object", '{"name":"image","arguments":{"prompt":"a ship"}}\nThat is how a call looks.'],
    ["prose beside a fence", 'Example:\n```json\n{"name":"image","arguments":{"prompt":"a ship"}}\n```'],
    ["two objects", '{"name":"image","arguments":{"prompt":"a ship"}}\n{"name":"image","arguments":{"prompt":"a car"}}'],
    ["an array of calls", '[{"name":"image","arguments":{"prompt":"a ship"}}]'],
    ["a name that is not a tool", '{"name":"weather","arguments":{"city":"Paris"}}'],
    ["a name that is not a tool, with arguments another tool would take", '{"name":"draw","arguments":{"prompt":"a ship"}}'],
    ["a person, not a call", '{"name":"Ada","age":36}'],
    ["a missing required field", '{"name":"image","arguments":{}}'],
    ["an empty required string", '{"action":"image","action_input":""}'],
    ["a field the tool does not take", '{"name":"image","arguments":{"prompt":"a ship","size":"8k"}}'],
    ["a field of the wrong type", '{"name":"read","arguments":{"path":"/library/docs","limit":"many"}}'],
    ["a bare string for a tool without one required string", '{"action":"image","action_input":42}'],
    ["keys beyond the shape", '{"name":"image","arguments":{"prompt":"a ship"},"id":"1"}'],
    ["a shape not on the list", '{"tool_name":"image","input":{"prompt":"a ship"}}'],
    ["a fence that never closes", '```json\n{"name":"image","arguments":{"prompt":"a ship"}}'],
    ["a call inside thinking only", '<think>{"name":"image","arguments":{"prompt":"a ship"}}</think>'],
  ])("%s", (_, text) => {
    expect(looseCall(text, withImage)).toBeUndefined();
  });
  it("the image tool when this turn did not offer it", () => {
    expect(looseCall(SCREENSHOT, withoutImage)).toBeUndefined();
  });
  it("nothing is a call when no tools are offered", () => {
    expect(looseCall(SCREENSHOT, [])).toBeUndefined();
  });
});

describe("the reply stays an answer when it is not a call", () => {
  const example = 'Here is an example tool call in JSON:\n\n```json\n{"action":"image","action_input":"a ship"}\n```\n\nThe app would run it.';
  it.each([true, false])("asked for an example, the person sees prose plus JSON and nothing runs (native %s)", async (native) => {
    const { executed, complete, shown } = await run(native, [{ deltas: native ? pieces(example) : undefined, content: example }]);
    expect(executed).toEqual([]);
    expect(complete.content).toBe(example);
    expect(shown).toBe(example);
  });
  it.each([true, false])("a JSON-only answer that is not a call is shown as it is today (native %s)", async (native) => {
    const answer = '{"name":"Ada","age":36}';
    const { executed, complete, shown } = await run(native, [{ deltas: native ? pieces(answer, 4) : undefined, content: answer }]);
    expect(executed).toEqual([]);
    expect(complete.content).toBe(answer);
    expect(shown).toBe(answer);
  });
  it("the screenshot's reply when the turn did not offer the image tool is shown as it is today", async () => {
    const { executed, complete, shown } = await run(true, [{ deltas: pieces(SCREENSHOT) }], { definitions: withoutImage });
    expect(executed).toEqual([]);
    expect(complete.content).toBe(SCREENSHOT);
    expect(shown).toBe(SCREENSHOT);
  });
  it("native path: a round with real tool_calls runs only those; JSON text beside them is not a second call", async () => {
    const text = '{"name":"read","arguments":{"path":"/library/other"}}';
    const { executed } = await run(true, [{ deltas: [text], calls: [{ name: "read", arguments: { path: "/library/docs" } }] }],
      { execute: async () => ({ output: "ok", summary: "Read" }) });
    expect(executed).toEqual([{ name: "read", input: { path: "/library/docs" } }]);
  });
});

describe("streaming: the held text", () => {
  it("never flashes a call: no delta of the screenshot's JSON is shown at any point", async () => {
    const log: string[] = [];
    await run(true, [{ deltas: pieces(SCREENSHOT, 3) }], { log });
    expect(log.filter(entry => entry.startsWith("shown:"))).toEqual([]);
    expect(log.filter(entry => entry.startsWith("model:")).length).toBeGreaterThan(50);
  });
  it("a fenced call never flashes either", async () => {
    const log: string[] = [];
    const { queued } = await run(true, [{ deltas: pieces("```json\n" + SCREENSHOT + "\n```", 3) }], { log });
    expect(queued).toEqual([PROMPT]);
    expect(log.filter(entry => entry.startsWith("shown:"))).toEqual([]);
  });
  it("a plain reply's first text is shown right after the model's first piece, as before", async () => {
    // Measured as model pieces produced before the first shown text: 1 before this change and after.
    for (const definitions of [[], withImage]) {
      const log: string[] = [];
      await run(true, [{ deltas: ["Here", " is", " a", " plain", " reply."] }], { log, definitions });
      expect(log.slice(0, 3)).toEqual(["model:Here", "shown:Here", "model: is"]);
    }
  });
  it("leading white space is held as before, and a reply that starts with anything but { is released at once", async () => {
    const log: string[] = [];
    await run(true, [{ deltas: ["\n", "  ", "Sure", ", here"] }], { log });
    expect(log.slice(0, 5)).toEqual(["model:\n", "model:  ", "model:Sure", "shown:\n  Sure", "model:, here"]);
  });
  it("a fenced code answer is released when its first line after the fence cannot start a call", async () => {
    const log: string[] = [];
    await run(true, [{ deltas: ["```", "python\n", "print", "(1)\n```"] }], { log });
    expect(log.indexOf("shown:```python\nprint")).toBe(log.indexOf("model:print") + 1);
  });
  it("JSON whose name is not an offered tool is released the moment that name closes, before the rest of the reply arrives", async () => {
    const log: string[] = [];
    const { shown } = await run(true, [{ deltas: ['{"name":', '"Ada",', '"age":36}', "\n\nThat", " is Ada."] }], { log });
    expect(log.indexOf('shown:{"name":"Ada",')).toBe(log.indexOf('model:"Ada",') + 1);
    expect(shown).toBe('{"name":"Ada","age":36}\n\nThat is Ada.');
  });
  it("a reply that starts with { but cannot be a JSON object is released at its next piece", async () => {
    const log: string[] = [];
    await run(true, [{ deltas: ["{", "\\displaystyle", ' x" }', " is the formula."] }], { log });
    expect(log.indexOf("shown:{\\displaystyle")).toBe(log.indexOf("model:\\displaystyle") + 1);
  });
  it("text after a closed call object releases everything at once", async () => {
    const log: string[] = [];
    const call = '{"action":"image","action_input":"a ship"}';
    const { executed, shown } = await run(true, [{ deltas: [call, " is what I would send."] }], { log });
    expect(executed).toEqual([]);
    expect(log.indexOf(`shown:${call} is what I would send.`)).toBe(log.indexOf("model: is what I would send.") + 1);
    expect(shown).toBe(`${call} is what I would send.`);
  });
});

describe("the next round's history is well formed for the path in use", () => {
  const call = '{"name":"read","arguments":{"path":"/library/docs"}}';
  it("native: the recovered call goes back as an assistant message with tool_calls, then the tool result", async () => {
    const { requests, complete } = await run(true, [{ deltas: [call] }, { content: "The docs folder has two files." }],
      { execute: async () => ({ output: "a.md\nb.md", summary: "Listed a library folder" }) });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.slice(1)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read", arguments: { path: "/library/docs" } } }] },
      { role: "tool", tool_name: "read", content: "a.md\nb.md" },
    ]);
    expect(complete).toMatchObject({ content: "The docs folder has two files.", tools: [{ name: "read", state: "done" }] });
  });
  it("text: the model's own words go back as the assistant message, then the labelled observation", async () => {
    const { requests, complete } = await run(false, [{ content: call }, { content: "The docs folder has two files." }],
      { execute: async () => ({ output: "a.md\nb.md", summary: "Listed a library folder" }) });
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]).toEqual({ role: "assistant", content: call });
    expect(requests[1]![2]).toMatchObject({ role: "user", content: expect.stringContaining('<tool_result name="read">a.md\nb.md</tool_result>') });
    expect(requests[1]).toHaveLength(3);
    expect(complete).toMatchObject({ content: "The docs folder has two files." });
  });
});

// A call cut off mid-object: held, never shown, until the round ends.
const HELD = ['{"name":"image",', '"arguments":{"prompt":"a sh'];
/** One native round from `stream`, run to the turn's end or its error: the text shown (the app saves exactly this) and the error. */
async function endEarly(stream: (signal: AbortSignal) => AsyncIterable<ModelEvent>, input: Partial<LoopInput> = {}) {
  const stop = input.signal ? undefined : new AbortController();
  const shown: string[] = [];
  let error: Error | undefined;
  const modelStream: ModelStream = (_, options) => stream(options!.signal!);
  try {
    for await (const event of runLoop({ messages: [{ role: "user", content: "A sci fi background image" }], native: true, stream: modelStream, signal: stop?.signal ?? input.signal!,
      definitions: withImage, execute: async () => ({ output: "", summary: "" }), ...input })) {
      if (event.type === "delta") shown.push(event.text);
    }
  } catch (e) { error = e as Error; }
  return { shown: shown.join(""), error };
}
const never = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

describe("held text is shown, and so saved, when the round ends early", () => {
  it("the person presses Stop", async () => {
    const stop = new AbortController();
    const { shown, error } = await endEarly(async function* (signal) {
      for (const text of HELD) yield { type: "delta", text };
      stop.abort(new Error("Stopped by the person"));
      await never(signal);
    }, { signal: stop.signal });
    expect(error?.message).toBe("Stopped by the person");
    expect(shown).toBe(HELD.join(""));
  });
  it("the stream fails", async () => {
    const { shown, error } = await endEarly(async function* () {
      for (const text of HELD) yield { type: "delta", text };
      throw new Error("connection reset");
    });
    expect(error?.message).toBe("connection reset");
    expect(shown).toBe(HELD.join(""));
  });
  it("the stall guard fires", async () => {
    const { shown, error } = await endEarly(async function* (signal) {
      for (const text of HELD) yield { type: "delta", text };
      await never(signal);
    }, { stallMs: 20 });
    expect(error?.message).toMatch(/stopped sending/);
    expect(shown).toBe(HELD.join(""));
  });
  it("the stream ends without a done line", async () => {
    const { shown, error } = await endEarly(async function* () {
      for (const text of HELD) yield { type: "delta", text };
    });
    expect(error?.message).toBe("The model stream ended without a done line");
    expect(shown).toBe(HELD.join(""));
  });
});

describe("the hold ends as soon as the text cannot be a call", () => {
  it('a JSON answer {"users": [ is shown at the piece that closes "users"', async () => {
    const log: string[] = [];
    const answer = ['{"us', 'ers"', ': [', '{"id":1}', "]}"];
    const { shown } = await run(true, [{ deltas: answer }], { log });
    expect(log.indexOf('shown:{"users"')).toBe(log.indexOf('model:ers"') + 1);
    expect(shown).toBe(answer.join(""));
  });
  it('{"name":"draw", is shown at the piece that closes "draw": no tool by that name is offered', async () => {
    const log: string[] = [];
    const answer = ['{"name":"dr', 'aw",', '"arguments":', '{"prompt":"a ship"}}'];
    const { shown, executed } = await run(true, [{ deltas: answer }], { log });
    expect(log.indexOf('shown:{"name":"draw",')).toBe(log.indexOf('model:aw",') + 1);
    expect(shown).toBe(answer.join(""));
    expect(executed).toEqual([]);
  });
  it("a call-shaped object is shown when a third key starts, or when the second key is not the first one's partner", async () => {
    for (const [answer, at] of [
      [['{"name":"image",', '"arguments":{"prompt":"a ship"}', ',"id"', ':"1"}'], ',"id"'],
      [['{"name":"image",', '"prompt"', ':"a ship"}'], '"prompt"'],
      [['{"action":"image",', '"arguments"', ':"a ship"}'], '"arguments"'],
    ] as const) {
      const log: string[] = [];
      const { shown, executed } = await run(true, [{ deltas: [...answer] }], { log });
      expect(log.indexOf(`model:${at}`)).toBeGreaterThan(0);
      expect(log[log.indexOf(`model:${at}`) + 1]).toMatch(/^shown:/);
      expect(shown).toBe(answer.join(""));
      expect(executed).toEqual([]);
    }
  });
  it(`held text past ${HOLD_LIMIT} characters is shown at the piece that passes the limit and is never a call`, async () => {
    const call = `{"name":"image","arguments":{"prompt":"${"a ship ".repeat(1300)}"}}`;
    expect(call.length).toBeGreaterThan(HOLD_LIMIT);
    const answer = pieces(call, 100);
    const passing = answer.findIndex((_, i) => answer.slice(0, i + 1).join("").length > HOLD_LIMIT);
    for (const native of [true, false]) {
      const log: string[] = [];
      const { shown, executed } = await run(native, [{ deltas: native ? answer : undefined, content: call }], { log });
      expect(executed).toEqual([]);
      expect(shown).toBe(call);
      // Pieces 0 to `passing` arrive held, then the first text is shown.
      if (native) expect(log.findIndex(entry => entry.startsWith("shown:"))).toBe(passing + 1);
    }
    expect(looseCall(call, withImage)).toBeUndefined();
  });
  it("the screenshot's reply shows no JSON however it is split", async () => {
    for (let size = 1; size <= SCREENSHOT.length; size++) {
      for (const text of [SCREENSHOT, "```json\n" + SCREENSHOT + "\n```"]) {
        const hold = createCallHold(withImage);
        expect(pieces(text, size).every(piece => hold.push(piece)), `pieces of ${size}`).toBe(true);
      }
    }
    for (let at = 1; at < SCREENSHOT.length; at++) {
      const hold = createCallHold(withImage);
      expect(hold.push(SCREENSHOT.slice(0, at)) && hold.push(SCREENSHOT.slice(at)), `split at ${at}`).toBe(true);
    }
  });
  it("every accepted shape is held to its last character, one character at a time", () => {
    for (const text of [
      '{"function":{"name":"image","arguments":{"prompt":"a ship"}}}',
      '{"arguments":{"prompt":"a ship"},"name":"image"}',
      '{"tool_input":"a ship","tool":"image"}',
      '{"name":"bash","arguments":{"command":"ls /library"}}',
      '{"name":"im\\u0061ge","parameters":{"prompt":"a \\"ship\\" {at} [sea]"}}',
      '```json\r\n{"name":"image","arguments":"{\\"prompt\\":\\"a ship\\"}"}\r\n```\n',
      // an escaped quote, then a closing brace inside the string: without escapes read, the object would seem to end early
      '{"name":"image","arguments":{"prompt":"a neon sign reading \\"}\\" over a door"}}',
      // a fence word with a dash
      '```tool-code\n{"name":"image","arguments":{"prompt":"a ship"}}\n```',
    ]) {
      expect(looseCall(text, withImage), text).toBeDefined();
      const hold = createCallHold(withImage);
      expect([...text].every(c => hold.push(c)), text).toBe(true);
    }
  });
  it("a 32K-character JSON reply costs scanning linear in its length, whether it is an answer or held as a call", async () => {
    const answer = JSON.stringify({ rows: Array.from({ length: 800 }, (_, i) => ({ id: i, label: `row label ${i}` })) }, null, 1).slice(0, 32000);
    const call = `{"name":"image","arguments":{"prompt":"${"a ship ".repeat(4600)}"}}`;
    for (const text of [answer, call]) {
      expect(text.length).toBeGreaterThanOrEqual(32000);
      const hold = createCallHold(withImage);
      for (const piece of pieces(text, 4)) hold.push(piece);
      expect(hold.scanned).toBeLessThanOrEqual(text.length);
    }
  });
});

describe("a round with no tools offered holds nothing and recovers nothing: the reply is the answer", () => {
  const call = '{"name":"read","arguments":{"path":"/library/other"}}';
  const first = { calls: [{ name: "read", arguments: { path: "/library/docs" } }] };
  it.each([true, false])("the output budget is spent, then the final reply is a call-shaped object (native %s)", async (native) => {
    const log: string[] = [];
    const { executed, complete, shown } = await run(native, [native ? first : { content: `<tool_call>${JSON.stringify(first.calls[0])}</tool_call>` }, { deltas: native ? pieces(call, 5) : undefined, content: call }],
      { log, input: { numCtx: 1000 }, execute: async () => ({ output: "x".repeat(3000), summary: "Read" }) });
    expect(executed).toHaveLength(1);
    expect(shown).toBe(call);
    expect(complete.content).toBe(call);
    if (native) expect(log.indexOf(`shown:${call.slice(0, 5)}`)).toBe(1 + log.indexOf(`model:${call.slice(0, 5)}`));
  });
  it.each([true, false])("the tool phase runs out of time, then the final reply is a call-shaped object (native %s)", async (native) => {
    const { executed, complete, shown } = await run(native, [native ? first : { content: `<tool_call>${JSON.stringify(first.calls[0])}</tool_call>` }, { deltas: native ? pieces(call, 5) : undefined, content: call }],
      { input: { toolTimeBudgetMs: 20 }, execute: (_, signal) => never(signal) });
    expect(executed).toHaveLength(1);
    expect(shown).toBe(call);
    expect(complete.content).toBe(call);
  });
});

describe("text still held when the round ends is shown in full", () => {
  it.each([
    ["a fenced call that never closes", ["```json\n", '{"name":"image",', '"arguments":{"prompt":"a ship"}}']],
    ["an object that never closes", ['{"name":"image",', '"arguments":{"prompt":', '"a ship"']],
    ["prose that opens like JSON", ['{"Hello,', '" she said', ", and left."]],
  ])("%s", async (_, deltas) => {
    const { shown, complete, executed } = await run(true, [{ deltas }]);
    expect(shown).toBe(deltas.join(""));
    expect(complete.content).toBe(deltas.join(""));
    expect(executed).toEqual([]);
  });
});

describe("fitsDefinition: an integer below its minimum does not fit", () => {
  it.each([
    ['{"name":"read","arguments":{"path":"/library/docs","limit":0}}', undefined],
    ['{"name":"read","arguments":{"path":"/library/docs","offset":-1}}', undefined],
    ['{"name":"read","arguments":{"path":"/library/docs","limit":1}}', { name: "read", arguments: { path: "/library/docs", limit: 1 } }],
    ['{"name":"read","arguments":{"path":"/library/docs","offset":0}}', { name: "read", arguments: { path: "/library/docs", offset: 0 } }],
  ])("%s", (text, expected) => {
    expect(looseCall(text, withImage)).toEqual(expected);
  });
});

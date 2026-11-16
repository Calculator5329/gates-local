import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendMark, sendSpan, sendTimesLine, withSendTimes } from "./send-times.ts";

const SWITCH = "GATES_LOCAL_SEND_TIMES";
const clock = { now: 0 };

const timedSend = (turnId: string): Promise<string | undefined> => withSendTimes(async () => {
  sendMark("lease");
  await sendSpan("gpu-read", async () => { clock.now += 5; });
  return sendTimesLine(turnId);
});

beforeEach(() => {
  clock.now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("send timing is off unless the switch is exactly 1, and then each send gives one line", async () => {
  vi.stubEnv(SWITCH, undefined);
  expect(await timedSend("unset")).toBeUndefined();
  vi.stubEnv(SWITCH, "0");
  expect(await timedSend("zero")).toBeUndefined();
  vi.stubEnv(SWITCH, "true");
  expect(await timedSend("word")).toBeUndefined();
  vi.stubEnv(SWITCH, "1");
  expect(await timedSend("on")).toMatch(/^send on first token \d+ ms: /);
});

it("the first-token line counts every mark and span in milliseconds since the request came in", async () => {
  vi.stubEnv(SWITCH, "1");
  clock.now = 5000;
  const line = await withSendTimes(async () => {
    clock.now += 12;
    sendMark("lease");
    await Promise.resolve();
    clock.now += 8;
    await sendSpan("gpu-read", async () => { clock.now += 19; });
    clock.now += 81;
    sendMark("model-request");
    clock.now += 1720;
    return sendTimesLine("turn-1");
  });
  expect(line).toBe("send turn-1 first token 1840 ms: lease 12, gpu-read 20-39, model-request 120, first-token 1840");
});

it("with timing off a send runs its work as it is, and with timing on each send starts a fresh record", async () => {
  vi.stubEnv(SWITCH, undefined);
  const answer = { reply: "kept" };
  expect(withSendTimes(() => answer)).toBe(answer);
  expect(withSendTimes(() => { sendMark("lease"); return sendTimesLine("off"); })).toBeUndefined();
  vi.stubEnv(SWITCH, "1");
  const first = withSendTimes(() => { sendMark("first-only"); return sendTimesLine("a"); });
  clock.now += 300;
  const second = withSendTimes(() => { sendMark("second-only"); return sendTimesLine("b"); });
  expect(first).toBe("send a first token 0 ms: first-only 0, first-token 0");
  expect(second).toBe("send b first token 0 ms: second-only 0, first-token 0");
});

it("a mark lands in the line only inside a timed send, after any awaits, and a mark outside a send goes nowhere", async () => {
  vi.stubEnv(SWITCH, "1");
  sendMark("stray");
  const line = await withSendTimes(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.now += 7;
    sendMark("admit");
    return sendTimesLine("t");
  });
  expect(line).toBe("send t first token 7 ms: admit 7, first-token 7");
  expect(sendTimesLine("outside")).toBeUndefined();
});

it("a span records its start and end in a timed send, even when its work throws, and passes the work's answer through either way", async () => {
  vi.stubEnv(SWITCH, "1");
  expect(await sendSpan("untimed", async () => "plain")).toBe("plain");
  const line = await withSendTimes(async () => {
    clock.now += 3;
    expect(await sendSpan("ps", async () => { clock.now += 2; return "listed"; })).toBe("listed");
    await expect(sendSpan("show", async () => { clock.now += 4; throw new Error("gone"); })).rejects.toThrow("gone");
    return sendTimesLine("t");
  });
  expect(line).toBe("send t first token 9 ms: ps 3-5, show 5-9, first-token 9");
});

it("a send's first-token line comes out once, however many tokens follow", async () => {
  vi.stubEnv(SWITCH, "1");
  const lines = withSendTimes(() => [sendTimesLine("t"), sendTimesLine("t"), sendTimesLine("t")]);
  expect(lines).toEqual(["send t first token 0 ms: first-token 0", undefined, undefined]);
});

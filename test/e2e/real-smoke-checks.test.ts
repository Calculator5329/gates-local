import { expect, test } from "vitest";
import { assertContextCopied, assertInterruptedCancellation, randomContextWord, REAL_SMOKE_URL, requireRealSmokeUrl } from "./real-smoke-checks.ts";

test("only the wrapper's exact endpoint is admitted before requests", () => {
  expect(requireRealSmokeUrl(REAL_SMOKE_URL)).toBe(REAL_SMOKE_URL);
  for (const value of [undefined, "http://127.0.0.1:8188", "http://127.0.0.1:11434", "http://127.0.0.1:11444", "http://127.0.0.1:16196", `${REAL_SMOKE_URL}/`, `${REAL_SMOKE_URL}?other=1`, "http://localhost:16195", "https://127.0.0.1:16195"]) {
    expect(() => requireRealSmokeUrl(value), String(value)).toThrow("Real smoke refuses this endpoint");
  }
});

test("a cancelled reply's natural completion cannot pass as Stop", () => {
  expect(() => assertInterruptedCancellation("cancelled mid-stream; no done event")).not.toThrow();
  expect(() => assertInterruptedCancellation("cancelled as the reply finished; not saved")).toThrow("Stop must interrupt generation");
});

test("context accepts an earlier-prompt echo but refuses a different word", () => {
  const word = randomContextWord();
  expect(word).toMatch(/^(?:[bdfghjklmnprstvz][aeiou]){6}$/);
  expect(() => assertContextCopied(`My name is ${word}. Remember my name.`, word)).not.toThrow();
  expect(() => assertContextCopied("I do not know your name.", word)).toThrow("real model must copy the random word");
});

import { expect, it } from "vitest";
import { contextWords, estimateTokens, fitRound, fitToWindow } from "./window.ts";

it("budgets images in both plain and tool rounds, dropping older images with their turn", () => {
  const image = { role: "user" as const, content: "look", images: ["bytes"] };
  expect(fitToWindow([image], 2048).ok).toBe(false);
  expect(fitToWindow([image, { role: "assistant", content: "seen" }, { role: "user", content: "next" }], 2048)).toMatchObject({ ok: true, omittedImages: 1, messages: [{ content: expect.stringContaining("image was here and is unavailable") }, { role: "user", content: "next" }] });
  expect(fitRound([image], 1, 2048)).toBeUndefined();
  expect(fitRound([image], 1, 8192)).toEqual([image]);
});

it("does not undercount a near-full three-image request above the reply reserve", () => {
  const image = { role: "user" as const, content: "x".repeat(1000 * 4), images: ["bytes", "bytes", "bytes"], imageTokens: [3144, 3144, 3144] };
  expect(fitToWindow([image], 12288).ok).toBe(false);
  expect(fitRound([image], 1, 12288)).toBeUndefined();
});

const sized = (tokens: number) => [{ role: "user" as const, content: "x".repeat((tokens - estimateTokens("")) * 4) }];

it("counts four characters as one token", () => {
  expect(estimateTokens("x".repeat(800)) - estimateTokens("x".repeat(400))).toBe(100);
  expect(estimateTokens("x".repeat(401)) - estimateTokens("x".repeat(400))).toBe(1);
});

it("keeps at most 2,048 tokens for the reply, so a large window spends the rest on the chat", () => {
  expect(fitToWindow(sized(32768 - 2048), 32768).ok).toBe(true);
  expect(fitToWindow(sized(32768 - 2048 + 1), 32768).ok).toBe(false);
});

it("names a window under 1,024 tokens by its count and a larger one in thousands", () => {
  expect(contextWords(512)).toBe("512");
  expect(contextWords(1000)).toBe("1000");
  expect(contextWords(2048)).toBe("2k");
});

it("cuts the oldest tool result first and sends a newer one whole when that is enough", () => {
  const older = "a".repeat(4000);
  const newer = "b".repeat(4000);
  const history = [
    { role: "system" as const, content: "tools" },
    { role: "user" as const, content: "read both" },
    { role: "tool" as const, content: older, tool_name: "read" },
    { role: "tool" as const, content: newer, tool_name: "read" },
  ];
  const sent = fitRound(history, 2, 2048);
  expect(sent?.map((m) => m.content.slice(0, 1))).toEqual(["t", "r", "a", "b"]);
  expect(sent?.[2]?.content).toMatch(/^a+\n\[cut: this model's context window is full\]$/);
  expect(sent?.[2]?.content.length).toBeLessThan(older.length);
  expect(sent?.[3]?.content).toBe(newer);
});

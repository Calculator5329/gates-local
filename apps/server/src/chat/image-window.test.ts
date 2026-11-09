import { expect, it } from "vitest";
import { fitRound, fitToWindow } from "./window.ts";

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

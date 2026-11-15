// Decision 18: the pop-up backdrop blurs only when a GPU draws the page.
import { expect, it, vi } from "vitest";
import { hardwareContext } from "./gpu-draw.ts";

const RENDERER = 0x1f01, UNMASKED = 0x9246;
/** A WebGL context that names `renderer`; `masked`: the browser hides the unmasked name. */
const context = (renderer: string, masked = false) => {
  const lose = vi.fn();
  const gl = {
    RENDERER,
    getExtension: (name: string) => name === "WEBGL_debug_renderer_info" ? (masked ? null : { UNMASKED_RENDERER_WEBGL: UNMASKED }) : name === "WEBGL_lose_context" ? { loseContext: lose } : null,
    getParameter: (p: number) => (p === UNMASKED || p === RENDERER ? renderer : null),
  };
  return { gl: gl as unknown as WebGLRenderingContext, lose };
};

it.each([
  ["ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11 vs_5_0 ps_5_0)", true],
  ["Mesa Intel(R) UHD Graphics 620 (KBL GT2)", true],
  ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", false],
  ["llvmpipe (LLVM 19.1.7, 256 bits)", false],
  ["ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)", false],
])("%s draws on a GPU: %s, and the probe's context is released", (renderer, gpu) => {
  const { gl, lose } = context(renderer);
  expect(hardwareContext(gl)).toBe(gpu);
  expect(lose).toHaveBeenCalledTimes(1);
});

it("reads the plain renderer when the browser hides the unmasked one", () => {
  expect(hardwareContext(context("WebKit WebGL", true).gl)).toBe(true);
  expect(hardwareContext(context("SwiftShader", true).gl)).toBe(false);
});

it("no context at all (refused for a major performance caveat) is no GPU", () => {
  expect(hardwareContext(null)).toBe(false);
});

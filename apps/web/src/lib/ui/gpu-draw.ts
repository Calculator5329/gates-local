// Whether a GPU draws this page, for effects that cost a frame budget only software drawing lacks
// (the pop-up backdrop's blur, decision 18). Asked once per page: a throwaway WebGL context is
// refused when the browser would draw it in software (failIfMajorPerformanceCaveat), and a context
// that is granted but names a software renderer (SwiftShader, llvmpipe, Microsoft Basic Render
// Driver) counts as none. The context is released at once.

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/** The renderer's name as WebGL reports it, or "" when the browser hides it. */
function rendererOf(gl: WebGLRenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name: unknown = info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
  return typeof name === "string" ? name : "";
}

/** True when the context exists and its renderer is not a software one. */
export function hardwareContext(gl: WebGLRenderingContext | null): boolean {
  if (gl === null) return false;
  try {
    return !SOFTWARE.test(rendererOf(gl));
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

let known: boolean | undefined;

export function gpuDraws(): boolean {
  if (known !== undefined) return known;
  try {
    const canvas = document.createElement("canvas");
    known = hardwareContext(canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true }));
  } catch {
    known = false;
  }
  return known;
}

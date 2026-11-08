// Window keys the default menu used to give. Linux and Windows run with no
// application menu (Ethan, 2026-11-07: no File/Edit/View/Window bar), so the
// zoom shortcuts come back here. Copy, paste and select-all are Chromium's
// own editing keys and need no menu outside macOS.

export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
}

/** One zoom step per press, and the bounds Chromium's own zoom menu keeps. */
export const ZOOM_STEP = 0.5;
export const ZOOM_MIN = -3;
export const ZOOM_MAX = 4.5;

/**
 * The zoom level after this key, or null when the key is not a zoom key.
 * Ctrl (Cmd on macOS) with = or +, - or _, and 0; never with Alt.
 */
export function zoomAfter(input: KeyInput, level: number, platform: NodeJS.Platform): number | null {
  if (input.type !== "keyDown" || input.alt) return null;
  const mod = platform === "darwin" ? input.meta : input.control;
  if (!mod) return null;
  switch (input.key) {
    case "=":
    case "+":
      return Math.min(ZOOM_MAX, level + ZOOM_STEP);
    case "-":
    case "_":
      return Math.max(ZOOM_MIN, level - ZOOM_STEP);
    case "0":
      return 0;
    default:
      return null;
  }
}

/** Linux and Windows get no menu bar; macOS keeps its default menu (its Edit menu carries copy and paste). */
export const hidesMenu = (platform: NodeJS.Platform): boolean => platform !== "darwin";

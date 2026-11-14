// A model's measured speed on this computer, as a gauge and "102 tok/s" (the unit the reply meta and Usage use), or
// nothing at all. Never an estimate: the number is the server's
// models.speed (completion tokens over decode time, last 14 days).
import { Icon } from "./icons.tsx";
import { modelNameKey } from "./pick.ts";
import { NA, type State, useStore } from "./store.ts";

/** "102" from 10 up, "8.4" below; nothing for zero, a value that rounds to zero, or anything not a finite number. */
function speedNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const tenths = Math.round(value * 10) / 10;
  if (tenths <= 0) return undefined;
  return tenths >= 10 ? String(Math.round(value)) : tenths.toFixed(1);
}

/** "102 tok/s" from 10 up, "8.4 tok/s" below; nothing where speedNumber gives nothing. */
export function tpsText(value: unknown): string | undefined {
  const n = speedNumber(value);
  return n === undefined ? undefined : withUnit(n);
}

const withUnit = (n: string) => `${n} tok/s`;
const spoken = (n: string) => `${n} tokens per second`;

const speedIn = (speeds: State["speeds"], tag: string) => (speeds === undefined || speeds === NA ? undefined : speeds[modelNameKey(tag)]);
const speedOf = (s: State, tag: string) => speedIn(s.speeds, tag);

/** "102 tokens per second" for a row that announces its facts in words, or nothing. */
export function speedWords(speeds: State["speeds"], tag: string): string | undefined {
  const n = speedNumber(speedIn(speeds, tag)?.tokensPerSecond);
  return n === undefined ? undefined : spoken(n);
}

/** Renders nothing, and so takes no width, until the model has a measured speed. */
export function ModelSpeed({ tag }: { tag: string }) {
  const speed = useStore((s) => speedOf(s, tag));
  const n = speedNumber(speed?.tokensPerSecond);
  if (speed === undefined || n === undefined) return null;
  return (
    <span className="tps">
      <Icon id="speed" cls="s14" />
      <span aria-label={spoken(n)}>{withUnit(n)}</span>
    </span>
  );
}

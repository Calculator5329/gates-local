import { Icon } from "../lib/ui/icons.tsx";
import { modelNameKey } from "./pick.ts";
import { NA, type State, useStore } from "../lib/store/store.ts";

export function speedNumber(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const tenths = Math.round(value * 10) / 10;
  if (tenths <= 0) return undefined;
  return tenths >= 10 ? String(Math.round(value)) : tenths.toFixed(1);
}

export function tpsText(value: unknown): string | undefined {
  const n = speedNumber(value);
  return n === undefined ? undefined : withUnit(n);
}

const withUnit = (n: string) => `${n} tok/s`;
const spoken = (n: string) => `${n} tokens per second`;

const speedIn = (speeds: State["speeds"], tag: string) => (speeds === undefined || speeds === NA ? undefined : speeds[modelNameKey(tag)]);
const speedOf = (s: State, tag: string) => speedIn(s.speeds, tag);

export function speedWords(speeds: State["speeds"], tag: string): string | undefined {
  const n = speedNumber(speedIn(speeds, tag)?.tokensPerSecond);
  return n === undefined ? undefined : spoken(n);
}

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

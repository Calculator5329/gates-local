// A model's measured speed on this computer, as a gauge and "102 TPS", or
// nothing at all. Never an estimate: the number is the server's
// models.speed (completion tokens over decode time, last 14 days).
import { Icon } from "./icons.tsx";
import { modelNameKey } from "./pick.ts";
import { NA, type State, useStore } from "./store.ts";

/** "102 TPS" from 10 up, "8.4 TPS" below; nothing for zero, a value that rounds to zero, or anything not a finite number. */
export function tpsText(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const tenths = Math.round(value * 10) / 10;
  if (tenths <= 0) return undefined;
  return tenths >= 10 ? `${Math.round(value)} TPS` : `${tenths.toFixed(1)} TPS`;
}

export const speedTip = (replies: number): string =>
  `Measured on this computer over the last 14 days · ${replies} ${replies === 1 ? "reply" : "replies"}`;

const speedIn = (speeds: State["speeds"], tag: string) => (speeds === undefined || speeds === NA ? undefined : speeds[modelNameKey(tag)]);
const speedOf = (s: State, tag: string) => speedIn(s.speeds, tag);

/** "102 tokens per second" for a row that announces its facts in words, or nothing. */
export function speedWords(speeds: State["speeds"], tag: string): string | undefined {
  const text = tpsText(speedIn(speeds, tag)?.tokensPerSecond);
  return text === undefined ? undefined : `${text.slice(0, -4)} tokens per second`;
}

/** Renders nothing, and so takes no width, until the model has a measured speed. */
export function ModelSpeed({ tag }: { tag: string }) {
  const speed = useStore((s) => speedOf(s, tag));
  const text = tpsText(speed?.tokensPerSecond);
  if (speed === undefined || text === undefined) return null;
  return (
    <span className="tps" data-tip={speedTip(speed.replies)}>
      <Icon id="speed" cls="s14" />
      <span aria-label={`${text.slice(0, -4)} tokens per second`}>{text}</span>
    </span>
  );
}

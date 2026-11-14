// The quiet line above a turn answered by another thing than the turn before (owner, 2026-11-13:
// "it tells you in a chat if you've changed models mid-chat"): marks and names, old then new, an
// arrow between, no sentence. model-change.ts finds where.
import { describeModel } from "./format.ts";
import { Icon } from "./icons.tsx";
import { ImageMark } from "./ImageMark.tsx";
import { MakerMark } from "./MakerMark.tsx";
import { presetOf } from "./image-choice.ts";
import type { Answerer, Change } from "./model-change.ts";
import { NA, type State, useStore } from "./store.ts";

/** A name as the composer's button says it: a chat model's, or an image preset's short name. */
const nameOf = (s: State, by: Answerer): string => {
  if (by.kind === "chat") return describeModel(by.model, s.catalog === NA ? undefined : s.catalog).name;
  const preset = presetOf(s, by.preset);
  return preset?.short ?? preset?.name ?? by.preset;
};

function Who({ by }: { by: Answerer }) {
  const name = useStore((s) => nameOf(s, by));
  const family = useStore((s) => (by.kind === "image" ? presetOf(s, by.preset)?.family : undefined));
  return (
    <span className="mc-who">
      {by.kind === "chat" ? <MakerMark tag={by.model} /> : family === undefined ? <Icon id="image" /> : <ImageMark family={family} />}
      <span className="mc-name">{name}</span>
    </span>
  );
}

export function ModelChange({ change }: { change: Change }) {
  const words = useStore((s) => `${nameOf(s, change.from)} to ${nameOf(s, change.to)}`);
  return (
    <div className="model-change" role="note" aria-label={words} data-testid="chat.thread.model-change">
      <Who by={change.from} />
      <Icon id="arrow" cls="s14" />
      <Who by={change.to} />
    </div>
  );
}

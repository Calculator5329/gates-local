import type { FitWords } from "@gates-local/contracts";
import { CONTEXT_SIZES, describeModel, gb, k } from "../lib/words/format.ts";
import { openFit } from "../fit/fit-actions.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { MakerMark } from "../models/MakerMark.tsx";
import { getDraft } from "../lib/store/drafts.ts";
import { chooseForQueued, freeMemory, pickModel, send, sendQueuedNow, setContext, updateSettings } from "../lib/session/index.ts";
import { NA, type NoticeOffer, type State, getState, setState, useStore, waitingReplies } from "../lib/store/store.ts";
import { closeTip } from "../lib/ui/ui.tsx";

const catalogOf = (s: Pick<State, "catalog">) => (s.catalog === NA ? undefined : s.catalog);

export function takeOffer(kind: "context" | "model"): void {
  const s = getState();
  const o = s.noticeOffer;
  if (o === null || o.notice !== s.notice) return;
  const choice = kind === "context" ? o.offer.context : o.offer.model;
  if (choice === undefined) return;
  const model = o.offer.model !== undefined && kind === "model" ? o.offer.model.model : o.model;
  closeTip();
  setState({ notice: null, noticeOffer: null });
  const size = CONTEXT_SIZES.find((c) => c === choice.numCtx);
  if (size !== undefined) setContext(size);
  if (s.model !== model) pickModel(model);
  const draft = getDraft();
  if (draft.text.trim() !== "" || draft.images.length > 0 || (draft.files?.length ?? 0) > 0) {
    void send(draft.text);
    return;
  }
  const held = waitingReplies(s).find((q) => q.threadId === s.threadId && q.stage === "held");
  if (held === undefined) return;
  void chooseForQueued(held.id, model, choice.numCtx).then((chosen) => { if (chosen) sendQueuedNow(held.id); });
}

export async function takeFree(remember: boolean): Promise<void> {
  const s = getState();
  const o = s.noticeOffer;
  const free = o?.offer.free;
  if (o === null || o.notice !== s.notice || free === undefined || free.length === 0) return;
  closeTip();
  setState({ notice: null, noticeOffer: null });
  const failed = (remember ? await updateSettings({ freeOthers: true }) : null) ?? await freeMemory(free);
  if (failed !== null) {
    setState({ notice: failed });
    return;
  }
  const draft = getDraft();
  if (draft.text.trim() !== "" || draft.images.length > 0 || (draft.files?.length ?? 0) > 0) {
    void send(draft.text);
    return;
  }
  const held = waitingReplies(s).find((q) => q.threadId === s.threadId && q.stage === "held");
  if (held !== undefined) sendQueuedNow(held.id);
  else pickModel(o.model);
}

export const Slower =({ words }: { words: FitWords | undefined }) =>
  words?.k !== "spill" ? null : <span className="co-slow" role="img" aria-label={words.short} data-tip={words.short} data-testid="chat.composer.offer-slower"><Icon id="gauge" /></span>;

export function RefusalNote({ o }: { o: NoticeOffer }) {
  const catalog = useStore(catalogOf);
  const name = (tag: string) => describeModel(tag, catalog).name;
  const remembers = useStore((s) => s.unavailable["settings.update"] !== true);
  const { context, model, short, free } = o.offer;
  return (
    <p className="na c-note no c-offer" data-testid="chat.composer.offer" role="status">
      <Icon id="alert" cls="s12" />
      <span className="co-what">{name(o.model)} · {k(o.numCtx)}</span>
      {free !== undefined && free.length > 0 ? (
        <>
          <span className="co-short" data-testid="chat.composer.offer-held">
            {free.map((h) => `${h.kind === "model" ? name(h.name) : h.name} holds ${gb(h.bytes)}`).join(" · ")}
          </span>
          <button type="button" className="co-act" data-testid="chat.composer.offer-free" onClick={() => void takeFree(false)}>Free it</button>
          {remembers ? (
            <button type="button" className="co-act" data-testid="chat.composer.offer-free-always" onClick={() => void takeFree(true)}>Don't ask again</button>
          ) : null}
        </>
      ) : context === undefined && model === undefined ? (
        <>
          <span className="co-short" data-testid="chat.composer.offer-short">
            needs {gb(short.needBytes)} · GPU {gb(short.gpuBytes)} + RAM {gb(short.ramBytes)} · {gb(short.shortBytes)} short
          </span>
          <button type="button" className="co-act sq" data-testid="chat.composer.offer-details" aria-label="Memory details" data-tip="Memory details" onClick={() => openFit(o.model)}>
            <Icon id="gauge" />
          </button>
        </>
      ) : (
        <>
          <Icon id="right" cls="s12 co-to" />
          {context === undefined ? null : (
            <button type="button" className="co-act" data-testid="chat.composer.offer-context" onClick={() => takeOffer("context")}>
              <span>{k(context.numCtx)}</span>
              <Slower words={context.words} />
            </button>
          )}
          {model === undefined ? null : (
            <button type="button" className="co-act" data-testid="chat.composer.offer-model" onClick={() => takeOffer("model")}>
              <MakerMark tag={model.model} />
              <span>{name(model.model)}</span>
              <small>{k(model.numCtx)}</small>
              <Slower words={model.words} />
            </button>
          )}
        </>
      )}
    </p>
  );
}

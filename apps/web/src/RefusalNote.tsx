// The note a memory refusal leaves under the box (WIN-MEM-02, docs/evidence/windows-low-memory-bug-report.md):
// what was refused, then at most two buttons for what runs instead, the smaller context and the other
// model, each one click that makes the change and sends the waiting words. A choice that runs partly in
// system memory carries the slower mark, once. Nothing runs: one line of numbers, the GPU's and system
// memory's apart, and the memory details behind one control. The server works the offer out from the
// reading that refused (fit/alternatives.ts); the note shows it and holds no verdict of its own.
import { CONTEXT_SIZES, describeModel, gb, k } from "./format.ts";
import { openFit } from "./fit-actions.ts";
import { Icon } from "./icons.tsx";
import { MakerMark } from "./MakerMark.tsx";
import { getDraft } from "./drafts.ts";
import { pickModel, send, sendQueuedNow, setContext } from "./session.ts";
import { NA, type NoticeOffer, type State, getState, setState, useStore } from "./store.ts";
import { closeTip } from "./ui.tsx";

const catalogOf = (s: Pick<State, "catalog">) => (s.catalog === NA ? undefined : s.catalog);

/**
 * Take the offer's context or model: the change, then the waiting words go out, the box's or this
 * chat's message held by the refusal. Nothing happens when the note has moved on.
 */
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
  const held = s.queued.find((q) => q.threadId === s.threadId && q.held === true && q.waitFor === "reply");
  if (held === undefined) return;
  setState((st) => ({ queued: st.queued.map((q) => (q.id === held.id ? { ...q, model } : q)) }));
  sendQueuedNow(held.id);
}

/** The slower mark: part of the model runs in system memory. Its tip names it and nothing more. */
const Slower = () => <span className="co-slow" role="img" aria-label="slower" data-tip="Slower" data-testid="chat.composer.offer-slower"><Icon id="gauge" /></span>;

export function RefusalNote({ o }: { o: NoticeOffer }) {
  const catalog = useStore(catalogOf);
  const name = (tag: string) => describeModel(tag, catalog).name;
  const { context, model, short } = o.offer;
  return (
    <p className="na c-note no c-offer" data-testid="chat.composer.notice" role="status">
      <Icon id="alert" cls="s12" />
      <span className="co-what">{name(o.model)} · {k(o.numCtx)}</span>
      {context === undefined && model === undefined ? (
        <>
          {/* nothing runs: what is short, in numbers, the GPU and system memory apart */}
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
              {context.verdict === "spills" ? <Slower /> : null}
            </button>
          )}
          {model === undefined ? null : (
            <button type="button" className="co-act" data-testid="chat.composer.offer-model" onClick={() => takeOffer("model")}>
              <MakerMark tag={model.model} />
              <span>{name(model.model)}</span>
              <small>{k(model.numCtx)}</small>
              {model.verdict === "spills" ? <Slower /> : null}
            </button>
          )}
        </>
      )}
    </p>
  );
}

// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The composer (shell.md F01, F02, F15, F28-F31, F34, F37b, F43b): the text
// box, model and context chips, Thinking and Image pills, the context meter,
// Send or Stop, and the popovers it opens (model picker, + menu).
import { type KeyboardEvent, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextSize, ModelInfo } from "@gates-local/contracts";
import { useActionPress } from "./composer-press.ts";
import { PLACEHOLDER, rtOf } from "./Banner.tsx";
import { openFit } from "./fit-actions.ts";
import { CONTEXT_SIZES, type Verdict, ctxFor, describeModel, gb, k, modelFacts, noGpu, verdictOf } from "./format.ts";
import { Icon, SendArrow } from "./icons.tsx";
import { awaitingInstall, canThink, chatBlockedReason, chatModels, modelNameKey, pickRuleText, pickedModel } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import {
  cancelQueuedEdit,
  cancelStopAsk,
  confirmStopAsk,
  editQueued,
  ensureFit,
  firstPull,
  openSettings,
  pickModel,
  pull,
  queueReason,
  removeQueued,
  send,
  sendQueuedNow,
  setContext,
  stop,
} from "./session.ts";
import { NA, type Queued, type State, editDraft, fitKey, getState, setState, streamingHere, useStore } from "./store.ts";
import { PHONE, SheetHead, closePop, closeTip, esc, isPhone, isTouch, place, togglePop, useMedia } from "./ui.tsx";
const Voice = lazy(() => import("./Voice.tsx").then((m) => ({ default: m.Voice })));

const catalogOf = (s: Pick<State, "catalog">) => (s.catalog === NA ? undefined : s.catalog);
const imageGenOf = (s: State) => s.settings !== NA && s.settings?.imageGen === true;
const pctOf = (done: number, total: number | undefined) => (total ? Math.round((done / total) * 100) : 0);

// The first send replaces Draft's composer with the thread's in the same commit.
// Transfer primary-action focus only to that immediate replacement.
let primaryFocus = false;

/** Tokens the open thread holds: the last reply's prompt plus its answer. */
function usedTokens(s: State): number {
  if (s.view !== "thread" || s.threadId === null) return 0;
  const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "assistant" && m.stats !== undefined);
  return (last?.stats?.promptTokens ?? 0) + (last?.stats?.completionTokens ?? 0);
}

function verdictFor(s: Pick<State, "fits" | "numCtx" | "catalog">, model: string): Verdict | undefined {
  const measured = s.catalog === NA ? undefined : s.catalog?.find((c) => c.name === model)?.fit;
  const r = s.fits[fitKey(model, s.numCtx)] ?? (measured?.numCtx === s.numCtx ? measured : undefined);
  return r === undefined || r === "error" ? undefined : verdictOf(r);
}

/**
 * Why the Thinking pill cannot be used now, or null when it can. It
 * depends on the model's "thinking" capability, so it waits for a chat
 * model to be installed (F70) and greys for a model without it.
 */
export function thinkUnavailable(model: ModelInfo | undefined, name: string, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Available when the model finishes downloading.";
  if (!canThink(model)) return `<b>Thinking</b> is not available: ${esc(name)} does not reason before answering. Pick a model that does, such as Qwen 3.5 9B.`;
  return null;
}

/** The same answer as plain words for a phone's menu row, which has no tooltip. */
function thinkNote(model: ModelInfo | undefined, name: string, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Available when the model finishes downloading";
  return canThink(model) ? null : `${name} does not reason before answering`;
}

function tagTip(name: string, m: ModelInfo | undefined, tag: string): string {
  const q = modelFacts(m).quant;
  // a tag the catalog does not know is its own name: say it once, and its quant only when the tag does not
  const head = name === tag ? `<b class="mono">${esc(tag)}</b>` : `<b>${esc(name)}</b> · <span class="mono">${esc(tag)}</span>`;
  return `${head}${q && !tag.toLowerCase().includes(q.toLowerCase()) ? ` · ${esc(q)}` : ""}`;
}

export function Composer() {
  const rt = useStore(rtOf);
  const model = useStore((s) => s.model);
  const numCtx = useStore((s) => s.numCtx);
  const think = useStore((s) => s.think);
  const image = useStore((s) => s.image);
  const draft = useStore((s) => s.draft);
  const notice = useStore((s) => s.notice);
  const fit = useStore((s) => (s.model === undefined ? undefined : s.fits[fitKey(s.model, s.numCtx)]));
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const imageGen = useStore(imageGenOf);
  const isStreaming = useStore(streamingHere);
  const editingId = useStore((s) => s.editingQueued);
  const editing = editingId !== null;
  const running = useStore((s) => streamingHere(s) ? (s.live?.gen ?? null) : null);
  const touch = useMedia("(hover: none)");
  const freed = useStore((s) => s.model !== undefined && s.stopFrees[fitKey(s.model, s.numCtx)] === true);
  const wait = useStore(queueReason);
  const first = useStore(firstPull);
  const firstProgress = useStore((s) => {
    const p = first === undefined ? undefined : s.pulls[first];
    return p ? pctOf(p.completedBytes, p.totalBytes) : 0;
  });
  const loadState = useStore((s) => (s.model === undefined ? undefined : s.loads[s.model]?.state));
  const used = useStore(usedTokens);
  const pop = useStore((s) => s.pop?.id ?? null);
  const view = useStore((s) => s.view);
  const voiceThread = useStore((s) => s.threadId);
  const ta = useRef<HTMLTextAreaElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = primary.current;
    if (primaryFocus) button?.focus();
    primaryFocus = false;
    return () => {
      primaryFocus = document.activeElement === button;
      queueMicrotask(() => { primaryFocus = false; });
    };
  }, []);

  const ready = rt === "ready";
  useEffect(() => {
    if (ready) ensureFit(model, numCtx);
  }, [ready, model, numCtx, fit]);

  const blocked = !ready;
  const queueable = wait !== null;
  const shownTag = first ?? model;
  const info = models?.find((m) => m.name === shownTag);
  const name = shownTag === undefined ? "No model" : describeModel(shownTag, catalog).name;
  const loading = loadState === "loading";
  // The verdict holds still: between an invalidation and the fresh answer the last one for this
  // model and context stays, and while the model loads it keeps the one from before the load
  // (its own memory filling the GPU, not yet listed by Ollama, is no reason to refuse it).
  // A failed check ends the hold: the old verdict no longer says anything about memory now.
  const fitAt = model === undefined ? "" : fitKey(model, numCtx);
  const failed = fit === "error";
  const fresh = fit === undefined || failed ? undefined : verdictOf(fit);
  const held = useRef<{ at: string; v: Verdict } | undefined>(undefined);
  if (failed) held.current = undefined;
  const kept = held.current?.at === fitAt ? held.current.v : undefined;
  const v = loading ? (kept ?? fresh) : (fresh ?? kept);
  if (!loading && fresh !== undefined) held.current = { at: fitAt, v: fresh };
  const text = draft.trim();
  const why = chatBlockedReason(models, model); // a download would not help: old Ollama, or the model is still being checked
  const noModel = (model === undefined || why !== undefined) && !queueable;
  // During setup the gate style already greys every control; otherwise the pill says why it is off.
  const thinkNa = blocked ? null : thinkUnavailable(models?.find((m) => m.name === model), name, first !== undefined);

  const modelLbl =
    rt === "installing" ? `${name} · downloads next` : first !== undefined ? `${name} · downloading ${firstProgress}%` : name;
  const modelTip =
    shownTag === undefined
      ? "No model is installed yet. Download one in Settings › Models."
      : loading
        ? `${tagTip(name, info, shownTag)}<br>Loading into GPU memory…`
        : `${tagTip(name, info, shownTag)}${info ? ` · ${gb(info.sizeBytes)} on disk` : ""}`;

  const ctx = ctxFor(numCtx, models, model);
  const pct = Math.min(1, used / ctx);
  const meterHidden = pct < 0.5 || blocked || view !== "thread";

  const placeholder = first !== undefined && !blocked ? "Type now; it sends when the download finishes" : noModel && ready ? (why ?? "Download a model to start chatting") : PLACEHOLDER[rt];

  // the placeholder counts: a long one wraps on a phone, and it changes as the runtime comes up
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft, placeholder]);

  // A message queued behind a reply is checked when it goes, and memory a reply holds may be freed by stopping it.
  const memNo = v?.k === "no" && !isStreaming && !freed && !editing;
  const enter = touch ? "" : " (Enter)";
  let sendTip = `Send${enter}`;
  if (editing) sendTip = text ? `Update the queued message${enter}` : "Type the message to queue";
  else if (isStreaming && !blocked) sendTip = text ? `Queue${enter}. It sends when this reply finishes` : "Type now; it sends when this reply finishes";
  else if (queueable) sendTip = `${text ? `Send${enter}. It goes out when ` : "Type now; it sends when "}${wait === "download" ? "the download finishes" : "setup finishes"}`;
  else if (blocked) sendTip = "Chat starts when Ollama is ready";
  else if (noModel) sendTip = why ?? "Download a model to start chatting";
  else if (memNo) sendTip = `${esc(name)}: not enough memory at ${k(ctx)}. It needs an estimated ${gb(v.amt)} more. Pick a smaller model or context.<br>Click for GPU memory in Settings › Advanced.`;
  else if (!text) sendTip = "Type a message to send";
  else if (freed) sendTip = `Send${enter}. Another chat's reply is using this memory, so it stops first`;
  const sendDisabled = (blocked && !queueable) || (!blocked && memNo) || noModel || !text;
  // Refused for memory: the button stays focusable and clickable, and the click opens the why.
  const memRefused = !blocked && !queueable && !noModel && memNo;
  // T3 Code's composer: Enter never stops a reply; the words queue behind it.
  const sendLabel = editing ? "Update queued message" : isStreaming ? "Queue message" : "Send message";
  // Touch Enter inserts a newline, so a typed draft needs the queue arrow.
  const showStop = isStreaming && !editing && !(touch && text !== "");

  const submit = () => {
    if (sendDisabled) return;
    void send(draft);
  };
  const stopThisReply = () => {
    const s = getState();
    if (streamingHere(s) && s.live?.gen === running) stop();
  };
  const action = showStop ? `stop:${running}` : editing ? `edit:${editingId}` : memRefused ? `memory:${model}:${numCtx}` : isStreaming ? `queue:${running}` : "send";
  useLayoutEffect(() => closeTip(), [action]);
  const primaryPress = useActionPress(!showStop && sendDisabled && !memRefused ? `off:${action}` : action, () => {
    if (showStop) stopThisReply();
    else if (memRefused) openFit();
    else submit();
  });
  const compactStopPress = useActionPress(`stop:${running}`, () => {
    stopThisReply();
    primary.current?.focus();
  });

  return (
    <>
      <QueueTray />
      <StopWarning />
      {isStreaming ? (
        <div className="composer-running" data-running-status>
          <span>Reply running</span>
          {!showStop ? <button type="button" className="qa" aria-label="Stop reply" data-tip="Stop this reply. Your draft stays here" {...compactStopPress}>Stop</button> : null}
        </div>
      ) : null}
      <form
        className={`composer${blocked ? " blocked" : ""}`}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="att" />
        <textarea
          ref={ta}
          id="ta"
          className="ta"
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          value={draft}
          // the warning is about the words it was raised for
          onChange={(e) => editDraft(e.target.value)}
          onKeyDown={(e) => {
            // a touch keyboard's Enter is a new line; the send button sends
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch()) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="cf">
          <div className="cf-l">
            <button
              type="button"
              className="ctl sq gate"
              id="plusBtn"
              aria-haspopup="menu"
              aria-expanded={pop === "plus"}
              aria-label="Add"
              data-tip="Attach a file, add to your library, images"
              onClick={() => togglePop("plus")}
            >
              <Icon id="plus" />
            </button>
            <button
              type="button"
              className="ctl gate"
              id="modelBtn"
              aria-haspopup="dialog"
              aria-expanded={pop === "picker"}
              aria-busy={loading ? true : undefined}
              data-tip={modelTip}
              onClick={() => togglePop("picker")}
            >
              {/* loading shows in the tile, never in the label: the trigger keeps its width */}
              {shownTag === undefined ? null : <Mark name={name} busy={loading && first === undefined} />}
              <span>{modelLbl}</span>
              <Icon id="down" cls="chev" />
            </button>
            {imageGen ? (
              <button
                type="button"
                className="pill gate"
                aria-pressed={image}
                aria-label="Image"
                data-tip={
                  image
                    ? "<b>Image on.</b> The model may queue a ComfyUI job on this GPU. Click to turn off."
                    : "<b>Image off.</b> Click to let the model make images for this chat."
                }
                onClick={() => {
                  setState({ image: !image });
                  closeTip();
                }}
              >
                <Icon id="image" cls="lead" />
                <span className="plbl">Image</span>
              </button>
            ) : null}
            {meterHidden ? null : (
              <button
                type="button"
                className={`meter${pct > 0.85 ? " hi" : ""}`}
                aria-label="Context used"
                data-tip={`Context used: ${(used / 1000).toFixed(1)}k of ${k(ctx)} tokens`}
              >
                <span>Context {Math.round(pct * 100)}% used</span>
              </button>
            )}
            <button
              type="button"
              className={`pill gate thinking${thinkNa !== null ? " unavail" : ""}`}
              aria-pressed={thinkNa !== null ? false : think}
              aria-label="Thinking"
              aria-disabled={thinkNa !== null ? true : undefined}
              data-tip={
                thinkNa ??
                (think
                  ? "<b>Thinking on.</b> The model reasons first; shown as one collapsed line. Click to turn off."
                  : "<b>Thinking off.</b> Faster first token. Click to turn on.")
              }
              onClick={() => {
                if (thinkNa !== null) return;
                setState({ think: !think });
                closeTip();
              }}
            >
              <Icon id="bulb" cls="lead" />
              <span className="plbl">Thinking</span>
            </button>
          </div>
          <div className="cf-r">
            <Suspense fallback={<span className="ctl voice" />}><Voice key={`${view}:${voiceThread}`} textarea={ta} /></Suspense>
            {/* a phone has no room for the pills and the meter: they live in this sheet */}
            <button type="button" className="ctl sq gate" id="optBtn" aria-haspopup="menu" aria-expanded={pop === "opts"} aria-label="Chat options" onClick={() => togglePop("opts")}>
              <Icon id="sliders" />
            </button>
            <button
              ref={primary}
              type="button"
              className={showStop ? "send stop" : "send"}
              aria-label={showStop ? "Stop" : sendLabel}
              data-tip={showStop ? (touch ? "Stop. Type a message to queue it after this reply" : "Stop. Enter queues your message after this reply") : sendTip}
              // Keep the same focusable node through empty, running and finished states.
              aria-disabled={!showStop && sendDisabled ? true : undefined}
              {...primaryPress}
            >
              {showStop ? <span className="sqr" /> : <SendArrow />}
            </button>
          </div>
        </div>
      </form>
      {notice !== null ? (
        <p className="na c-note" role="status" tabIndex={0} data-tip={esc(notice)}>
          {notice}
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- queue and warning

function queueWords(q: Queued, editing: boolean): string {
  if (editing) return "Editing in the composer";
  if (q.waitFor === "download") return "Sends when the download finishes";
  if (q.waitFor === "setup") return "Sends when setup finishes";
  return q.held ? "On hold" : "Sends after this reply";
}

/** A click handler that leaves the typing cursor in the composer, where the next words go. */
const andFocus = (act: () => void) => () => {
  closeTip();
  act();
  focusComposer();
};

/** Messages waiting in this chat, above the composer as in T3 Code: each can go now, be edited in place, or be removed. */
function QueueTray() {
  const queued = useStore((s) => s.queued);
  const threadId = useStore((s) => s.threadId);
  const editingId = useStore((s) => s.editingQueued);
  const mine = queued.filter((q) => q.threadId === threadId);
  if (mine.length === 0) return null;
  const n = mine.length;
  return (
    <ul className="qt" aria-label={`${n} queued message${n === 1 ? "" : "s"}`}>
      {mine.map((q, i) => {
        const editing = q.id === editingId;
        return (
          <li key={q.id} className="qt-r" aria-label={`Queued message ${i + 1} of ${n}, not sent`}>
            <Icon id="clock" cls="s14" />
            <span className="qt-t">{q.text}</span>
            <span className="qt-s" role="status">
              {queueWords(q, editing)}
            </span>
            {q.waitFor === "reply" && !editing ? (
              <button type="button" className="qa" data-send-now data-tip={q.held ? "Send this now" : "Stop this reply and send this now"} onClick={andFocus(() => sendQueuedNow(q.id))}>
                Send now
              </button>
            ) : null}
            {editing ? (
              <button type="button" className="qa" onClick={andFocus(cancelQueuedEdit)}>
                Cancel editing
              </button>
            ) : (
              <button type="button" className="qa" data-edit-queued onClick={andFocus(() => editQueued(q.id))}>
                Edit
              </button>
            )}
            <button type="button" className="qa" data-unqueue data-tip="Remove from queue" onClick={andFocus(() => removeQueued(q.id))}>
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Qwen 3.5 9B in “Trip plans”", the one thing the warning has to name for each chat it would stop. */
function stopNames(blocking: NonNullable<State["stopAsk"]>["blocking"], catalog: ReturnType<typeof catalogOf>): string[] {
  return blocking.map((t) => `${describeModel(t.model, catalog).name} in ${t.title === "" ? "another chat" : `“${t.title}”`}`);
}

/** Shown once: a send needs a load that stops another chat's reply. */
function StopWarning() {
  const ask = useStore((s) => s.stopAsk);
  const catalog = useStore(catalogOf);
  const [never, setNever] = useState(false);
  useEffect(() => setNever(false), [ask]);
  if (ask === null) return null;
  const names = stopNames(ask.blocking, catalog);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return (
    <div
      className="stopask"
      role="alertdialog"
      aria-label="Stop the other reply?"
      onKeyDown={(e) => {
        if (e.key === "Escape") andFocus(cancelStopAsk)();
        // a held Enter from the message box must not answer the warning
        else if (e.key === "Enter" && e.repeat) e.preventDefault();
      }}
    >
      <p>
        This stops {list}. {names.length > 1 ? "Their replies so far are kept." : "Its reply so far is kept."}
      </p>
      <div className="stopask-f">
        <label className="stopask-n">
          <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
          Don't show this again
        </label>
        <button type="button" className="btn ghost" onClick={andFocus(cancelStopAsk)}>
          Cancel
        </button>
        <button type="button" className="btn primary" autoFocus onClick={andFocus(() => confirmStopAsk(never))}>
          Stop and send
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- + menu

export function PlusMenu() {
  const open = useStore((s) => s.pop?.id === "plus");
  const imageGen = useStore(imageGenOf);
  const image = useStore((s) => s.image);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = document.getElementById("plusBtn");
    if (open && ref.current && anchor) place(ref.current, anchor, "start");
  }, [open]);
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="plusMenu" role="menu" ref={ref}>
      <SheetHead title="Add" />
      <button type="button" className="mi" role="menuitem" aria-disabled="true" data-attach>
        <Icon id="clip" />
        <span>
          <b>Attach a file</b>
          <small>Not available in this build</small>
        </span>
      </button>
      <button
        type="button"
        className="mi"
        role="menuitem"
        data-lib
        onClick={() => {
          closePop();
          openSettings("library");
        }}
      >
        <Icon id="book" />
        <span>
          <b>Add to library…</b>
          <small>Stays for every chat</small>
        </span>
      </button>
      <div className="msep" />
      {imageGen ? (
        <button
          type="button"
          className="mi"
          role="menuitemcheckbox"
          aria-checked={image}
          data-gen
          onClick={() => {
            closePop();
            setState({ image: !image });
          }}
        >
          <Icon id="image" />
          <span>
            <b>Generate image</b>
            <small>ComfyUI on this GPU, for this chat</small>
          </span>
          <Icon id="check" cls="chk" />
        </button>
      ) : (
        <button
          type="button"
          className="mi"
          role="menuitem"
          data-gen
          onClick={() => {
            closePop();
            openSettings("images");
          }}
        >
          <Icon id="image" />
          <span>
            <b>Set up image generation…</b>
            <small>Off until you set it up</small>
          </span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- chat options (a phone's overflow)

export function OptsMenu() {
  const open = useStore((s) => s.pop?.id === "opts");
  const imageGen = useStore(imageGenOf);
  const think = useStore((s) => s.think);
  const image = useStore((s) => s.image);
  const used = useStore(usedTokens);
  const numCtx = useStore((s) => s.numCtx);
  const models = useStore((s) => s.models);
  const model = useStore((s) => s.model);
  const catalog = useStore(catalogOf);
  const first = useStore(firstPull);
  const ready = useStore(rtOf) === "ready";
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = document.getElementById("optBtn");
    if (open && ref.current && anchor) place(ref.current, anchor, "end");
  }, [open]);
  const ctx = ctxFor(numCtx, models, model); // what the model runs at, which a small one holds below what was asked for
  const pct = Math.min(1, used / ctx);
  const tag = first ?? model;
  const thinkNa = ready ? thinkNote(models?.find((m) => m.name === model), tag === undefined ? "No model" : describeModel(tag, catalog).name, first !== undefined) : null;
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="optsMenu" role="menu" aria-label="Chat options" ref={ref}>
      <SheetHead title="Chat options" />
      <button
        type="button"
        className={`mi${thinkNa !== null ? " off" : ""}`}
        role="menuitemcheckbox"
        aria-checked={thinkNa !== null ? false : think}
        aria-disabled={thinkNa !== null ? true : undefined}
        onClick={() => {
          if (thinkNa === null) setState({ think: !think });
        }}
      >
        <Icon id="bulb" />
        <span>
          <b>Thinking</b>
          <small>{thinkNa ?? (think ? "The model reasons first, shown as one line" : "Off: a faster first token")}</small>
        </span>
        <span className="switch" aria-hidden="true" />
      </button>
      {imageGen ? (
        <button type="button" className="mi" role="menuitemcheckbox" aria-checked={image} onClick={() => setState({ image: !image })}>
          <Icon id="image" />
          <span>
            <b>Image</b>
            <small>{image ? "The model may queue a ComfyUI job" : "Off: no image jobs in this chat"}</small>
          </span>
          <span className="switch" aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className="mi off" role="menuitemcheckbox" aria-checked={false} aria-disabled="true" data-image-off>
          <Icon id="image" />
          <span>
            <b>Image</b>
            <small>Set it up in Settings to use it</small>
          </span>
          <span className="switch" aria-hidden="true" />
        </button>
      )}
      {used > 0 ? (
        <div className="mi st">
          <Icon id="gauge" />
          <span>
            <b>Context {Math.round(pct * 100)}% used</b>
            <small>
              {(used / 1000).toFixed(1)}k of {k(ctx)} tokens
            </small>
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- model picker

interface Row {
  readonly tag: string;
  readonly name: string;
  readonly purpose: string;
  readonly v: Verdict | undefined;
  readonly downloading?: number;
  readonly info: ModelInfo | undefined;
  /** Refused only because another chat's reply holds the memory: pickable, and the send asks first. */
  readonly frees?: boolean;
}

const GROUPS = ["gpu", "spill", "no", "unknown"] as const;
type GroupKey = (typeof GROUPS)[number];

function pickerRows(s: Pick<State, "models" | "pulls" | "fits" | "numCtx" | "catalog" | "stopFrees">, q: string): Record<GroupKey, Row[]> {
  const catalog = catalogOf(s);
  const groups: Record<GroupKey, Row[]> = { gpu: [], spill: [], no: [], unknown: [] };
  const hit = (tag: string, name: string, purpose: string) =>
    q === "" || tag.toLowerCase().includes(q) || name.toLowerCase().includes(q) || purpose.toLowerCase().includes(q);
  // Embedding models never chat, so they are never a choice here.
  for (const m of chatModels(s.models ?? [])) {
    const d = describeModel(m.name, catalog);
    if (!hit(m.name, d.name, d.purpose)) continue;
    const v = verdictFor(s, m.name);
    const frees = v?.k === "no" && s.stopFrees[fitKey(m.name, s.numCtx)] === true;
    groups[frees ? "spill" : (v?.k ?? "unknown")].push({ tag: m.name, name: d.name, purpose: d.purpose, v, info: m, frees });
  }
  for (const p of Object.values(s.pulls)) {
    if (!awaitingInstall(p)) continue;
    if ((s.models ?? []).some((m) => modelNameKey(m.name) === modelNameKey(p.name))) continue;
    const d = describeModel(p.name, catalog);
    if (!hit(p.name, d.name, d.purpose)) continue;
    // at the picker's context, as installed rows are (the catalog's own fit is at the saved default)
    const v = verdictFor(s, p.name);
    groups[v?.k ?? "unknown"].push({ tag: p.name, name: d.name, purpose: d.purpose, v, downloading: pctOf(p.completedBytes, p.totalBytes), info: undefined });
  }
  return groups;
}

/** The quiet fit word at the end of a picker row. */
function fitWord(v: Verdict | undefined): string {
  if (v === undefined) return "Checking…";
  if (v.k === "gpu") return "Fits";
  if (v.k === "spill") return "Slower";
  return "Not enough memory";
}

/** "Qwen 3.5 9B" → "Qwen": the rail groups models by the first word of their name. */
const familyOf = (name: string): string => name.split(" ")[0] ?? name;

/** A model's monogram tile: the first letter of its family, or a spinner in the same tile while it loads. */
function Mark({ name, busy = false }: { name: string; busy?: boolean }) {
  return (
    <i className="mmark" aria-hidden="true">
      {busy ? <Icon id="spin" cls="spin" /> : familyOf(name).charAt(0).toUpperCase()}
    </i>
  );
}

function ctxTip(name: string, c: number, v: Verdict | undefined): string {
  const at = `<b>${esc(name)}</b> at ${k(c)}`;
  if (v === undefined) return `${at}: checking GPU memory…`;
  if (v.k === "gpu") return `${at} fits on the GPU: est. ${gb(v.need)} of ${gb(v.avail)} available.`;
  if (v.k === "spill") return `${at} spills ${gb(v.amt)} into system memory, so replies are slower.`;
  return `${at}: not enough memory. It needs an estimated ${gb(v.amt)} more.`;
}

function pickCtx(c: ContextSize): void {
  closeTip();
  setContext(c);
}

/** The picker's foot: the context size, with the highlighted model's fit at each size. */
function CtxPick({ model }: { model: string | undefined }) {
  const numCtx = useStore((s) => s.numCtx);
  const fits = useStore((s) => s.fits);
  const catalog = useStore(catalogOf);
  const max = useStore((s) => s.models?.find((m) => m.name === model)?.maxContext);
  const usable = CONTEXT_SIZES.filter((c) => max === undefined || c <= max);
  useEffect(() => {
    for (const c of usable) ensureFit(model, c);
  }, [model, fits, max]);
  const name = model === undefined ? "" : describeModel(model, catalog).name;
  const capped = max !== undefined && max < numCtx;
  // the one Tab lands on: the chosen size, or the largest this model takes when it cannot take that
  const tabStop = usable.includes(numCtx as ContextSize) ? numCtx : usable.at(-1);
  return (
    <div className="pk-foot">
      <div className="pk-ctx">
        <span className="pk-ft" id="pkCtxL">
          Context
        </span>
        <div
          className="mini-seg"
          role="radiogroup"
          aria-labelledby="pkCtxL"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const i = usable.indexOf(numCtx as ContextSize);
            const right = e.key === "ArrowRight";
            // nothing chosen among these yet: Right starts at the first, Left at the last
            const next = i < 0 ? (right ? usable[0] : usable.at(-1)) : usable[(i + (right ? 1 : -1) + usable.length) % usable.length];
            if (next === undefined) return;
            pickCtx(next);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`#picker [data-ctx="${next}"]`)?.focus());
          }}
        >
          {CONTEXT_SIZES.map((c) => {
            const r = model === undefined ? undefined : fits[fitKey(model, c)];
            const v = r === undefined || r === "error" ? undefined : verdictOf(r);
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === numCtx && !capped}
                tabIndex={c === tabStop ? 0 : -1}
                className={c === numCtx && !capped ? "on" : ""}
                data-ctx={c}
                disabled={max !== undefined && c > max}
                data-tip={model === undefined ? `${k(c)} of context` : max !== undefined && c > max ? `<b>${esc(name)}</b> takes up to ${k(max)} of context.` : ctxTip(name, c, v)}
                onClick={() => pickCtx(c)}
              >
                <span className={`vd ${v?.k ?? "off"}`} />
                {k(c)}
              </button>
            );
          })}
        </div>
      </div>
      <p className="pk-help">{capped ? `Runs at ${k(max)}, the most this model takes.` : "How much of the chat the model can read at once."}</p>
    </div>
  );
}

function rowTip(r: Row, sysBytes: number | undefined): string {
  let tip = tagTip(r.name, r.info, r.tag);
  if (r.frees) tip += "<br>Another chat's reply is using this memory. Sending here stops that reply and keeps what it wrote.";
  else if (r.v) {
    tip += "<br>";
    if (r.v.k === "no") tip += `Estimated need ${gb(r.v.need)}. Available to this model: ${gb(r.v.avail)} of GPU${sysBytes !== undefined ? ` plus ${gb(sysBytes)} of system memory` : ""}.`;
    else if (r.v.k === "spill") tip += `An estimated ${gb(r.v.amt)} runs from system memory, so replies are slower.`;
    else tip += `Estimated need ${gb(r.v.need)} of ${gb(r.v.avail)} available to this model.`;
  }
  if (r.info) tip += `<br>${gb(r.info.sizeBytes)} on disk`;
  return tip;
}

/** Trim the list to end 4 px under the last whole row (F55); returns whether it overflows. */
function sizeList(list: HTMLElement): void {
  list.style.maxHeight = "";
  const cap = Math.min(440, window.innerHeight - 180);
  if (list.scrollHeight <= cap + 1) return;
  let end = 0;
  for (const kid of Array.from(list.querySelectorAll(".pk-r, .pk-gt, .pk-dr"))) {
    if (!(kid instanceof HTMLElement)) continue;
    const b = kid.offsetTop + kid.offsetHeight;
    if (b + 4 > cap) break;
    if (!kid.classList.contains("pk-gt")) end = b;
  }
  list.style.maxHeight = `${end + 4}px`;
}

function thumb(list: HTMLElement, sb: HTMLElement, th: HTMLElement): void {
  const over = list.scrollHeight > list.clientHeight + 1;
  sb.classList.toggle("on", over);
  if (!over) return;
  const track = list.clientHeight - 8;
  const h = Math.max(24, (track * list.clientHeight) / list.scrollHeight);
  const top = ((track - h) * list.scrollTop) / (list.scrollHeight - list.clientHeight);
  th.style.height = `${h}px`;
  th.style.top = `${top}px`;
}

function choose(tag: string): void {
  closePop();
  closeTip();
  pickModel(tag);
  focusComposer();
}

export function Picker() {
  const pop = useStore((s) => (s.pop?.id === "picker" ? s.pop : null));
  const open = pop !== null;
  const phone = useMedia(PHONE);
  const [q, setQ] = useState("");
  const [fam, setFam] = useState<string | null>(null);
  const [hl, setHl] = useState(-1);
  const [kb, setKb] = useState(false);
  const numCtx = useStore((s) => s.numCtx);
  const selected = useStore((s) => s.model);
  const models = useStore((s) => s.models);
  const fits = useStore((s) => s.fits);
  const pulls = useStore((s) => s.pulls);
  const loads = useStore((s) => s.loads);
  const gpu = useStore((s) => s.gpu);
  const cpu = noGpu(gpu);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sb = useRef<HTMLDivElement>(null);
  const th = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // reset on each open; check every installed model's fit at this context
  useEffect(() => {
    if (!open) return;
    setQ("");
    setFam(null);
    setHl(-1);
    setKb(pop?.kb ?? false);
    // on a phone or touch screen the search waits for a tap unless Ctrl+M asked for it: focus would cover the sheet with the keyboard
    if ((isTouch() || isPhone()) && pop?.kb !== true) return;
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, pop?.kb]);
  const catalogRaw = useStore((st) => st.catalog);
  const catalog = catalogRaw === NA ? undefined : catalogRaw;
  useEffect(() => {
    if (!open) return;
    const installed = chatModels(getState().models ?? []);
    for (const m of installed) {
      ensureFit(m.name, numCtx);
      // Context picks can reuse checked reports instead of briefly regrouping
      // installed rows under Checking. The cache deduplicates these requests.
      for (const c of CONTEXT_SIZES) if (m.maxContext === undefined || c <= m.maxContext) ensureFit(m.name, c);
    }
    // download and downloading rows too: the fit check gives a model not installed yet the pre-download estimate
    for (const c of catalog ?? []) if (!c.installed && !installed.some((m) => m.name === c.name)) ensureFit(c.name, numCtx);
  }, [open, numCtx, fits, catalog]);
  const query = q.trim().toLowerCase();
  const stopFrees = useStore((s) => s.stopFrees);
  const all = pickerRows({ models, pulls, fits, numCtx, catalog: catalogRaw, stopFrees }, query);
  const inFam = (name: string) => fam === null || familyOf(name) === fam;
  const groups = Object.fromEntries(GROUPS.map((g) => [g, all[g].filter((r) => inFam(r.name))])) as Record<GroupKey, Row[]>;
  const sys = gpu === NA || gpu === undefined ? undefined : gpu.systemMemoryAvailableBytes;
  const selectable = GROUPS.flatMap((g) => groups[g].filter((r) => r.downloading === undefined && (r.v?.k !== "no" || r.frees)));
  // the rail: every family among installed and downloadable models, "All" first
  const listed = chatModels(models ?? []).map((m) => describeModel(m.name, catalog).name);
  const offered = (catalog ?? []).filter((c) => !c.installed && !(models ?? []).some((m) => m.name === c.name));
  const families = [...new Set([...listed, ...offered.map((c) => c.label)].map(familyOf))];
  const pulling = (tag: string) => {
    const p = pulls[tag];
    return p !== undefined && awaitingInstall(p);
  };
  const downloads = offered.filter(
    (c) => !pulling(c.name) && inFam(c.label) && (query === "" || c.name.toLowerCase().includes(query) || c.label.toLowerCase().includes(query) || c.purpose.toLowerCase().includes(query)),
  );
  const picked = pickedModel(models)?.name;
  const ctxModel = (hl >= 0 ? selectable[hl]?.tag : undefined) ?? selected;

  useLayoutEffect(() => {
    const anchor = document.getElementById("modelBtn");
    if (!open || !ref.current || !list.current || !anchor) return;
    place(ref.current, anchor, "start");
    sizeList(list.current);
    place(ref.current, anchor, "start");
    if (sb.current && th.current) thumb(list.current, sb.current, th.current);
  });

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectable.length === 0) return;
      setKb(true);
      const next = (hl + (e.key === "ArrowDown" ? 1 : -1) + selectable.length) % selectable.length;
      setHl(next);
      list.current?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = selectable[hl >= 0 ? hl : 0];
      if (r) choose(r.tag);
    } else if (/^[1-9]$/.test(e.key) && q === "" && kb) {
      e.preventDefault();
      const r = selectable[Number(e.key) - 1];
      if (r) choose(r.tag);
    }
  };

  const rec = <span className="pk-rec" data-tip={pickRuleText(numCtx, cpu)}>Recommended</span>;
  let idx = 0;
  // Installed models first, best fit first; the fit word ends each row and the tooltip says the numbers.
  const body = GROUPS.flatMap((g) =>
    groups[g].map((r) => {
      const ctx = ctxFor(numCtx, models, r.tag);
      const loaded = loads[r.tag]?.state === "ready" && loads[r.tag]?.numCtx === ctx;
      const size = r.info ? gb(r.info.sizeBytes) : "";
      if (r.downloading !== undefined) {
        return (
          <div key={r.tag} className="pk-r dis" role="option" aria-selected={false} aria-disabled="true" data-tip={`${tagTip(r.name, r.info, r.tag)}<br>${ctxTip(r.name, numCtx, r.v)}<br>You can pick it when the download finishes.`}>
            <span className="pk-c" />
            <Mark name={r.name} />
            <div className="pk-m">
              <div className="pk-n">
                <span className="pk-nm">{r.name}</span>
              </div>
            </div>
            <span className="pk-v">Downloading · {r.downloading}%</span>
          </div>
        );
      }
      const tip = `${rowTip(r, sys)}${loaded ? "<br>Loaded now" : ""}`;
      if (r.v?.k === "no" && !r.frees) {
        // a phone offers the largest smaller context that fits, right on the row
        const smaller = CONTEXT_SIZES.findLast((c) => {
          if (c >= numCtx || (r.info?.maxContext !== undefined && c > r.info.maxContext)) return false;
          const f = fits[fitKey(r.tag, c)];
          return f !== undefined && f !== "error" && verdictOf(f).k !== "no";
        });
        return (
          <div key={r.tag} className="pk-r dis" data-m={r.tag} data-tip={tip}>
            {/* the option alone is disabled: the two buttons beside it work */}
            <div className="pk-o" role="option" aria-selected={false} aria-disabled="true">
              <span className="pk-c" />
              <Mark name={r.name} />
              <div className="pk-m">
                <div className="pk-n">
                  <span className="pk-nm">{r.name}</span>
                  <small>{size}</small>
                </div>
                <small className="pk-est">{`Needs ${gb(r.v.amt)} more`}</small>
              </div>
              <span className="pk-v no">{fitWord(r.v)}</span>
            </div>
            <div className="pk-acts">
              <button type="button" className="qa" data-memdet={r.tag} onClick={() => openFit(r.tag)}>
                Memory details
              </button>
              {smaller !== undefined ? (
                <button type="button" className="qa pk-sm" onClick={() => pickCtx(smaller)}>
                  Use {k(smaller)}
                </button>
              ) : null}
            </div>
          </div>
        );
      }
      const i = idx++;
      const sel = r.tag === selected;
      return (
        <button
          key={r.tag}
          type="button"
          className={`pk-r${sel ? " sel" : ""}${i === hl ? " hl" : ""}`}
          role="option"
          id={`pk-opt-${i}`}
          // While the arrow keys move a highlight, it is the selection a screen reader announces.
          aria-selected={hl >= 0 ? i === hl : sel}
          data-m={r.tag}
          data-i={i}
          data-tip={tip}
          onClick={() => choose(r.tag)}
        >
          <span className="pk-c">{sel ? <Icon id="check" /> : null}</span>
          <span className="pk-k">{i + 1}</span>
          <Mark name={r.name} />
          <div className="pk-m">
            <div className="pk-n">
              <span className="pk-nm">{r.name}</span>
              <small>{size}</small>
              {r.tag === picked && !phone ? rec : null}
            </div>
            {/* a phone's first line has no room for the label beside the name */}
            {r.v !== undefined ? (
              <small className="pk-est">
                {`Est. ${gb(r.v.need)}`}
                {r.tag === picked && phone ? rec : null}
              </small>
            ) : null}
          </div>
          {r.frees ? <span className="pk-v spill">Stops another chat</span> : <span className={`pk-v ${r.v?.k ?? ""}`}>{fitWord(r.v)}</span>}
        </button>
      );
    }),
  );
  const dlRows = downloads.map((c) => {
    // the fit at the picker's context, not the catalog's at the saved default
    const v = verdictFor({ fits, numCtx, catalog: catalogRaw }, c.name);
    // Recommended is "runs on the GPU" at this context; with no GPU, the catalog's lightest pick while it still runs
    const recTip =
      v?.k === "gpu"
        ? `Runs on your GPU with room for ${k(numCtx)} of context.`
        : c.recommended && c.fit?.verdict === "spills" && v?.k === "spill"
          ? `The lightest choice: at ${k(numCtx)} it runs partly in system memory, so replies are slower.`
          : undefined;
    return (
      <div key={c.name} className="pk-dr" data-dl={c.name} data-tip={`${ctxTip(c.label, numCtx, v)}<br>Estimated before download.`}>
        <Mark name={c.label} />
        <div className="pk-m">
          <div className="pk-n">
            <span className="pk-nm">{c.label}</span>
            <small>{gb(c.downloadBytes)}</small>
            {recTip !== undefined ? <span className="pk-rec" data-tip={recTip}>Recommended</span> : null}
          </div>
        </div>
        <span className={`pk-v ${v?.k ?? ""}`}>{fitWord(v)}</span>
        <button type="button" className="qa" disabled={v?.k === "no"} aria-label={`Download ${c.label}`} onClick={() => void pull(c.name)}>
          Download
        </button>
      </div>
    );
  });

  return (
    <div className={`pop${open ? " open" : ""}${kb ? " kb" : ""}`} id="picker" role="dialog" aria-label="Choose a model" ref={ref}>
      <SheetHead title="Model" sub={`Sizes at ${k(numCtx)} context`} />
      <div className="pk-h">
        <div className="pk-hin">
          <Icon id="search" />
          <input
            ref={input}
            id="pkSearch"
            placeholder="Search models"
            aria-label="Search models"
            role="combobox"
            aria-expanded={open}
            aria-controls="pkList"
            aria-autocomplete="list"
            aria-activedescendant={hl >= 0 ? `pk-opt-${hl}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHl(-1);
            }}
            onKeyDown={onKey}
          />
        </div>
      </div>
      <div className="pk-body">
        <div className="pk-rail" role="group" aria-label="Model families">
          {[null, ...families].map((f) => (
            <button
              key={f ?? "all"}
              type="button"
              className={`pk-fam${fam === f ? " on" : ""}`}
              aria-pressed={fam === f}
              onClick={() => {
                setFam(f);
                setHl(-1);
              }}
            >
              <i className="mmark" aria-hidden="true">
                {f === null ? "All" : f.charAt(0).toUpperCase()}
              </i>
              <span>{f ?? "All"}</span>
            </button>
          ))}
        </div>
        <div className="pk-wrap">
          <div
            className="pk-list"
            ref={list}
            onScroll={() => {
              if (list.current && sb.current && th.current) thumb(list.current, sb.current, th.current);
            }}
          >
            <div id="pkList" role="listbox" aria-label="Models">
              {body.length > 0 ? body : <div className="pk-empty">No installed model matches.</div>}
            </div>
            {dlRows.length > 0 ? (
              <div className="pk-dl" role="group" aria-labelledby="pkDlT">
                <div className="pk-gt" id="pkDlT">
                  Download
                </div>
                {dlRows}
              </div>
            ) : null}
          </div>
          <div className="pk-sb" ref={sb} aria-hidden="true">
            <i ref={th} />
          </div>
        </div>
      </div>
      <CtxPick model={ctxModel} />
    </div>
  );
}

// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The composer (shell.md F01, F02, F15, F28-F31, F34, F37b, F43b): the text
// box, model and context chips, Thinking and Image pills, the context meter,
// Send or Stop, and the popovers it opens (model picker, + menu).
import { type FocusEvent, type RefObject, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelInfo } from "@gates-local/contracts";
import { useActionPress } from "./composer-press.ts";
import { CONNECTING, PLACEHOLDER, booting, rtOf, unread } from "./Banner.tsx";
import { openFit } from "./fit-actions.ts";
import { fitFor, stopsChat } from "./fit-table.ts";
import { ctxFor, describeModel, gb, k, modelFacts, verdictOf } from "./format.ts";
import { LoadBar, LoadTime } from "./LoadBar.tsx";
import { MakerMark } from "./MakerMark.tsx";
import { pickerLabels } from "./picker-models.ts";
import { imagePickerScreen, pickerScreen, threadScreen } from "./screen-loaders.ts";
import { chosenImage, imageMode, sizeLabel } from "./image-choice.ts";
import { ImageMark } from "./ImageMark.tsx";
import { Icon, SendArrow } from "./icons.tsx";
import { canThink, chatBlockedReason, chatModels } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import { AttachmentImages, RefusedFiles } from "./attachment-images.tsx";
import { DropMarker } from "./file-drop.tsx";
import { attachFiles, imageReason, paste } from "./paste.ts";
import { useRefused } from "./refused-files.ts";
import {
  cancelQueuedEdit,
  cancelStopAsk,
  confirmStopAsk,
  editQueued,
  firstPull,
  openSettings,
  queueReason,
  removeQueued,
  send,
  sendQueuedNow,
  stop,
} from "./session.ts";
import { NA, type Queued, type State, getState, runningTurn, setState, streamingHere, useStore } from "./store.ts";
import { editDraft, getDraft, useDraft } from "./drafts.ts";
import { SheetHead, Skel, closePop, closeTip, esc, isTouch, place, togglePop, useMedia } from "./ui.tsx";
import { Voice } from "./Voice.tsx";

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

/** Someone is about to open the picker: load its code. Its fit values are already in the last fit table. */
function pickerIntent(): void {
  if (imageMode(getState())) { void imagePickerScreen.load(); return; }
  void pickerScreen.load();
}

/** Focus is intent only with a focus ring, that is from the keyboard; a sheet closing on phone hands focus back by script. */
function pickerFocus(e: FocusEvent<HTMLElement>): void {
  if (e.currentTarget.matches(":focus-visible")) pickerIntent();
}

export function Composer() {
  const rt = useStore(rtOf);
  const boot = useStore(booting);
  const none = useStore(unread);
  const model = useStore((s) => s.model);
  const numCtx = useStore((s) => s.numCtx);
  const think = useStore((s) => s.think);
  const image = useStore((s) => s.image);
  const hasText = useDraft(d => d.text.trim() !== "");
  const images = useDraft(d => d.images);
  const refused = useRefused().length;
  const replacement = useDraft(d => d.version);
  const pasting = useStore((s) => s.pasting);
  const notice = useStore((s) => s.notice);
  const fit = useStore((s) => fitFor(s.fitTable, s.model, ctxFor(s.numCtx, s.models, s.model)));
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const imageGen = useStore(imageGenOf);
  const isStreaming = useStore(streamingHere);
  const editingId = useStore((s) => s.editingQueued);
  const editing = editingId !== null;
  const running = useStore((s) => runningTurn(s, s.threadId)?.gen ?? null);
  const drawingNow = useStore(runningKind) === "image";
  const touch = useMedia("(hover: none)");
  const freed = stopsChat(fit);
  const wait = useStore(queueReason);
  const first = useStore(firstPull);
  const firstProgress = useStore((s) => {
    const p = first === undefined ? undefined : s.pulls[first];
    return p ? pctOf(p.completedBytes, p.totalBytes) : 0;
  });
  const loadState = useStore((s) => (s.model === undefined ? undefined : s.loads[s.model]?.state));
  const loadSince = useStore((s) => (s.model === undefined ? undefined : s.loadSince[s.model]));
  const loadMs = useStore((s) => (s.model === undefined ? undefined : s.loadTimes[s.model]));
  const used = useStore(usedTokens);
  const pop = useStore((s) => s.pop?.id ?? null);
  const pickerPending = useStore(s => s.pop?.id === "picker" && !s.pop.ready);
  const view = useStore((s) => s.view);
  const voiceThread = useStore((s) => s.threadId);
  const drawing = useStore(imageMode);
  const pictured = useStore(chosenImage);
  // a default ComfyUI does not list is still sent (the server settles it) but never named
  const named = pictured?.listed === true ? pictured : undefined;
  const online = useStore((s) => s.conn.kind === "open");
  const ta = useRef<HTMLTextAreaElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // Preparing a reply is user intent, not an idle startup download. The
  // renderer can arrive while the person types, before the first Send.
  useEffect(() => {
    if (hasText || images.length) void threadScreen.load();
  }, [hasText, images.length]);
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
  const blocked = !ready;
  useEffect(() => {
    if (!blocked && !isTouch() && document.activeElement === document.body) ta.current?.focus({ preventScroll: true });
  }, [blocked]);
  const queueable = wait !== null;
  const shownTag = first ?? model;
  const info = models?.find((m) => m.name === shownTag);
  const name = shownTag === undefined ? "No model" : pickerLabels([...chatModels(models ?? []).map(m => m.name), shownTag], catalog).get(shownTag) ?? shownTag;
  const loading = loadState === "loading";
  const loadingNow = loading && first === undefined;
  // The fit table's row: the server builds none while a load runs, so a loading model keeps the verdict from before it.
  const v = fit === undefined ? undefined : verdictOf(fit);
  const text = hasText || images.length > 0;
  const imageNo = imageReason(models, model, images, tag => describeModel(tag, catalog).name);
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

  // before the first read nothing is known: the words of a ready app, never a problem not yet seen;
  // past the boot bound with still nothing read, one neutral word until the runtime answers
  const placeholder = first !== undefined && !blocked ? "Type now; it sends when the download finishes" : noModel && ready ? (why ?? "Download a model to start chatting") : boot ? PLACEHOLDER.ready : none ? CONNECTING : PLACEHOLDER[rt];

  // A message queued behind a reply is checked when it goes, and memory a reply holds may be freed by stopping it.
  const memNo = v?.k === "no" && !isStreaming && !freed && !editing;
  const enter = touch ? "" : " (Enter)";
  let sendTip = `Send${enter}`;
  if (editing) sendTip = text ? `Update the queued message${enter}` : "Type the message to queue";
  else if (isStreaming && !blocked) sendTip = `${text ? `Queue${enter}. It sends` : "Type now; it sends"} when ${drawingNow ? "the image" : "this reply"} finishes`;
  else if (queueable) sendTip = `${text ? `Send${enter}. It goes out when ` : "Type now; it sends when "}${wait === "download" ? "the download finishes" : "setup finishes"}`;
  // before the first read nothing is known, so nothing is claimed
  else if (boot || none) sendTip = text ? `Send${enter}` : "Type a message to send";
  else if (blocked) sendTip = "Chat starts when Ollama is ready";
  else if (noModel) sendTip = why ?? "Download a model to start chatting";
  else if (memNo) sendTip = `${esc(name)}: not enough memory at ${k(ctx)}. It needs an estimated ${gb(v.amt)} more. Pick a smaller model or context.<br>Click for GPU memory in Settings › Advanced.`;
  else if (!text) sendTip = "Type a message to send";
  else if (freed) sendTip = `Send${enter}. Another chat's reply is using this memory, so it stops first`;
  if (imageNo !== null) sendTip = esc(imageNo);
  if (refused) sendTip = `Remove the file${refused === 1 ? "" : "s"} marked not sent first. A message carries text and images only.`;
  if (pasting) sendTip = "Preparing pasted images. They will be ready in a moment.";
  // Image on: the words go to the image model, so the chat model's readiness, memory and sight do not count.
  const drawNo = !drawing ? null : images.length > 0 ? "Image makes a picture from words alone. Remove the attachments, or turn Image off." : !online ? "Gates Local isn't answering." : pictured === undefined ? "Reading the image models…" : null;
  if (drawing && !editing && !isStreaming && !refused && !pasting) sendTip = drawNo ?? (text ? `Make the image${enter}` : "Describe the image to make");
  const sendDisabled = drawing ? !text || drawNo !== null || refused > 0 || pasting > 0
    : (blocked && !queueable) || (!blocked && memNo) || noModel || !text || imageNo !== null || refused > 0 || pasting > 0;
  // Refused for memory: the button stays focusable and clickable, and the click opens the why.
  const memRefused = !drawing && !blocked && !queueable && !noModel && memNo && imageNo === null && !refused && !pasting;
  // T3 Code's composer: Enter never stops a reply; the words queue behind it.
  const sendLabel = editing ? "Update queued message" : isStreaming ? "Queue message" : "Send message";
  // Touch Enter inserts a newline, so a draft needs the queue arrow: on touch, Stop and the arrow hold
  // their own slots for the whole reply, so the first character moves nothing under the finger.
  const showStop = isStreaming && !editing && !touch;
  // Editing a queued message on desktop: Stop leaves the main button for Dictate's square, so the row holds still.
  const stopForVoice = isStreaming && editing && !touch;
  // The note that said why Dictate waited is untrue once Dictate is back. Cleared here, not in Voice: Voice remounts when an edit is cancelled.
  const wasStopForVoice = useRef(stopForVoice);
  useEffect(() => {
    if (wasStopForVoice.current && !stopForVoice && getState().notice === VOICE_HELD) setState({ notice: null });
    wasStopForVoice.current = stopForVoice;
  }, [stopForVoice]);

  const submit = () => {
    if (sendDisabled) return;
    void send(getDraft().text);
  };
  const stopThisReply = () => {
    const s = getState();
    if (runningTurn(s, s.threadId)?.gen === running) stop();
  };
  const action = showStop ? `stop:${running}` : editing ? `edit:${editingId}` : memRefused ? `memory:${model}:${numCtx}` : isStreaming ? `queue:${running}` : "send";
  useLayoutEffect(() => closeTip(), [action]);
  const primaryPress = useActionPress(!showStop && sendDisabled && !memRefused ? `off:${action}` : action, () => {
    if (showStop) stopThisReply();
    else if (memRefused) openFit();
    else submit();
  }, { ignoreRepeatedClicks: showStop });
  const compactStopPress = useActionPress(`stop:${running}`, () => {
    stopThisReply();
    primary.current?.focus();
  }, { ignoreRepeatedClicks: true });
  const stopSquare = <button type="button" className="ctl sq stop-sq" aria-label="Stop" data-tip={drawingNow ? "Cancel the image. Your draft stays here" : "Stop this reply. Your draft stays here"} {...compactStopPress}><span className="sqr" /></button>;

  return (
    <>
      <DropMarker />
      <StopWarning />
      {/* on the composer's top edge: nothing comes between them */}
      <QueueTray />
      <form
        className={`composer${blocked && !boot ? " blocked" : ""}`}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="att"><AttachmentImages images={images} removable /><RefusedFiles /></div>
        {/* "+ › Attach a file" opens this; like T3 Code's paperclip it takes any file, and each is sorted at its chip */}
        <input
          type="file"
          id="attachInput"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            void attachFiles(files);
          }}
        />
        <DraftTextarea key={voiceThread} textarea={ta} placeholder={placeholder} submit={submit} />
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
            {imageGen ? (
              <button
                type="button"
                className="pill gate"
                aria-pressed={image}
                aria-label="Image"
                data-tip={
                  image
                    ? "<b>Image on.</b> Send makes a picture from your words. Click to turn off."
                    : "<b>Image off.</b> Click to send your words to an image model."
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
            {/* Stop takes Dictate's square while a queued message is edited; Dictate stays mounted under it, so its shortcut still answers */}
            {stopForVoice ? stopSquare : null}
            <Suspense fallback={stopForVoice ? null : <span className="ctl sq voice" />}><Voice key={`${view}:${voiceThread}:${replacement}`} textarea={ta} held={stopForVoice ? VOICE_HELD : null} /></Suspense>
            <button
              type="button"
              className="ctl gate"
              id="modelBtn"
              aria-haspopup="dialog"
              aria-expanded={drawing ? pop === "images" : pop === "picker" && !pickerPending}
              aria-busy={!drawing && (boot || loading || pickerPending) || undefined}
              // the placeholder has no text, so the button needs a name of its own
              aria-label={!drawing && boot && shownTag === undefined ? "Model" : undefined}
              // Image on: the button says the short name beside the family mark, the tip the full one
              data-tip={drawing ? (named === undefined ? undefined : esc(named.preset.name)) : modelTip}
              // Load the picker's code on intent: hover, keyboard focus, or the press
              // before a click (touch has no hover). Its fit values are already in the
              // last fit table, so nothing is asked of the server here.
              onPointerEnter={pickerIntent}
              onFocus={pickerFocus}
              onPointerDown={pickerIntent}
              onClick={() => togglePop(drawing ? "images" : "picker")}
            >
              {/* Image on: the image model and size Send uses, in the same box */}
              {drawing ? <>
                {named === undefined ? null : <ImageMark family={named.preset.family} />}
                <span className="t">{named === undefined ? "Image model" : named.preset.short ?? named.preset.name}</span>
                {named === undefined ? null : <small className="picker-trigger-ctx">{sizeLabel(named.width, named.height)}</small>}
              </> : boot && shownTag === undefined ? <Skel w="8.5em" /> : <>
                {/* loading shows in the tile, the time slot and the bar, never in the label: the trigger keeps its width */}
                {shownTag === undefined ? null : <MakerMark tag={shownTag} busy={pickerPending || loadingNow} />}
                <span>{modelLbl}</span>
                <small className="picker-trigger-ctx">{loadingNow ? <LoadTime key={loadSince} since={loadSince} ms={loadMs} /> : k(ctx)}</small>
                {loadingNow ? <LoadBar key={loadSince} since={loadSince} ms={loadMs} /> : null}
              </>}
            </button>
            {/* a phone has no room for the pills and the meter: they live in this sheet */}
            <button type="button" className="ctl sq gate" id="optBtn" aria-haspopup="menu" aria-expanded={pop === "opts"} aria-label="Chat options" onClick={() => togglePop("opts")}>
              <Icon id="sliders" />
            </button>
            {/* a reply on touch: the main button is the queue arrow, and Stop holds its own slot one press away */}
            {isStreaming && !showStop && !stopForVoice ? stopSquare : null}
            <button
              ref={primary}
              type="button"
              className={showStop ? "send stop" : "send"}
              aria-label={showStop ? "Stop" : sendLabel}
              data-tip={showStop ? (drawingNow ? "Cancel the image. Enter queues your message after it" : "Stop. Enter queues your message after this reply") : sendTip}
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
        <p className={`na c-note${memNo ? " no" : ""}`} role="status" tabIndex={0} data-tip={esc(notice)}>
          {notice}
        </p>
      ) : null}
    </>
  );
}

/**
 * A browser that sizes the field to its text (styles.css `.ta`, `field-sizing`)
 * needs no measuring here. Measuring reads the height back, which lays out the
 * whole page inside the key's own task: a streaming reply's new text too, and
 * 40 freshly mounted turns when a long thread opens.
 */
const sizesItself = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

function DraftTextarea({ textarea, placeholder, submit }: { textarea: RefObject<HTMLTextAreaElement | null>; placeholder: string; submit: () => void }) {
  const draft = useDraft(d => d.text);
  const version = useDraft(d => d.version);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, [textarea]);
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el || sizesItself) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft, placeholder, textarea]);
  return <textarea ref={textarea} id="ta" data-draft-version={version} className="ta" rows={1} placeholder={placeholder} aria-label="Message" value={draft} onPaste={paste}
    onChange={e => editDraft(e.target.value)} onKeyDown={e => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch()) { e.preventDefault(); submit(); }
    }} />;
}

// ---------------------------------------------------------------- queue and warning

/** Why Ctrl+Shift+Space does not start dictation while Stop holds Dictate's square. */
const VOICE_HELD = "Dictate comes back when this reply ends or you finish editing the queued message.";

/** The tray's "Download stopped" word in full, as its tip: the row is too narrow for the sentence on a phone. */
export const DOWNLOAD_STOPPED_TIP = "Download stopped. Download a model to send this.";

/** A queued message's state in a word or two, only where being in the queue does not already say it: null while it waits for the reply. */
export function queueWords(q: Queued, editing: boolean, first: string | undefined, model: string | undefined): string | null {
  if (editing) return "Editing";
  if (q.waitFor === "download") return first === undefined && (q.model ?? model) === undefined ? "Download stopped" : "After download";
  if (q.waitFor === "setup") return "After setup";
  if (q.retry === "running") return RETRYING;
  if (q.retry === "failed") return RETRY_FAILED;
  return q.held ? "On hold" : null;
}

/** The owner's words for a queue behind a failed reply the app retries once (chat row 23); the tip carries them where the row cuts them. */
const RETRYING = "Retrying the reply before it";
const RETRY_FAILED = "On hold: the reply before it didn't finish";
const tipFor = (words: string | null) => words === "Download stopped" ? DOWNLOAD_STOPPED_TIP : words === RETRYING || words === RETRY_FAILED ? words : undefined;

/** What is running in the open chat, as a word, so a reader re-renders when that changes and not at every token. */
const runningKind = (s: State): "image" | "reply" | null => {
  const turn = runningTurn(s, s.threadId);
  return turn === undefined ? null : turn.image ? "image" : "reply";
};

const SEND_NOW = { image: "Send now. Cancels the image", reply: "Send now. Stops the reply" } as const;

/** A click handler that leaves the typing cursor in the composer, where the next words go. */
const andFocus = (act: () => void) => () => {
  closeTip();
  act();
  focusComposer();
};

/**
 * Messages waiting in this chat, on the composer's top edge as in T3 Code. One line each: what it
 * will make (a picture when it was queued with Image on), its words, then icons to send it now,
 * edit it in the composer, or remove it.
 */
function QueueTray() {
  const queued = useStore((s) => s.queued);
  const threadId = useStore((s) => s.threadId);
  const editingId = useStore((s) => s.editingQueued);
  const first = useStore(firstPull);
  const model = useStore((s) => s.model);
  const kind = useStore(runningKind);
  const mine = queued.filter((q) => q.threadId === threadId);
  if (mine.length === 0) return null;
  const n = mine.length;
  const nowTip = kind === null ? "Send now" : SEND_NOW[kind];
  return (
    <ul className="qt" aria-label={`${n} queued message${n === 1 ? "" : "s"}`}>
      {mine.map((q, i) => {
        const editing = q.id === editingId;
        const words = queueWords(q, editing, first, model);
        return (
          <li key={q.id} className="qt-r" aria-label={`Queued ${q.draw === undefined ? "message" : "image"} ${i + 1} of ${n}`}>
            <span className="qt-k" data-tip={q.draw === undefined ? "Chat" : "Image"}><Icon id={q.draw === undefined ? "chat" : "image"} cls="s14" /></span>
            <span className="qt-t">{q.text}{q.images?.length ? ` · ${q.images.length} image${q.images.length === 1 ? "" : "s"}` : ""}</span>
            {/* always there, empty while the message just waits, so a reader announces the word when it appears */}
            <span className="qt-s" role="status" data-tip={tipFor(words)}>{words ?? ""}</span>
            {q.waitFor === "reply" && !editing ? (
              <button type="button" className="ibtn xs" aria-label="Send now" data-send-now data-tip={nowTip} onClick={andFocus(() => sendQueuedNow(q.id))}>
                <SendArrow />
              </button>
            ) : null}
            {editing ? (
              <button type="button" className="ibtn xs" aria-label="Cancel editing" aria-pressed="true" data-tip="Cancel editing" onClick={andFocus(cancelQueuedEdit)}>
                <Icon id="pencil" cls="s14" />
              </button>
            ) : (
              <button type="button" className="ibtn xs" aria-label="Edit" data-edit-queued data-tip="Edit" onClick={andFocus(() => editQueued(q.id))}>
                <Icon id="pencil" cls="s14" />
              </button>
            )}
            <button type="button" className="ibtn xs" aria-label="Remove" data-unqueue data-tip="Remove" onClick={andFocus(() => removeQueued(q.id))}>
              <Icon id="x" cls="s14" />
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
  const matches = useDraft(d => ask === null || ask.keepDraft || d.text.trim() === ask.content && d.images === ask.images);
  const catalog = useStore(catalogOf);
  const [never, setNever] = useState(false);
  useEffect(() => setNever(false), [ask]);
  if (ask === null || !matches) return null;
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
      <button
        type="button"
        className="mi"
        role="menuitem"
        data-attach
        data-tip="Images go with this message. Other files show as not sent. You can also drop files on the window."
        onClick={() => {
          closePop();
          document.getElementById("attachInput")?.click();
        }}
      >
        <Icon id="clip" />
        <span>
          <b>Attach a file</b>
          <small>Images, for this message</small>
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
            <small>Send makes a picture from your words</small>
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
            <small>{image ? "Send makes a picture from your words" : "Off: Send goes to the chat model"}</small>
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

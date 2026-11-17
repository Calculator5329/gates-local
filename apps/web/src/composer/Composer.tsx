// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The composer (shell.md F01, F02, F15, F28-F31, F34, F37b, F43b): the text
// box, model and context chips, Thinking and Image pills, the context meter,
// Send or Stop, and the popovers it opens (model picker, + menu).
import { type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AttachedFile, IMAGE_COUNT_MAX, type ModelInfo } from "@gates-local/contracts";
import { useActionPress } from "./composer-press.ts";
import { firstModelOffer } from "../runtime/first-offer.ts";
import { CONNECTING, PLACEHOLDER, booting, rtOf, unread } from "../runtime/words.tsx";
import { openFit } from "../fit/fit-actions.ts";
import { cardFit, fitFor, stopsChat } from "../fit/fit-table.ts";
import { ctxFor, describeModel, k, noGpu, slowReason, timeLeft, verdictOf } from "../lib/words/format.ts";
import { DownloadBar, LoadRing } from "./LoadBar.tsx";
import { loadGuess } from "../lib/store/load-times.ts";
import { MakerMark } from "../models/MakerMark.tsx";
import { RefusalNote, Slower } from "./RefusalNote.tsx";
import { compactName, pickerLabels } from "../picker/picker-models.ts";
import { imagePickerScreen, pickerScreen, threadScreen } from "../app/screen-loaders.ts";
import { chosenImage, imageCount, imageMode, imagesUnset, runKey, sizeLabel } from "../image/image-choice.ts";
import { ImageMark } from "../image/ImageMark.tsx";
import { Icon, SendArrow } from "../lib/ui/icons.tsx";
import { canThink, chatBlockedReason, chatModels, sendableModel } from "../models/pick.ts";
import { focusComposer } from "./focus.ts";
import { AttachedFiles, AttachmentImages, RefusedFiles } from "./attachment-images.tsx";
import { DropMarker } from "./file-drop.tsx";
import { useChange, usePopover } from "../lib/ui/kit/popover.ts";
import { useDocumentEvent } from "../lib/ui/kit/events.ts";
import { withTimeout } from "../lib/ui/kit/async.ts";
import { requestFocus } from "../lib/ui/kit/focus.ts";
import { watch } from "../lib/ui/kit/watch.ts";
import { useScreen } from "../app/screens.tsx";
import { attachFiles, imageReason, paste } from "./paste.ts";
import { useRefused } from "./refused-files.ts";
import {
  cancelQueuedEdit,
  cancelStopAsk,
  chooseForQueued,
  confirmStopAsk,
  editQueued,
  editedElsewhere,
  firstPull,
  readImageRun,
  openSettings,
  pickImageCount,
  sendsBeforeReady,
  noticeDo,
  removeQueued,
  send,
  sendQueuedNow,
  stop,
  typedInComposer,
} from "../lib/session/index.ts";
import { NA, type NoticeActKind, type State, type WaitingReply, behindSetup, getState, runningTurn, setState, streamingHere, useStore, waitingReplies } from "../lib/store/store.ts";
import { drawsPicture } from "../thread/turn.ts";
import { editDraft, getDraft, useDraft } from "../lib/store/drafts.ts";
import { PHONE, SheetHead, Skel, closePop, closeTip, esc, isTouch, openTip, place, togglePop, useMedia } from "../lib/ui/ui.tsx";

// external: a remote desktop's browser can report (hover: none) with a keyboard present
const PHONE_TOUCH = `(pointer: coarse) and ${PHONE}`;
import { Speaker, Voice } from "../voice/Voice.tsx";
import { hush, useTalk } from "../voice/talk.ts";

const catalogOf = (s: Pick<State, "catalog">) => (s.catalog === NA ? undefined : s.catalog);
const imageGenOf = (s: State) => s.settings !== NA && s.settings?.imageGen === true;
const pctOf = (done: number, total: number | undefined) => (total ? Math.round((done / total) * 100) : 0);

const NO_FILES: readonly AttachedFile[] = [];
export const IMAGE_PLACEHOLDER = "Describe a picture…";

function usedTokens(s: State): number {
  if (s.view !== "thread" || s.threadId === null) return 0;
  const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "assistant" && m.stats !== undefined);
  return (last?.stats?.promptTokens ?? 0) + (last?.stats?.completionTokens ?? 0);
}

export function thinkUnavailable(model: ModelInfo | undefined, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Thinking: after the download";
  return canThink(model) ? null : "Thinking: not on this model";
}

function thinkNote(model: ModelInfo | undefined, name: string, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Available when the model finishes downloading";
  return canThink(model) ? null : `${name} does not reason before answering`;
}

// why: one identity at module level, so the observer comes and goes with the drawn name
const fitName = (el: HTMLSpanElement | null): (() => void) | undefined => {
  const full = el?.querySelector<HTMLElement>(".ptn-f");
  if (!el || !full || typeof ResizeObserver === "undefined") return;
  const fit = () => { el.dataset["fit"] = full.offsetWidth > el.clientWidth ? "short" : "full"; };
  const seen = new ResizeObserver(fit);
  seen.observe(el);
  seen.observe(full);
  fit();
  return () => seen.disconnect();
};

function pickerIntent(): void {
  if (imageMode(getState())) { void imagePickerScreen.load(); return; }
  void pickerScreen.load();
}

// external: a browser's script focus() after a tap does not match :focus-visible
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
  const files = useDraft(d => d.files ?? NO_FILES);
  const refused = useRefused().length;
  const replacement = useDraft(d => d.version);
  const pasting = useStore((s) => s.pasting);
  const askingNow = useStore((s) => s.asking === true);
  const notice = useStore((s) => s.notice);
  const noticeOffer = useStore((s) => s.noticeOffer);
  const acts = useStore((s) => (s.noticeAct !== null && s.noticeAct.notice === s.notice ? s.noticeAct.acts : undefined));
  const fit =useStore((s) => fitFor(s.fitTable, s.model, ctxFor(s.numCtx, s.models, s.model)));
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const imageGen = useStore(imageGenOf);
  const isStreaming = useStore(streamingHere);
  const editingId = useStore((s) => s.editingQueued);
  const editing = editingId !== null;
  const running = useStore((s) => runningTurn(s, s.threadId)?.turnId ?? null);
  const drawingNow = useStore(runningKind) === "image";
  const touch = useMedia(PHONE_TOUCH);
  const freed = stopsChat(fit);
  const early = useStore(sendsBeforeReady);
  const first = useStore(firstPull);
  const firstProgress = useStore((s) => {
    const p = first === undefined ? undefined : s.pulls[first];
    return p ? pctOf(p.completedBytes, p.totalBytes) : 0;
  });
  const loadState = useStore((s) => (s.model === undefined ? undefined : s.loads[s.model]?.state));
  const loadSince = useStore((s) => (s.model === undefined ? undefined : s.loadSince[s.model]));
  const loadMs = useStore((s) => (s.model === undefined ? undefined : s.loadTimes[s.model]));
  const cpu = useStore((s) => noGpu(s.gpu));
  const used = useStore(usedTokens);
  const pop = useStore((s) => s.pop?.id ?? null);
  const pickerPending = useStore(s => s.pop?.id === "picker" && !s.pop.ready);
  const view = useStore((s) => s.view);
  const voiceThread = useStore((s) => s.threadId);
  const drawing = useStore(imageMode);
  const pictured = useStore(chosenImage);
  const unset = useStore(imagesUnset);
  const named = pictured?.listed === true ? pictured : undefined;
  const online = useStore((s) => s.conn.kind === "open");
  const ta = useRef<HTMLTextAreaElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // why: anything in the draft (typed, pasted, dropped, dictated or restored) means a send is near
  useScreen(threadScreen, hasText || images.length > 0 || files.length > 0);
  const primaryRef = useMemo(() => keepSendFocus(primary), []);

  const ready = rt === "ready";
  const blocked = !ready;
  const queueable = early;
  const shownTag = first ?? model;
  const name = shownTag === undefined ? "No model" : pickerLabels([...chatModels(models ?? []).map(m => m.name), shownTag], catalog).get(shownTag) ?? shownTag;
  const loading = loadState === "loading";
  const loadingNow = loading && first === undefined;
  const waitsOnLoad = loadingNow && isStreaming && !drawingNow;
  const v = fit === undefined ? undefined : verdictOf(fit);
  const slowWhy = v?.k !== "spill" ? undefined : slowReason(cardFit(fit)?.slowNow)?.short ?? (v.mark || undefined);
  const text = hasText || images.length > 0 || files.length > 0;
  const imageNo = imageReason(models, model, images, tag => describeModel(tag, catalog).name);
  const offered = useStore((s) => firstModelOffer(s) !== undefined);
  // external: older Ollama builds omit a model's capabilities field
  const why = chatBlockedReason(models, model);
  const noModel = (model === undefined || why !== undefined) && !queueable;
  const thinkNa = blocked ? null : thinkUnavailable(models?.find((m) => m.name === model), first !== undefined);

  // why: the name shows on the button, so the tip adds it only when the button cuts it (ui.tsx)
  const modelTip =
    shownTag === undefined
      ? "Model"
      : rt === "installing"
        ? "Downloads next"
        : first !== undefined
          ? `Downloading ${firstProgress}%`
          : loading
            ? `Loading into ${cpu ? "memory" : "GPU memory"}${loadMs === undefined ? "" : `, ${loadGuess(loadMs)}`}`
            : slowWhy === undefined ? undefined : esc(slowWhy);
  const short = compactName(name);

  const ctx = ctxFor(numCtx, models, model);
  const pct = Math.min(1, used / ctx);
  const meterHidden = pct < 0.5 || blocked || view !== "thread";

  const needsModel = why ?? "Download a model to start chatting";
  const placeholder = drawing && !boot && !none && rt !== "offline" ? IMAGE_PLACEHOLDER
    : noModel && ready ? (offered ? PLACEHOLDER.ready : needsModel) : boot ? PLACEHOLDER.ready : none ? CONNECTING : PLACEHOLDER[rt];

  const memNo = v?.k === "no" && !isStreaming && !freed && !editing;
  const enter = touch ? "" : " · Enter";
  let sendTip = `Send${enter}`;
  let freesFirst = false;
  if (editing) sendTip = `Update${enter}`;
  else if (isStreaming && !blocked) sendTip = `Queue${enter}`;
  else if (!queueable && !boot && !none && !blocked && !noModel) {
    if (memNo) sendTip = `Not enough memory at ${k(ctx)}`;
    else freesFirst = text && freed;
  }
  if (!drawing && text && ((blocked && !queueable) || noModel)) sendTip = boot ? CONNECTING : noModel && ready ? needsModel : placeholder;
  const unlisted = !drawing && ready && !queueable && !noModel && model !== undefined && sendableModel(models, model) === undefined;
  if (unlisted) sendTip = models === undefined ? "Reading the models…" : models.some((m) => m.name === model) ? `${name} can't chat` : `${name} isn't installed`;
  if (imageNo !== null) sendTip = "This model can't see images";
  if (refused) sendTip = `Remove the file${refused === 1 ? "" : "s"} marked not sent`;
  if (pasting) sendTip = "Attaching…";
  const drawNo = !drawing ? null : images.length > 0 || files.length > 0 ? "Image takes words only" : !online ? "Gates Local isn't answering" : unset ? "Images are not set up" : pictured === undefined ? "Reading the image models…" : null;
  if (drawing && !editing && !isStreaming && !refused && !pasting) sendTip = drawNo ?? `Make image${enter}`;
  // why: the tip names the button; what Send will do first is said on the notice line
  const sendNote = freesFirst && sendTip === `Send${enter}` ? FREES_FIRST : null;
  const shownNote = notice ?? sendNote;
  const sendDisabled = drawing ? !text || drawNo !== null || refused > 0 || pasting > 0
    : (blocked && !queueable) || (!blocked && memNo) || noModel || unlisted || !text || imageNo !== null || refused > 0 || pasting > 0;
  const memRefused = !drawing && !blocked && !queueable && !noModel && !unlisted && memNo && imageNo === null && !refused && !pasting;
  const sendLabel = editing ? "Update queued message" : isStreaming ? "Queue message" : "Send message";
  const showStop = isStreaming && !editing && !touch;
  const stopForVoice = isStreaming && editing && !touch;

  const submit = () => {
    if (sendDisabled) return;
    void send(getDraft().text);
  };
  const enterSend = () => {
    const answer = enterAnswer({ sendDisabled, memRefused, text, showStop });
    if (answer === "send") submit();
    else if (answer === "fit") openFit();
    else if (answer === "tip") openTip(primary.current);
    else if (answer === "note") setState({ notice: sendTip });
  };
  const latestSubmit = useRef(submit);
  // oxlint-disable-next-line gates/effect-needs-reason -- the committed draft's Send, kept in step for Dictate, which sends after the draft is drawn; a write during render could hold a render React drops
  useLayoutEffect(() => { latestSubmit.current = submit; });
  const talkSend = useCallback(() => latestSubmit.current(), []);
  const talk = useTalk().on;
  const stopThisReply = () => {
    const s = getState();
    if (runningTurn(s, s.threadId)?.turnId !== running) return;
    // why: the voice goes quiet at the press, not when the server's end of the reply arrives
    hush();
    stop();
  };
  const action = showStop ? `stop:${running}` : editing ? `edit:${editingId}` : memRefused ? `memory:${model}:${numCtx}` : isStreaming ? `queue:${running}` : "send";
  const primaryPress = useActionPress(!showStop && sendDisabled && !memRefused ? `off:${action}` : action, () => {
    if (showStop) stopThisReply();
    else if (memRefused) openFit();
    else submit();
  }, { ignoreRepeatedClicks: showStop });
  const compactStopPress = useActionPress(`stop:${running}`, () => {
    stopThisReply();
    primary.current?.focus();
  }, { ignoreRepeatedClicks: true });
  const stopTip = drawingNow ? "Cancel image" : "Stop";
  const stopSquare = <button type="button" className="ctl sq stop-sq" data-testid="chat.composer.stop-square" aria-label="Stop" data-tip={stopTip} {...compactStopPress}><span className="sqr" /></button>;

  return (
    <>
      <DropMarker />
      <StopWarning />
      <form
        className={`composer${blocked && !boot ? " blocked" : ""}`}
        data-testid="chat.composer.form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <QueueTray />
        <div className="att"><AttachmentImages images={images} removable /><AttachedFiles files={files} removable /><RefusedFiles /></div>
        <input
          type="file"
          id="attachInput"
          data-testid="chat.composer.attach-input"
          multiple
          hidden
          onChange={(e) => {
            const chosen = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            void attachFiles(chosen);
          }}
        />
        <DraftTextarea key={voiceThread} textarea={ta} placeholder={placeholder} submit={enterSend} />
        <div className="cf">
          <div className="cf-l">
            <button
              type="button"
              className="ctl sq gate"
              id="plusBtn"
              data-testid="chat.composer.add"
              aria-haspopup="menu"
              aria-expanded={pop === "plus"}
              aria-label="Add"
              data-tip="Add"
              onClick={() => togglePop("plus")}
            >
              <Icon id="plus" />
            </button>
            {imageGen ? (
              <button
                type="button"
                className="pill gate"
                id="imageBtn"
                data-testid="chat.composer.image"
                aria-pressed={image}
                aria-label="Image"
                aria-expanded={!image && unset ? pop === "unset" : undefined}
                data-tip={!image && unset ? undefined : "Image"}
                onClick={(e) => {
                  if (!image && unset) { togglePop("unset", e.detail === 0); return; }
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
                data-testid="chat.composer.context-meter"
                aria-label="Context used"
              >
                <span>Context {Math.round(pct * 100)}% used</span>
              </button>
            )}
            {drawing ? <CountButton open={pop === "count"} /> : <button
              type="button"
              className={`pill gate thinking${thinkNa !== null ? " unavail" : ""}`}
              data-testid="chat.composer.thinking"
              aria-pressed={thinkNa !== null ? false : think}
              aria-label="Thinking"
              aria-disabled={thinkNa !== null ? true : undefined}
              data-tip={thinkNa ?? "Thinking"}
              onClick={() => {
                if (thinkNa !== null) return;
                setState({ think: !think });
                closeTip();
              }}
            >
              <Icon id="bulb" cls="lead" />
              <span className="plbl">Thinking</span>
            </button>}
          </div>
          <div className="cf-r">
            {stopForVoice ? stopSquare : null}
            <Suspense fallback={stopForVoice ? null : <span className="ctl sq voice" />}><Voice key={`${view}:${voiceThread}:${replacement}`} textarea={ta} held={stopForVoice ? VOICE_HELD : null} send={talkSend} /></Suspense>
            {talk ? <Speaker /> : null}
            <button
              type="button"
              className="ctl gate"
              id="modelBtn"
              data-testid="chat.composer.model"
              aria-haspopup="dialog"
              aria-expanded={drawing ? pop === "images" : pop === "picker" && !pickerPending}
              aria-busy={!drawing && (boot || loading || pickerPending) || undefined}
              aria-label={!drawing && boot && shownTag === undefined ? "Model" : undefined}
              data-tip={drawing ? (named === undefined ? undefined : esc(named.preset.name)) : modelTip}
              data-tipt={drawing || shownTag === undefined ? undefined : name}
              onPointerEnter={pickerIntent}
              onFocus={pickerFocus}
              onPointerDown={pickerIntent}
              onKeyDown={e => {
                if (e.key !== "ArrowDown") return;
                e.preventDefault();
                pickerIntent();
                if (pop !== (drawing ? "images" : "picker")) togglePop(drawing ? "images" : "picker", true);
              }}
              onClick={() => togglePop(drawing ? "images" : "picker")}
            >
              {drawing ? <>
                {named === undefined ? null : <ImageMark family={named.preset.family} />}
                <span className="t">{named === undefined ? "Image model" : named.preset.short ?? named.preset.name}</span>
                {named === undefined ? null : <small className="picker-trigger-ctx">{sizeLabel(named.width, named.height)}</small>}
              </> : boot && shownTag === undefined ? <Skel w="8.5em" /> : <>
                {shownTag === undefined ? null : <MakerMark tag={shownTag} busy={pickerPending} />}
                <span key={name} className="picker-trigger-name" ref={short === undefined ? undefined : fitName}><span className="ptn-f">{name}</span>{short === undefined ? null : <span className="ptn-s" aria-hidden="true">{short}</span>}</span>
                <small className="picker-trigger-ctx">{k(ctx)}</small>
                {first === undefined ? null : <DownloadBar pct={firstProgress} />}
              </>}
            </button>
            <button type="button" className="ctl sq gate" id="optBtn" data-testid="chat.composer.options" aria-haspopup="menu" aria-expanded={pop === "opts"} aria-label="Chat options" onClick={() => togglePop("opts")}>
              <Icon id="sliders" />
            </button>
            {isStreaming && !showStop && !stopForVoice ? stopSquare : null}
            <button
              ref={primaryRef}
              type="button"
              className={showStop ? "send stop" : "send"}
              data-testid="chat.composer.send"
              data-tipkey={action}
              aria-label={showStop ? "Stop" : sendLabel}
              data-tip={showStop ? stopTip : sendTip}
              aria-disabled={!showStop && sendDisabled ? true : undefined}
              aria-busy={askingNow && !showStop ? true : undefined}
              {...primaryPress}
            >
              {showStop ? <span className="sqr" /> : <SendArrow />}
              {waitsOnLoad ? <LoadRing key={loadSince} since={loadSince} ms={loadMs} /> : askingNow && !showStop ? <LoadRing since={undefined} ms={undefined} ask /> : null}
            </button>
          </div>
        </div>
      </form>
      {notice !== null && noticeOffer?.notice === notice ? <RefusalNote o={noticeOffer} /> : shownNote !== null ? (
        <p className={`na c-note${memNo ? " no" : ""}${acts === undefined ? "" : " c-acted"}`} data-testid="chat.composer.notice" role="status">
          {acts === undefined ? shownNote : <span>{shownNote}</span>}
          {acts?.map((a) => (
            <button key={a} type="button" className="co-act" data-testid={`chat.composer.notice-${a}`} onClick={() => noticeDo(a)}>{ACT_WORDS[a]}</button>
          ))}
        </p>
      ) : null}
    </>
  );
}

const FREES_FIRST = "Another chat's reply stops first";

const ACT_WORDS: Record<NoticeActKind, string> ={ "stop-other": "Stop the other reply", wait: "Wait", retry: "Retry" };

// external: a browser sizes field-sizing:content itself; reading scrollHeight forces layout
const sizesItself = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

function DraftTextarea({ textarea, placeholder, submit }: { textarea: RefObject<HTMLTextAreaElement | null>; placeholder: string; submit: () => void }) {
  const newlineOnEnter = useMedia(PHONE_TOUCH);
  const draft = useDraft(d => d.text);
  const version = useDraft(d => d.version);
  const attach = useCallback((el: HTMLTextAreaElement | null) => {
    textarea.current = el;
    el?.setSelectionRange(el.value.length, el.value.length);
    if (el !== null) focusIdleBox();
  }, [textarea]);
  // oxlint-disable-next-line gates/effect-needs-reason -- the box's height measured from its text, where the browser cannot size it itself
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el || sizesItself) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft, placeholder, textarea]);
  return <textarea ref={attach} id="ta" data-testid="chat.composer.message" data-draft-version={version} className="ta" rows={1} placeholder={placeholder} aria-label="Message" value={draft} onPaste={paste}
    onChange={e => {
      editDraft(e.target.value);
      if (e.target.value !== "") typedInComposer();
    }} onKeyDown={e => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !newlineOnEnter) { e.preventDefault(); submit(); }
    }} />;
}

const VOICE_HELD = "Dictate comes back when this reply ends or you finish editing the queued message.";

const SEND = '[data-testid="chat.composer.send"]';

// why: a first send swaps this composer for the thread's; Send's focus goes to the one drawn next
function keepSendFocus(primary: RefObject<HTMLButtonElement | null>) {
  return (el: HTMLButtonElement | null): (() => void) | undefined => {
    primary.current = el;
    if (el === null) return;
    return () => {
      if (document.activeElement === el) requestFocus(SEND);
    };
  };
}

const idleBox = (): HTMLElement | null =>
  rtOf(getState()) === "ready" && !isTouch() && document.activeElement === document.body ? document.getElementById("ta") : null;

// why: the message box takes the focus nobody holds, on first draw and once the runtime is ready
function focusIdleBox(): void {
  requestFocus(idleBox, { preventScroll: true });
}

// why: Dictate is held while a reply streams here and a queued edit is open; touch has no Stop
const stopForVoiceNow = (s: State): boolean => streamingHere(s) && s.editingQueued !== null && !matchMedia(PHONE_TOUCH).matches;

function dictateBack(now: boolean): void {
  if (!now && getState().notice === VOICE_HELD) setState({ notice: null });
}

function closeCountOff(drawing: boolean): void {
  if (!drawing && getState().pop?.id === "count") closePop();
}

// why: started once by the entry, so a change from any path in lib/session is heard
export function watchComposer(): () => void {
  const stops = [
    watch((s) => rtOf(s) === "ready", (ready) => { if (ready) focusIdleBox(); }),
    watch(stopForVoiceNow, dictateBack),
    watch(imageMode, closeCountOff),
  ];
  return () => {
    for (const off of stops) off();
  };
}

export function enterAnswer(s: { readonly sendDisabled: boolean; readonly memRefused: boolean; readonly text: boolean; readonly showStop: boolean }): "send" | "fit" | "tip" | "note" | null {
  if (!s.sendDisabled) return "send";
  if (!s.text) return null;
  if (s.memRefused) return "fit";
  return s.showStop ? "note" : "tip";
}

export function queueWords(q: WaitingReply, editing: boolean, first: string | undefined, model: string | undefined, installing: boolean, elsewhere = false): string | null {
  if (editing) return null;
  if (editedElsewhere(q)) return EDITED_ELSEWHERE;
  // why: an edit that just ended here: the message is as it was before it
  const at = q.stage === "editing" ? q.back : q;
  const wait = q.stage === "queued" ? q.waitFor : undefined;
  if (wait?.what === "download") return first === undefined && (q.model ?? model) === undefined ? "Download stopped" : AFTER_DOWNLOAD;
  if (wait?.what === "setup") return installing ? AFTER_SETUP : first !== undefined ? AFTER_DOWNLOAD : null;
  if (wait?.what === "retry") return RETRYING;
  if (at.stage === "held") return at.held.why === "failed" ? RETRY_FAILED : at.held.why === "refused" ? HELD_FOR[at.held.code] ?? "On hold" : "On hold";
  // why: Send now waits only for its own chat: the server's record says it goes next
  return elsewhere && at.stage === "queued" ? AFTER_OTHER_REPLY : null;
}

export const replyElsewhere = (s: State): boolean => {
  const here = s.threadId === null ? undefined : s.turns[s.threadId];
  return (here === undefined || here.end !== undefined) && Object.entries(s.turns).some(([id, t]) => id !== s.threadId && t.end === undefined && !drawsPicture(t));
};

export const EDITED_ELSEWHERE = "Being edited in another window";
const AFTER_OTHER_REPLY = "Sends when another chat's reply ends";
const RETRYING = "Retrying the reply before it";
const RETRY_FAILED = "On hold: the reply before it didn't finish";
const HELD_FOR: Partial<Record<string, string>> = { "wont-fit": "On hold: not enough memory", "would-stop": "On hold: another chat's reply is using the memory" };
export const AFTER_DOWNLOAD = "Sends when the download finishes";
export const AFTER_SETUP = "Sends when setup finishes";
const CLOCKED = new Set<string | null>([AFTER_DOWNLOAD, AFTER_SETUP]);

export function waitNumbers(p: { done: number; total?: number | undefined; rate?: number | undefined; checking?: boolean } | undefined, last: string): string {
  if (p === undefined || !p.total) return "";
  if (p.checking === true || p.done >= p.total) return last;
  const left = p.rate ? `${timeLeft((p.total - p.done) / p.rate)} left` : "";
  return `${Math.floor((p.done / p.total) * 100)}%|${left}`;
}

const downloadNumbers = (s: State): string => {
  const p = s.pulls[firstPull(s) ?? ""];
  return waitNumbers(p === undefined ? undefined : { done: p.completedBytes, total: p.totalBytes, rate: p.bytesPerSecond, checking: p.state === "verifying" || p.state === "done" }, "Checking");
};

const setupNumbers = (s: State): string => {
  const i = s.runtime?.state === "installing" ? s.runtime.install : undefined;
  return waitNumbers(i === undefined ? undefined : { done: i.receivedBytes, total: i.totalBytes, rate: i.bytesPerSecond }, "Unpacking");
};

const waitingOn = (s: State, words: string | null, at: string): string =>
  words === AFTER_SETUP
    ? at === "Unpacking" ? "Unpacking Ollama" : s.runtime?.state === "starting" ? "Starting Ollama" : "Downloading Ollama"
    : `${at === "Checking" ? "Checking" : "Downloading"} ${describeModel(firstPull(s) ?? "", catalogOf(s)).name || "the model"}`;

// why: a phone's row says ⤓ "Qwen 9B", the model button's short form, never "Downloading Q…"
const shortWait = (what: string): { readonly words: string; readonly icon: "download" | "clock" } | undefined => {
  const [verb = "", ...name] = what.split(" ");
  const short = compactName(name.join(" "));
  if (short === undefined) return undefined;
  return verb === "Downloading" ? { words: short, icon: "download" } : { words: `${verb} ${short}`, icon: "clock" };
};

function WaitNumbers({ value }: { value: string }) {
  const [pct, left] = value.split("|");
  return (
    <span className="qt-n" aria-hidden="true">
      {left === undefined ? pct : <><span className="qt-p">{pct}</span>{left === "" ? null : ` · ${left}`}</>}
    </span>
  );
}

// why: a coarse kind keeps token streaming from re-rendering the composer
const runningKind = (s: State): "image" | "reply" | null => {
  const turn = runningTurn(s, s.threadId);
  return turn === undefined ? null : drawsPicture(turn) ? "image" : "reply";
};

const SEND_NOW = { image: "Send now. Cancels the image", reply: "Send now. Stops the reply" } as const;

const andFocus = (act: () => void) => () => {
  closeTip();
  act();
  focusComposer();
};

function QueueOffer({ q, n }: { q: WaitingReply; n: number }) {
  const fallback = useStore((s) => s.model);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  if (q.stage !== "held" || q.held.why !== "refused" || q.held.code !== "wont-fit" || q.held.offer === undefined) return null;
  const { context, model } = q.held.offer;
  const tag = q.model ?? fallback ?? "";
  return (
    <>
      {context === undefined ? null : (
        <button type="button" className="co-act" data-testid={`chat.queue.offer-context-${n}`} aria-pressed={q.numCtx === context.numCtx && q.model === tag}
          data-tip="Context" onClick={andFocus(() => void chooseForQueued(q.id, tag, context.numCtx))}>
          <span>{k(context.numCtx)}</span>
          <Slower words={context.words} />
        </button>
      )}
      {model === undefined ? null : (
        <button type="button" className="co-act" data-testid={`chat.queue.offer-model-${n}`} aria-pressed={q.model === model.model && q.numCtx === model.numCtx}
          data-tip={`Run on ${describeModel(model.model, catalog).name}`} onClick={andFocus(() => void chooseForQueued(q.id, model.model, model.numCtx))}>
          <MakerMark tag={model.model} />
          <small>{k(model.numCtx)}</small>
          <Slower words={model.words} />
        </button>
      )}
    </>
  );
}

// why: council climb-025 Q15: a clock, "7%" and "10 s" alone never said what the question waits on
function ClockedWait({ words, at }: { words: string; at: string }) {
  const what = useStore((s) => waitingOn(s, words, at));
  const counting = at.includes("|");
  const short = shortWait(what);
  return (
    <>
      <Icon id="clock" cls={short === undefined ? "s14" : "s14 qt-wf"} />
      {short === undefined ? null : <Icon id={short.icon} cls="s14 qt-ws" />}
      <span className="vh">{words}</span>
      <span className="qt-w">{short === undefined ? what : <><span className="qt-wf">{what}</span><span className="qt-ws">{short.words}</span></>}</span>
      {counting ? <><span className="qt-d" aria-hidden="true">·</span><WaitNumbers value={at} /></> : null}
    </>
  );
}

const SHELF_ROWS = 3;

function QueueTray() {
  const [open, setOpen] = useState(false);
  const queued = useStore(waitingReplies);
  const threadId = useStore((s) => s.threadId);
  const editingId = useStore((s) => s.editingQueued);
  const first = useStore(firstPull);
  const model = useStore((s) => s.model);
  const kind = useStore(runningKind);
  const downloadAt = useStore(downloadNumbers);
  const setupAt = useStore(setupNumbers);
  const installing = useStore((s) => s.runtime?.state === "installing" || s.runtime?.state === "starting");
  const elsewhere = useStore(replyElsewhere);
  const mine = queued.filter((q) => q.threadId === threadId);
  if (mine.length === 0) return null;
  const n = mine.length;
  const nowTip = kind === null ? "Send now" : SEND_NOW[kind];
  const folds = n > SHELF_ROWS;
  const shown = (i: number, id: string) => !folds || open || i < SHELF_ROWS - 1 || id === editingId;
  const hidden = mine.filter((q, i) => !shown(i, q.id)).length;
  return (
    <ul className="qt" aria-label={`${n} queued message${n === 1 ? "" : "s"}`}>
      {mine.map((q, i) => {
        if (!shown(i, q.id)) return null;
        const editing = q.id === editingId;
        const words = queueWords(q, editing, first, model, installing, elsewhere);
        return (
          <li key={q.id} className="qt-r" aria-label={`Queued ${q.draw === undefined ? "message" : "image"} ${i + 1} of ${n}`}>
            {q.draw === undefined ? null : <span className="qt-k" data-tip="Image"><Icon id="image" cls="s14" /></span>}
            <span className="qt-t">{q.text}{q.images?.length ? ` · ${q.images.length} image${q.images.length === 1 ? "" : "s"}` : ""}{q.files?.length ? ` · ${q.files.length} file${q.files.length === 1 ? "" : "s"}` : ""}</span>
            {/* external: a browser announces changes in a live region, not one added already filled */}
            <span className="qt-s" role="status" data-tip={CLOCKED.has(words) ? words ?? undefined : undefined}>
              {CLOCKED.has(words) ? <ClockedWait words={words ?? ""} at={words === AFTER_SETUP ? setupAt : downloadAt} /> : words ?? ""}
            </span>
            {editing ? null : <QueueOffer q={q} n={i + 1} />}
            {!behindSetup(q) && !editing ? (
              <button type="button" className="ibtn xs" data-testid={`chat.queue.send-now-${i + 1}`} aria-label="Send now" data-send-now data-tip={nowTip} onClick={andFocus(() => sendQueuedNow(q.id))}>
                <SendArrow />
              </button>
            ) : null}
            {editing ? (
              <button type="button" className="ibtn xs" data-testid={`chat.queue.cancel-edit-${i + 1}`} aria-label="Cancel editing" aria-pressed="true" data-tip="Cancel editing" onClick={andFocus(cancelQueuedEdit)}>
                <Icon id="pencil" cls="s14" />
              </button>
            ) : (
              <button type="button" className="ibtn xs" data-testid={`chat.queue.edit-${i + 1}`} aria-label="Edit" data-edit-queued data-tip="Edit" onClick={andFocus(() => editQueued(q.id))}>
                <Icon id="pencil" cls="s14" />
              </button>
            )}
            <button type="button" className="ibtn xs" data-testid={`chat.queue.remove-${i + 1}`} aria-label="Remove" data-unqueue data-tip="Remove" onClick={andFocus(() => removeQueued(q.id))}>
              <Icon id="x" cls="s14" />
            </button>
          </li>
        );
      })}
      {folds ? (
        <li className="qt-more">
          <button type="button" className="ibtn xs" data-testid="chat.queue.more" aria-expanded={open}
            aria-label={open ? "Show fewer queued messages" : `Show ${hidden} more queued message${hidden === 1 ? "" : "s"}`}
            data-tip={open ? "Show fewer" : `${hidden} more`} onClick={() => setOpen(!open)}>
            {open ? <Icon id="down" cls="s14 up" /> : `+${hidden}`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function stopNames(blocking: NonNullable<State["stopAsk"]>["blocking"], catalog: ReturnType<typeof catalogOf>): string[] {
  return blocking.map((t) => `${describeModel(t.model, catalog).name} in ${t.title === "" ? "another chat" : `“${t.title}”`}`);
}

function StopWarning() {
  const ask = useStore((s) => s.stopAsk);
  const matches = useDraft(d => ask === null || ask.keepDraft || d.text.trim() === ask.content && d.images === ask.images);
  const catalog = useStore(catalogOf);
  const [never, setNever] = useState(false);
  useChange(ask, () => setNever(false));
  if (ask === null || !matches) return null;
  const names = stopNames(ask.blocking, catalog);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return (
    <div
      className="stopask"
      data-testid="chat.stop-warning.dialog"
      role="alertdialog"
      aria-label="Stop the other reply?"
      onKeyDown={(e) => {
        if (e.key === "Escape") andFocus(cancelStopAsk)();
        // external: a held key repeats keydown in the browser with event.repeat true
        else if (e.key === "Enter" && e.repeat) e.preventDefault();
      }}
    >
      <p>
        This stops {list}. {names.length > 1 ? "Their replies so far are kept." : "Its reply so far is kept."}
      </p>
      <div className="stopask-f">
        <label className="stopask-n">
          <input type="checkbox" data-testid="chat.stop-warning.never" checked={never} onChange={(e) => setNever(e.target.checked)} />
          Don't show this again
        </label>
        <button type="button" className="btn ghost" data-testid="chat.stop-warning.cancel" onClick={andFocus(cancelStopAsk)}>
          Cancel
        </button>
        <button type="button" className="btn primary" data-testid="chat.stop-warning.confirm" autoFocus onClick={andFocus(() => confirmStopAsk(never))}>
          Stop and send
        </button>
      </div>
    </div>
  );
}


const images = (n: number) => (n === 1 ? "1 image" : `${n} images`);

function about(ms: number, n: number): string {
  const secs = (ms * n) / 1000;
  return secs < 90 ? `~${Math.max(1, Math.round(secs))} s` : `~${Math.round(secs / 60)} min`;
}

const READ_WAIT_MS = 400;

function runOf(s: State): number | undefined {
  const p = chosenImage(s);
  return p === undefined ? undefined : s.imageRuns[runKey({ preset: p.preset.id, width: p.width, height: p.height })];
}

function pickCount(n: number): void {
  closePop(true);
  void pickImageCount(n).then((error) => { if (error !== null) setState({ notice: error }); });
}

function countArrows(e: ReactKeyboardEvent<HTMLDivElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : null;
  if (to === null) return;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
}

function CountButton({ open }: { open: boolean }) {
  const count = useStore(imageCount);
  const pictured = useStore(chosenImage);
  const toggle = async (kb: boolean) => {
    if (!open && pictured !== undefined) await withTimeout(readImageRun({ preset: pictured.preset.id, width: pictured.width, height: pictured.height }), READ_WAIT_MS, () => undefined);
    togglePop("count", kb);
  };
  return (
    <button
      type="button"
      className={`pill gate thinking count${count > 1 ? " on" : ""}`}
      id="countBtn"
      data-testid="chat.composer.count"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Pictures per send: ${count}`}
      data-tip="Pictures per send"
      onClick={(e) => void toggle(e.detail === 0)}
    >
      <span className="lead cnt" aria-hidden="true">{count}</span>
      <span className="plbl">{images(count)}</span>
    </button>
  );
}

export function CountMenu() {
  const open = useStore((s) => s.pop?.id === "count");
  const kb = useStore((s) => s.pop?.id === "count" && s.pop.kb);
  const count = useStore(imageCount);
  const ms = useStore(runOf);
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, open, (el) => {
    const anchor = document.getElementById("countBtn");
    if (anchor) place(el, anchor, "start");
    if (kb) el.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [kb]);
  useDocumentEvent("keydown", (e) => {
    const n = Number(e.key);
    if (e.ctrlKey || e.metaKey || e.altKey || !Number.isInteger(n) || n < 1 || n > IMAGE_COUNT_MAX) return;
    e.preventDefault();
    pickCount(n);
  }, { when: open });
  return (
    <div className={`pop menu count-menu${open ? " open" : ""}`} id="countMenu" data-testid="chat.count-menu.menu" role="menu" aria-label="Pictures per send" ref={ref} onKeyDown={countArrows}>
      {Array.from({ length: IMAGE_COUNT_MAX }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" className="mi" data-testid={`chat.count-menu.pick-${n}`} role="menuitemradio" aria-checked={n === count} onClick={() => pickCount(n)}>
          <Icon id="check" cls="chk" />
          <b>{images(n)}</b>
          {ms === undefined ? null : <small>{about(ms, n)}</small>}
        </button>
      ))}
    </div>
  );
}

function menuImage(image: boolean, close: boolean): void {
  const unset = !image && imagesUnset(getState());
  if (close || unset) closePop();
  if (unset) togglePop("unset");
  else setState({ image: !image });
}

export function PlusMenu() {
  const open = useStore((s) => s.pop?.id === "plus");
  const imageGen = useStore(imageGenOf);
  const image = useStore((s) => s.image);
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, open, (el) => {
    const anchor = document.getElementById("plusBtn");
    if (anchor) place(el, anchor, "start");
  }, []);
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="plusMenu" role="menu" ref={ref}>
      <SheetHead title="Add" />
      <button
        type="button"
        className="mi"
        role="menuitem"
        data-testid="chat.plus-menu.attach"
        data-attach
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
        data-testid="chat.plus-menu.library"
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
          data-testid="chat.plus-menu.image"
          data-gen
          onClick={() => menuImage(image, true)}
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
          data-testid="chat.plus-menu.image-setup"
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
  usePopover(ref, open, (el) => {
    const anchor = document.getElementById("optBtn");
    if (anchor) place(el, anchor, "end");
  }, []);
  const ctx = ctxFor(numCtx, models, model);
  const pct = Math.min(1, used / ctx);
  const tag = first ?? model;
  const thinkNa = ready ? thinkNote(models?.find((m) => m.name === model), tag === undefined ? "No model" : describeModel(tag, catalog).name, first !== undefined) : null;
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="optsMenu" role="menu" aria-label="Chat options" ref={ref}>
      <SheetHead title="Chat options" />
      <button
        type="button"
        className={`mi${thinkNa !== null ? " off" : ""}`}
        data-testid="chat.options-menu.thinking"
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
        <button type="button" className="mi" data-testid="chat.options-menu.image" role="menuitemcheckbox" aria-checked={image} onClick={() => menuImage(image, false)}>
          <Icon id="image" />
          <span>
            <b>Image</b>
            <small>{image ? "Send makes a picture from your words" : "Off: Send goes to the chat model"}</small>
          </span>
          <span className="switch" aria-hidden="true" />
        </button>
      ) : (
        <button type="button" className="mi off" data-testid="chat.options-menu.image-off" role="menuitemcheckbox" aria-checked={false} aria-disabled="true" data-image-off>
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

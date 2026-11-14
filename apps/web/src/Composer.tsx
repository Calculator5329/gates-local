// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The composer (shell.md F01, F02, F15, F28-F31, F34, F37b, F43b): the text
// box, model and context chips, Thinking and Image pills, the context meter,
// Send or Stop, and the popovers it opens (model picker, + menu).
import { type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type AttachedFile, IMAGE_COUNT_MAX, type ModelInfo } from "@gates-local/contracts";
import { useActionPress } from "./composer-press.ts";
import { CONNECTING, PLACEHOLDER, booting, rtOf, unread } from "./Banner.tsx";
import { openFit } from "./fit-actions.ts";
import { fitFor, stopsChat } from "./fit-table.ts";
import { ctxFor, describeModel, k, noGpu, verdictOf } from "./format.ts";
import { DownloadBar, LoadRing } from "./LoadBar.tsx";
import { loadGuess } from "./load-times.ts";
import { MakerMark } from "./MakerMark.tsx";
import { RefusalNote } from "./RefusalNote.tsx";
import { pickerLabels } from "./picker-models.ts";
import { imagePickerScreen, pickerScreen, threadScreen } from "./screen-loaders.ts";
import { chosenImage, imageCount, imageMode, imagesUnset, sizeLabel } from "./image-choice.ts";
import { ImageMark } from "./ImageMark.tsx";
import { Icon, SendArrow } from "./icons.tsx";
import { canThink, chatBlockedReason, chatModels, sendableModel } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import { AttachedFiles, AttachmentImages, RefusedFiles } from "./attachment-images.tsx";
import { DropMarker } from "./file-drop.tsx";
import { attachFiles, imageReason, paste } from "./paste.ts";
import { useRefused } from "./refused-files.ts";
import {
  cancelQueuedEdit,
  cancelStopAsk,
  confirmStopAsk,
  editQueued,
  firstPull,
  lastImageRunMs,
  openSettings,
  pickImageCount,
  queueReason,
  removeQueued,
  send,
  sendQueuedNow,
  stop,
  typedInComposer,
} from "./session.ts";
import { NA, type Queued, type State, getState, runningTurn, setState, streamingHere, useStore } from "./store.ts";
import { editDraft, getDraft, useDraft } from "./drafts.ts";
import { PHONE, SheetHead, Skel, closePop, closeTip, esc, isTouch, openTip, place, togglePop, useMedia } from "./ui.tsx";

/**
 * A phone-sized touch screen: the one place Enter adds a new line and the Send arrow sends.
 * Everywhere a keyboard is likely, a remote desktop with no hover included, Enter sends.
 */
const PHONE_TOUCH = `(pointer: coarse) and ${PHONE}`;
import { Speaker, Voice } from "./Voice.tsx";
import { useTalk } from "./talk.ts";

const catalogOf = (s: Pick<State, "catalog">) => (s.catalog === NA ? undefined : s.catalog);
const imageGenOf = (s: State) => s.settings !== NA && s.settings?.imageGen === true;
const pctOf = (done: number, total: number | undefined) => (total ? Math.round((done / total) * 100) : 0);

// The first send replaces Draft's composer with the thread's in the same commit.
// Transfer primary-action focus only to that immediate replacement.
let primaryFocus = false;
const NO_FILES: readonly AttachedFile[] = [];

/** Tokens the open thread holds: the last reply's prompt plus its answer. */
function usedTokens(s: State): number {
  if (s.view !== "thread" || s.threadId === null) return 0;
  const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "assistant" && m.stats !== undefined);
  return (last?.stats?.promptTokens ?? 0) + (last?.stats?.completionTokens ?? 0);
}

/**
 * Why the Thinking pill cannot be used now, as its tip in a few words, or null when it can. It
 * depends on the model's "thinking" capability, so it waits for a chat
 * model to be installed (F70) and greys for a model without it.
 */
export function thinkUnavailable(model: ModelInfo | undefined, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Thinking: after the download";
  return canThink(model) ? null : "Thinking: not on this model";
}

/** The same answer as plain words for a phone's menu row, which has no tooltip. */
function thinkNote(model: ModelInfo | undefined, name: string, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Available when the model finishes downloading";
  return canThink(model) ? null : `${name} does not reason before answering`;
}

/** Which model, as the model button's tip: its name and its tag; a tag the catalog does not know is its own name, said once. */
function tagTip(name: string, tag: string): string {
  return name === tag ? `<b class="mono">${esc(tag)}</b>` : `<b>${esc(name)}</b> · <span class="mono">${esc(tag)}</span>`;
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
  const files = useDraft(d => d.files ?? NO_FILES);
  const refused = useRefused().length;
  const replacement = useDraft(d => d.version);
  const pasting = useStore((s) => s.pasting);
  const askingNow = useStore((s) => s.asking === true);
  const notice = useStore((s) => s.notice);
  const noticeOffer = useStore((s) => s.noticeOffer);
  const fit =useStore((s) => fitFor(s.fitTable, s.model, ctxFor(s.numCtx, s.models, s.model)));
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const imageGen = useStore(imageGenOf);
  const isStreaming = useStore(streamingHere);
  const editingId = useStore((s) => s.editingQueued);
  const editing = editingId !== null;
  const running = useStore((s) => runningTurn(s, s.threadId)?.gen ?? null);
  const drawingNow = useStore(runningKind) === "image";
  // Enter adds a new line only on a phone-sized touch screen; with no hover over a remote desktop it still sends
  const touch = useMedia(PHONE_TOUCH);
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
  const cpu = useStore((s) => noGpu(s.gpu));
  const used = useStore(usedTokens);
  const pop = useStore((s) => s.pop?.id ?? null);
  const pickerPending = useStore(s => s.pop?.id === "picker" && !s.pop.ready);
  const view = useStore((s) => s.view);
  const voiceThread = useStore((s) => s.threadId);
  const drawing = useStore(imageMode);
  const pictured = useStore(chosenImage);
  const unset = useStore(imagesUnset);
  // a default ComfyUI does not list is still sent (the server settles it) but never named
  const named = pictured?.listed === true ? pictured : undefined;
  const online = useStore((s) => s.conn.kind === "open");
  const ta = useRef<HTMLTextAreaElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // Preparing a reply is user intent, not an idle startup download. The
  // renderer can arrive while the person types, before the first Send.
  useEffect(() => {
    if (hasText || images.length || files.length) void threadScreen.load();
  }, [hasText, images.length, files.length]);
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
  const name = shownTag === undefined ? "No model" : pickerLabels([...chatModels(models ?? []).map(m => m.name), shownTag], catalog).get(shownTag) ?? shownTag;
  const loading = loadState === "loading";
  const loadingNow = loading && first === undefined;
  // a message of this chat is waiting for its model to load: the one time a load is shown, on the button being waited on
  const waitsOnLoad = loadingNow && isStreaming && !drawingNow;
  // The fit table's row: the server builds none while a load runs, so a loading model keeps the verdict from before it.
  const v = fit === undefined ? undefined : verdictOf(fit);
  const text = hasText || images.length > 0 || files.length > 0;
  const imageNo = imageReason(models, model, images, tag => describeModel(tag, catalog).name);
  const why = chatBlockedReason(models, model); // a download would not help: old Ollama, or the model is still being checked
  const noModel = (model === undefined || why !== undefined) && !queueable;
  // During setup the gate style already greys every control; otherwise the pill says why it is off.
  const thinkNa = blocked ? null : thinkUnavailable(models?.find((m) => m.name === model), first !== undefined);

  // the label is the name and nothing else, so the button keeps its width (chat rows 28, 29): a download
  // is the bar on its edge, and its percent, like a download still to come, is in the tip
  const modelTip =
    shownTag === undefined
      ? "Model"
      : rt === "installing"
        ? `${tagTip(name, shownTag)}<br>Downloads next`
        : first !== undefined
          ? `${tagTip(name, shownTag)}<br>Downloading ${firstProgress}%`
          : loading
            ? `${tagTip(name, shownTag)}<br>Loading into ${cpu ? "memory" : "GPU memory"}${loadMs === undefined ? "" : `, ${loadGuess(loadMs)}`}`
            : tagTip(name, shownTag);

  const ctx = ctxFor(numCtx, models, model);
  const pct = Math.min(1, used / ctx);
  const meterHidden = pct < 0.5 || blocked || view !== "thread";

  // before the first read nothing is known: the words of a ready app, never a problem not yet seen;
  // past the boot bound with still nothing read, one neutral word until the runtime answers
  // a message typed during the first download says when it goes once, in its queue row (chat row 29)
  const placeholder = noModel && ready ? (why ?? "Download a model to start chatting") : boot ? PLACEHOLDER.ready : none ? CONNECTING : PLACEHOLDER[rt];

  // A message queued behind a reply is checked when it goes, and memory a reply holds may be freed by stopping it.
  const memNo = v?.k === "no" && !isStreaming && !freed && !editing;
  // The tip names the button and its key, as the app's other tips do ("New thread · Ctrl N"). A refusal says why
  // in a few words only where nothing else on screen does: the placeholder already says what setup, Ollama or a
  // missing model is waiting for, and a queued message's row says when it goes.
  const enter = touch ? "" : " · Enter";
  let sendTip = `Send${enter}`;
  if (editing) sendTip = `Update${enter}`;
  else if (isStreaming && !blocked) sendTip = `Queue${enter}`;
  else if (!queueable && !boot && !none && !blocked && !noModel) {
    // the click opens the why, with its numbers
    if (memNo) sendTip = `Not enough memory at ${k(ctx)}`;
    else if (text && freed) sendTip = `Send${enter}. Another chat's reply stops first`;
  }
  // Not ready and nothing queues: once typed words hide the placeholder, the tip is what it said is awaited
  // (owner, 2026-11-14: "enter to send message is sometimes not working"); with the box empty the placeholder says it
  if (!drawing && text && ((blocked && !queueable) || noModel)) sendTip = boot ? CONNECTING : placeholder;
  // the model list not read yet, or the model not in it: send() would hold the message with nothing said
  const unlisted = !drawing && ready && !queueable && !noModel && model !== undefined && sendableModel(models, model) === undefined;
  if (unlisted) sendTip = models === undefined ? "Reading the models…" : models.some((m) => m.name === model) ? `${name} can't chat` : `${name} isn't installed`;
  if (imageNo !== null) sendTip = "This model can't see images";
  if (refused) sendTip = `Remove the file${refused === 1 ? "" : "s"} marked not sent`;
  if (pasting) sendTip = "Attaching…";
  // Image on: the words go to the image model, so the chat model's readiness, memory and sight do not count.
  const drawNo = !drawing ? null : images.length > 0 || files.length > 0 ? "Image takes words only" : !online ? "Gates Local isn't answering" : unset ? "Images are not set up" : pictured === undefined ? "Reading the image models…" : null;
  if (drawing && !editing && !isStreaming && !refused && !pasting) sendTip = drawNo ?? `Make image${enter}`;
  const sendDisabled = drawing ? !text || drawNo !== null || refused > 0 || pasting > 0
    : (blocked && !queueable) || (!blocked && memNo) || noModel || unlisted || !text || imageNo !== null || refused > 0 || pasting > 0;
  // Refused for memory: the button stays focusable and clickable, and the click opens the why.
  const memRefused = !drawing && !blocked && !queueable && !noModel && !unlisted && memNo && imageNo === null && !refused && !pasting;
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
  // Enter is never met by nothing: with words typed it does what a click on Send does, and where Send is off it says why
  const enterSend = () => {
    const answer = enterAnswer({ sendDisabled, memRefused, text, showStop });
    if (answer === "send") submit();
    else if (answer === "fit") openFit();
    else if (answer === "tip") openTip(primary.current);
    // Stop holds Send's place while a reply runs: the reason goes in the note over the box, which the next edit clears
    else if (answer === "note") setState({ notice: sendTip });
  };
  // talk mode sends after the transcript is drawn, with Send's latest judgement of the draft
  const latestSubmit = useRef(submit);
  useLayoutEffect(() => { latestSubmit.current = submit; });
  const talkSend = useCallback(() => latestSubmit.current(), []);
  const talk = useTalk().on;
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
  // the square stops what runs; it names the picture when a picture is what it stops
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
        {/* chat row 36: the queue is a shelf inside the box, at its width */}
        <QueueTray />
        <div className="att"><AttachmentImages images={images} removable /><AttachedFiles files={files} removable /><RefusedFiles /></div>
        {/* "+ › Attach a file" opens this; like T3 Code's paperclip it takes any file, and each is sorted at its chip */}
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
                  // nothing here can draw: say so instead of entering a mode whose Send cannot work
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
            {/* Image on: the Thinking circle's place holds how many pictures a send makes; off, the bulb is back */}
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
            {/* Stop takes Dictate's square while a queued message is edited; Dictate stays mounted under it, so its shortcut still answers */}
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
              onKeyDown={e => {
                if (e.key !== "ArrowDown") return;
                e.preventDefault();
                pickerIntent();
                if (pop !== (drawing ? "images" : "picker")) togglePop(drawing ? "images" : "picker", true);
              }}
              onClick={() => togglePop(drawing ? "images" : "picker")}
            >
              {/* Image on: the image model and size Send uses, in the same box */}
              {drawing ? <>
                {named === undefined ? null : <ImageMark family={named.preset.family} />}
                <span className="t">{named === undefined ? "Image model" : named.preset.short ?? named.preset.name}</span>
                {named === undefined ? null : <small className="picker-trigger-ctx">{sizeLabel(named.width, named.height)}</small>}
              </> : boot && shownTag === undefined ? <Skel w="8.5em" /> : <>
                {/* a load changes nothing here (owner's pick D): it is the ring around Send, and its time is in this button's tip */}
                {shownTag === undefined ? null : <MakerMark tag={shownTag} busy={pickerPending} />}
                <span className="picker-trigger-name">{name}</span>
                <small className="picker-trigger-ctx">{k(ctx)}</small>
                {first === undefined ? null : <DownloadBar pct={firstProgress} />}
              </>}
            </button>
            {/* a phone has no room for the pills and the meter: they live in this sheet */}
            <button type="button" className="ctl sq gate" id="optBtn" data-testid="chat.composer.options" aria-haspopup="menu" aria-expanded={pop === "opts"} aria-label="Chat options" onClick={() => togglePop("opts")}>
              <Icon id="sliders" />
            </button>
            {/* a reply on touch: the main button is the queue arrow, and Stop holds its own slot one press away */}
            {isStreaming && !showStop && !stopForVoice ? stopSquare : null}
            <button
              ref={primary}
              type="button"
              className={showStop ? "send stop" : "send"}
              data-testid="chat.composer.send"
              aria-label={showStop ? "Stop" : sendLabel}
              data-tip={showStop ? stopTip : sendTip}
              // Keep the same focusable node through empty, running and finished states.
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
      {notice !== null && noticeOffer?.notice === notice ? <RefusalNote o={noticeOffer} /> : notice !== null ? (
        <p className={`na c-note${memNo ? " no" : ""}`} data-testid="chat.composer.notice" role="status">
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
  const newlineOnEnter = useMedia(PHONE_TOUCH);
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
  return <textarea ref={textarea} id="ta" data-testid="chat.composer.message" data-draft-version={version} className="ta" rows={1} placeholder={placeholder} aria-label="Message" value={draft} onPaste={paste}
    onChange={e => {
      editDraft(e.target.value);
      // the first key starts the thread's model loading while the person writes (chat row 39)
      if (e.target.value !== "") typedInComposer();
    }} onKeyDown={e => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !newlineOnEnter) { e.preventDefault(); submit(); }
    }} />;
}

// ---------------------------------------------------------------- queue and warning

/** Why Ctrl+Shift+Space does not start dictation while Stop holds Dictate's square. */
const VOICE_HELD = "Dictate comes back when this reply ends or you finish editing the queued message.";

/** A queued message's state in a word or two, only where being in the queue does not already say it: null while it waits for the reply, and while it is edited (the pressed pencil says that). */
/**
 * What Enter in the message box does (owner, 2026-11-14: "enter to send message is sometimes not
 * working"): with Send on, send; with words typed and Send off for memory, what the click does
 * (the memory panel); otherwise Send's reason at Send, or in the note over the box while Stop holds
 * Send's place. Nothing only with nothing typed.
 */
export function enterAnswer(s: { readonly sendDisabled: boolean; readonly memRefused: boolean; readonly text: boolean; readonly showStop: boolean }): "send" | "fit" | "tip" | "note" | null {
  if (!s.sendDisabled) return "send";
  if (!s.text) return null;
  if (s.memRefused) return "fit";
  return s.showStop ? "note" : "tip";
}

export function queueWords(q: Queued, editing: boolean, first: string | undefined, model: string | undefined): string | null {
  if (editing) return null;
  if (q.waitFor === "download") return first === undefined && (q.model ?? model) === undefined ? "Download stopped" : AFTER_DOWNLOAD;
  if (q.waitFor === "setup") return AFTER_SETUP;
  if (q.retry === "running") return RETRYING;
  if (q.retry === "failed") return RETRY_FAILED;
  return q.held ? "On hold" : null;
}

/** The owner's words for a queue behind a failed reply the server runs once more (chat row 23, decision 7). */
const RETRYING = "Retrying the reply before it";
const RETRY_FAILED = "On hold: the reply before it didn't finish";
/** A message waiting for the first download: the row shows a clock, and this is its tip and its spoken words (chat row 29). */
export const AFTER_DOWNLOAD = "Sends when the download finishes";
/** The same clock for a message waiting for setup (chat row 31). */
export const AFTER_SETUP = "Sends when setup finishes";
/** The clock is the row's only mark for these, so its tip names it; a word on the row has no tip (decision 19). */
const CLOCKED = new Set<string | null>([AFTER_DOWNLOAD, AFTER_SETUP]);

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

/** More queued than this fold to the next two and a count (chat row 36). */
const SHELF_ROWS = 3;

/**
 * Messages waiting in this chat, on a shelf at the top of the message box (chat row 36). One line
 * each: what it will make (a picture when it was queued with Image on), its words, then icons to
 * send it now, edit it in the composer, or remove it. More than three fold to a count.
 */
function QueueTray() {
  const [open, setOpen] = useState(false);
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
  const folds = n > SHELF_ROWS;
  const shown = (i: number, id: string) => !folds || open || i < SHELF_ROWS - 1 || id === editingId;
  const hidden = mine.filter((q, i) => !shown(i, q.id)).length;
  return (
    <ul className="qt" aria-label={`${n} queued message${n === 1 ? "" : "s"}`}>
      {mine.map((q, i) => {
        if (!shown(i, q.id)) return null;
        const editing = q.id === editingId;
        const words = queueWords(q, editing, first, model);
        return (
          <li key={q.id} className="qt-r" aria-label={`Queued ${q.draw === undefined ? "message" : "image"} ${i + 1} of ${n}`}>
            {/* a chat is the default, so only a picture marks its kind (chat row 19) */}
            {q.draw === undefined ? null : <span className="qt-k" data-tip="Image"><Icon id="image" cls="s14" /></span>}
            <span className="qt-t">{q.text}{q.images?.length ? ` · ${q.images.length} image${q.images.length === 1 ? "" : "s"}` : ""}{q.files?.length ? ` · ${q.files.length} file${q.files.length === 1 ? "" : "s"}` : ""}</span>
            {/* always there, empty while the message just waits, so a reader announces the word when it appears */}
            <span className="qt-s" role="status" data-tip={CLOCKED.has(words) ? words ?? undefined : undefined}>
              {CLOCKED.has(words) ? <><Icon id="clock" cls="s14" /><span className="vh">{words}</span></> : words ?? ""}
            </span>
            {q.waitFor === "reply" && !editing ? (
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
      data-testid="chat.stop-warning.dialog"
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

// ---------------------------------------------------------------- picture count (Image on)

const images = (n: number) => (n === 1 ? "1 image" : `${n} images`);

/** About how long `n` pictures take at `ms` each: seconds, minutes from 90 s. */
function about(ms: number, n: number): string {
  const secs = (ms * n) / 1000;
  return secs < 90 ? `~${Math.max(1, Math.round(secs))} s` : `~${Math.round(secs / 60)} min`;
}

/** This computer's last time for the setup the menu was opened on: read before it opens, so its rows never change under the pointer. */
let lastRun: { key: string; ms: number | undefined } | undefined;
const runKey = (c: { preset: string; width: number; height: number }) => `${c.preset}:${c.width}x${c.height}`;
const READ_WAIT_MS = 400;

function pickCount(n: number): void {
  closePop(true);
  void pickImageCount(n).then((error) => { if (error !== null) setState({ notice: error }); });
}

/** Up and Down move between the counts. */
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
    if (!open && pictured !== undefined) {
      const choice = { preset: pictured.preset.id, width: pictured.width, height: pictured.height };
      const key = runKey(choice);
      // never longer than a moment: without an answer the rows show no times
      const ms = await Promise.race([lastImageRunMs(choice), new Promise<undefined>((done) => setTimeout(done, READ_WAIT_MS))]);
      lastRun = { key, ms: ms ?? (lastRun?.key === key ? lastRun.ms : undefined) };
    }
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

/** One to four pictures per send, each with this computer's time for the setup Send uses; keys 1 to 4 pick while it is open. */
export function CountMenu() {
  const open = useStore((s) => s.pop?.id === "count");
  const kb = useStore((s) => s.pop?.id === "count" && s.pop.kb);
  const count = useStore(imageCount);
  const pictured = useStore(chosenImage);
  const drawing = useStore(imageMode);
  const ref = useRef<HTMLDivElement>(null);
  // Image off takes the button away, and its menu with it
  useEffect(() => { if (open && !drawing) closePop(); }, [open, drawing]);
  const ms = pictured !== undefined && lastRun?.key === runKey({ preset: pictured.preset.id, width: pictured.width, height: pictured.height }) ? lastRun.ms : undefined;
  useLayoutEffect(() => {
    const anchor = document.getElementById("countBtn");
    if (open && ref.current && anchor) place(ref.current, anchor, "start");
    if (open && kb) ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open, kb]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (e.ctrlKey || e.metaKey || e.altKey || !Number.isInteger(n) || n < 1 || n > IMAGE_COUNT_MAX) return;
      e.preventDefault();
      pickCount(n);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
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

// ---------------------------------------------------------------- + menu

/** A menu's Image row: on or off, or, with nothing here that can draw, the pop-up that says so in the menu's place. */
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
        data-testid="chat.plus-menu.attach"
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

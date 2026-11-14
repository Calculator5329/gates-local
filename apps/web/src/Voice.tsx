import { type RefObject, useEffect, useRef, useState } from "react";
import { call, openSettings } from "./session.ts";
import { NA, getState, overChat, setState, useStore } from "./store.ts";
import { getDraft, useDraft } from "./drafts.ts";
import type { captureAudio } from "./voice-audio.ts";
import { insertAtCursor } from "./draft-insertion.ts";
import { Icon } from "./icons.tsx";
import { hush, setTalk, useLocalVoice, useTalk } from "./talk.ts";

type Phase = "idle" | "asking" | "listening" | "transcribing";
type Dictation = { id: string; draftVersion: number };
/** A press shorter than this is a tap, not a talk: nothing is sent. */
const HOLD_MS = 300;
const HOLD_NOTE = "Hold the microphone or Space while you talk.";
/**
 * Dictate. `held` is set while Stop holds this square (a queued message edited during a reply): the button is gone,
 * the component stays, and the shortcut says why it does not start. In talk mode (chat row 38, a try-out) the same
 * button is held to talk, as is Space in an empty message box, and letting go sends with `send`.
 */
export function Voice({ textarea, held = null, send }: { textarea: RefObject<HTMLTextAreaElement | null>; held?: string | null; send?: () => void }) {
  const settings = useStore((s) => s.settings);
  const conn = useStore((s) => s.conn);
  const draftVersion = useDraft(d => d.version);
  const covered = useStore((s) => overChat(s.view) || s.panel !== null);
  const enabled = settings !== NA && !!settings?.whisperUrl;
  const [phase, show] = useState<Phase>("idle");
  const [seconds, time] = useState(0);
  const phaseRef = useRef<Phase>("idle");
  const recording = useRef<Awaited<ReturnType<typeof captureAudio>> | null>(null);
  const capture = useRef<AbortController | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const holding = useRef<"pointer" | "space" | null>(null);
  const pressedAt = useRef(0);
  const valid = (current: Dictation) => dictation.current === current && getDraft().version === current.draftVersion;
  const unsupported = !window.isSecureContext ? "Microphone needs HTTPS on a phone or the desktop app." : !navigator.mediaDevices?.getUserMedia || !window.AudioContext ? "This browser cannot record microphone audio. Use the desktop app." : null;
  const talking = useTalk().on && enabled && unsupported === null;
  const state = (p: Phase) => { phaseRef.current = p; show(p); };
  const cancel = () => {
    const current = dictation.current;
    dictation.current = null;
    holding.current = null;
    capture.current?.abort(); capture.current = null;
    recording.current?.discard(); recording.current = null;
    if (current && phaseRef.current === "transcribing") void call("voice.cancel", { id: current.id }).catch(() => {});
    state("idle");
  };
  useEffect(() => {
    const leave = () => cancel();
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); cancel(); };
  }, [enabled, conn, draftVersion]);
  // Settings or a pop-up over the chat keeps the composer mounted but hidden: a dictation
  // running into it would type where nobody sees and take Esc from the screen on top.
  useEffect(() => { if (covered) cancel(); }, [covered]);
  // The square was Stop's a moment ago: the rest of a double-click on Stop must not land here (useActionPress guards Send the same way).
  const shownAt = useRef(-Infinity);
  const wasHeld = useRef(held !== null);
  useEffect(() => {
    if (held !== null) cancel();
    else if (wasHeld.current) shownAt.current = performance.now();
    wasHeld.current = held !== null;
  }, [held]);
  useEffect(() => {
    if (phase !== "listening") return;
    const started = performance.now();
    const timer = setInterval(() => {
      const elapsed = Math.floor((performance.now() - started) / 1000);
      time(elapsed);
      if (elapsed >= 60) { cancel(); setState({ notice: "The clip reached 60 seconds. Try a shorter recording." }); }
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  /** Stop listening and transcribe into the draft at the cursor; in talk mode the draft is then sent. */
  const finish = async (then: "draft" | "send") => {
    const current = dictation.current;
    if (!current) return;
    const audio = recording.current?.finish(); recording.current = null;
    capture.current = null;
    if (!audio) return;
    state("transcribing");
    try {
      const { text } = await call("voice.transcribe", { id: current.id, audio });
      const { insertTranscript } = await import("./voice-audio.ts");
      if (!valid(current)) return;
      const el = textarea.current;
      const cursor = el?.selectionStart ?? 0;
      const next = insertTranscript(el?.value ?? "", cursor, text);
      const inserted = el !== null && insertAtCursor(el, next.draft.slice(cursor, next.cursor));
      // A drawer can make the composer inert. Keep the words as selectable
      // plain text, visible when the drawer closes, instead of discarding them.
      setState({ notice: inserted ? null : `Transcript kept. Copy it into your draft: ${text}` });
      // sent once the composer has drawn the words, so Send judges the draft as it is now
      if (inserted && then === "send") setTimeout(() => send?.(), 0);
    } catch (e) {
      if (valid(current)) setState({ notice: e instanceof Error ? e.message : "Transcription failed. Try again." });
    } finally {
      if (dictation.current === current) { dictation.current = null; state("idle"); }
    }
  };
  const toggle = async () => {
    if (phaseRef.current === "asking" || phaseRef.current === "transcribing") return;
    if (unsupported) { setState({ notice: unsupported }); return; }
    if (!enabled) { openSettings("general"); return; }
    if (phaseRef.current === "listening") { await finish(talking ? "send" : "draft"); return; }
    const current: Dictation = { id: crypto.randomUUID(), draftVersion: getDraft().version };
    dictation.current = current;
    const controller = new AbortController(); capture.current = controller;
    state("asking"); setState({ notice: null });
    let stream: MediaStream | undefined;
    let recorderFailed = false;
    const release = () => stream?.getTracks().forEach((track) => track.stop());
    try {
      // Ask for permission on this press while the small capture chunk loads.
      // A cancelled or failed import still releases a late microphone stream.
      const microphone = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }).then((mic) => {
        if (!valid(current)) mic.getTracks().forEach((track) => track.stop());
        else { stream = mic; controller.signal.addEventListener("abort", release, { once: true }); }
        return mic;
      });
      const recorder = import("./voice-audio.ts").catch((error: unknown) => { recorderFailed = true; throw error; });
      const [mic, { captureAudio }] = await Promise.all([microphone, recorder]);
      controller.signal.removeEventListener("abort", release);
      stream = mic;
      if (!valid(current)) { stream.getTracks().forEach((t) => t.stop()); return; }
      const audio = await captureAudio(stream, () => { cancel(); setState({ notice: "The clip reached 60 seconds. Try a shorter recording." }); }, controller.signal);
      if (!valid(current)) { audio.discard(); return; }
      recording.current = audio; time(0); state("listening");
    } catch (e) {
      controller.signal.removeEventListener("abort", release);
      stream?.getTracks().forEach((track) => track.stop());
      if (!valid(current)) return;
      dictation.current = null;
      capture.current = null;
      state("idle");
      const name = e instanceof DOMException ? e.name : "";
      setState({ notice: name === "NotAllowedError" ? "Microphone permission was denied. Allow microphone access for Gates Local, then retry." : name === "NotFoundError" ? "No microphone found. Connect one, then retry." : recorderFailed ? "Dictation could not load. Reload Gates Local, then retry." : "The microphone could not start. Check that it is connected and available, then retry." });
    }
  };
  // Talk mode: a hold talks, letting go sends; the reply being read stops at once
  const holdStart = (how: "pointer" | "space") => {
    if (phaseRef.current !== "idle") return;
    holding.current = how; pressedAt.current = performance.now();
    hush();
    void toggle();
  };
  const holdEnd = () => {
    if (holding.current === null) return;
    holding.current = null;
    if (performance.now() - pressedAt.current < HOLD_MS) { cancel(); setState({ notice: HOLD_NOTE }); }
    else if (phaseRef.current === "listening") void finish("send");
    else cancel();
  };
  /** Space talks from an empty message box, or with nothing else focused, while the chat is on top. */
  const spaceTalks = () => {
    const s = getState();
    const at = document.activeElement;
    return getDraft().text === "" && (at === textarea.current || at === document.body) && !overChat(s.view) && s.panel === null;
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const plain = !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      if (e.key === "Escape" && phaseRef.current !== "idle") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
      // held Space repeats: none of them types a space
      else if (e.code === "Space" && holding.current === "space") e.preventDefault();
      else if (talking && held === null && e.code === "Space" && plain && !e.repeat && phaseRef.current === "idle" && spaceTalks()) { e.preventDefault(); holdStart("space"); }
      // under Settings or a pop-up the chat is kept but hidden: dictation would type into a draft nobody sees
      else if (e.code === "Space" && e.ctrlKey && e.shiftKey && !e.repeat && !overChat(getState().view) && getState().panel === null) {
        e.preventDefault();
        if (held === null) void toggle();
        else setState({ notice: held });
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space" && holding.current === "space") { e.preventDefault(); holdEnd(); } };
    // the window lost focus mid-hold: its key-up never comes here, so nothing is sent
    const away = () => { if (holding.current !== null) cancel(); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", away);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", away); };
  });
  // Only the microphone shows; the state is its colour (amber asking, green
  // listening) or a spinner, and the words live in the tooltip, the label and
  // a hidden status line. Seconds stay out of data-tip: a changing tip closes.
  const status = phase === "listening" ? "Listening" : phase === "transcribing" ? "Transcribing" : phase === "asking" ? "Waiting for microphone permission" : "";
  const tip = talking ? (phase === "listening" ? "Listening. Let go to send. Esc cancels."
    : phase === "transcribing" ? "Transcribing… Esc cancels."
    : phase === "asking" ? "Allow microphone access to talk. Esc cancels."
    : "Hold to talk (or Space). Let go to send.")
    : phase === "listening" ? "Listening. Click or Ctrl+Shift+Space to stop and transcribe. Esc cancels."
    : phase === "transcribing" ? "Transcribing… Esc cancels."
    : phase === "asking" ? "Allow microphone access to dictate. Esc cancels."
    : unsupported ?? (!enabled ? "Dictate: connect whisper.cpp in Settings › General" : "Dictate (Ctrl+Shift+Space). Click again to stop. Esc cancels.");
  const name = talking ? (phase === "listening" ? "Talk, listening" : phase === "transcribing" ? "Talk, transcribing" : phase === "asking" ? "Talk, waiting for microphone permission" : "Talk")
    : phase === "listening" ? "Stop dictation" : phase === "transcribing" ? "Dictate, transcribing" : phase === "asking" ? "Dictate, waiting for microphone permission" : "Dictate";
  const click = (e?: { detail?: number }) => {
    // detail 0 (or none) is a keyboard press, never the tail of a double-click
    const detail = e?.detail ?? 0;
    // talk mode: a pointer press was the hold itself; a keyboard press starts and then sends
    if (talking && detail > 0) return;
    if (detail > 1 || (detail === 1 && performance.now() - shownAt.current < 400)) return;
    void toggle();
  };
  if (held !== null) return null;
  return <button type="button" className={`ctl sq voice ${phase}${talking ? " talk" : ""}`} data-testid="chat.composer.dictate" aria-label={name} aria-pressed={phase === "listening"} aria-busy={phase === "transcribing" || phase === "asking"} aria-disabled={unsupported !== null || phase === "transcribing" || phase === "asking"} data-tip={tip} data-elapsed={phase === "listening" ? seconds : undefined}
    onPointerDown={(e) => {
      e.preventDefault();
      if (!talking || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      holdStart("pointer");
    }}
    onPointerUp={() => { if (holding.current === "pointer") holdEnd(); }}
    onPointerCancel={() => { if (holding.current === "pointer") cancel(); }}
    onClick={click}>
    {phase === "transcribing" ? <Icon id="spin" cls="spin" />
      : <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg>}
    <span className="vh" role="status">{status}</span>
  </button>;
}

/** Talk mode's speaker, beside the microphone: replies are read aloud while it is on, and turning it off stops the voice now. */
export function Speaker() {
  const { speak } = useTalk();
  const voice = useLocalVoice();
  const on = speak && voice !== null;
  return <button type="button" className={`ctl sq speak${on ? " on" : ""}`} data-testid="chat.composer.speak" aria-label="Read replies aloud" aria-pressed={on} aria-disabled={voice === null}
    data-tip={voice === null ? "Read aloud: this device has no voice" : on ? "Read aloud: on" : "Read aloud: off"}
    onPointerDown={(e) => e.preventDefault()} onClick={() => { if (voice !== null) setTalk({ speak: !speak }); }}>
    <Icon id={on ? "vol" : "vol-off"} />
  </button>;
}

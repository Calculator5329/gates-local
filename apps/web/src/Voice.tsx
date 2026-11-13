import { type RefObject, useEffect, useRef, useState } from "react";
import { call, openSettings } from "./session.ts";
import { NA, getState, overChat, setState, useStore } from "./store.ts";
import { getDraft, useDraft } from "./drafts.ts";
import type { captureAudio } from "./voice-audio.ts";
import { insertAtCursor } from "./draft-insertion.ts";
import { Icon } from "./icons.tsx";

type Phase = "idle" | "asking" | "listening" | "transcribing";
type Dictation = { id: string; draftVersion: number };
/**
 * Dictate. `held` is set while Stop holds this square (a queued message edited during a reply): the button is gone,
 * the component stays, and the shortcut says why it does not start.
 */
export function Voice({ textarea, held = null }: { textarea: RefObject<HTMLTextAreaElement | null>; held?: string | null }) {
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
  const valid = (current: Dictation) => dictation.current === current && getDraft().version === current.draftVersion;
  const unsupported = !window.isSecureContext ? "Microphone needs HTTPS on a phone or the desktop app." : !navigator.mediaDevices?.getUserMedia || !window.AudioContext ? "This browser cannot record microphone audio. Use the desktop app." : null;
  const state = (p: Phase) => { phaseRef.current = p; show(p); };
  const cancel = () => {
    const current = dictation.current;
    dictation.current = null;
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

  const toggle = async () => {
    if (phaseRef.current === "asking" || phaseRef.current === "transcribing") return;
    if (unsupported) { setState({ notice: unsupported }); return; }
    if (!enabled) { openSettings("general"); return; }
    if (phaseRef.current === "listening") {
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
      } catch (e) {
        if (valid(current)) setState({ notice: e instanceof Error ? e.message : "Transcription failed. Try again." });
      } finally {
        if (dictation.current === current) { dictation.current = null; state("idle"); }
      }
      return;
    }
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
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phaseRef.current !== "idle") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
      // under Settings or a pop-up the chat is kept but hidden: dictation would type into a draft nobody sees
      else if (e.code === "Space" && e.ctrlKey && e.shiftKey && !e.repeat && !overChat(getState().view) && getState().panel === null) {
        e.preventDefault();
        if (held === null) void toggle();
        else setState({ notice: held });
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  // Only the microphone shows; the state is its colour (amber asking, green
  // listening) or a spinner, and the words live in the tooltip, the label and
  // a hidden status line. Seconds stay out of data-tip: a changing tip closes.
  const status = phase === "listening" ? "Listening" : phase === "transcribing" ? "Transcribing" : phase === "asking" ? "Waiting for microphone permission" : "";
  const tip = phase === "listening" ? "Listening. Click or Ctrl+Shift+Space to stop and transcribe. Esc cancels."
    : phase === "transcribing" ? "Transcribing… Esc cancels."
    : phase === "asking" ? "Allow microphone access to dictate. Esc cancels."
    : unsupported ?? (!enabled ? "Dictate: connect whisper.cpp in Settings › General" : "Dictate (Ctrl+Shift+Space). Click again to stop. Esc cancels.");
  const name = phase === "listening" ? "Stop dictation" : phase === "transcribing" ? "Dictate, transcribing" : phase === "asking" ? "Dictate, waiting for microphone permission" : "Dictate";
  const click = (e?: { detail?: number }) => {
    // detail 0 (or none) is a keyboard press, never the tail of a double-click
    const detail = e?.detail ?? 0;
    if (detail > 1 || (detail === 1 && performance.now() - shownAt.current < 400)) return;
    void toggle();
  };
  if (held !== null) return null;
  return <button type="button" className={`ctl sq voice ${phase}`} aria-label={name} aria-pressed={phase === "listening"} aria-busy={phase === "transcribing" || phase === "asking"} aria-disabled={unsupported !== null || phase === "transcribing" || phase === "asking"} data-tip={tip} data-elapsed={phase === "listening" ? seconds : undefined} onPointerDown={(e) => e.preventDefault()} onClick={click}>
    {phase === "transcribing" ? <Icon id="spin" cls="spin" />
      : <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg>}
    <span className="vh" role="status">{status}</span>
  </button>;
}

import { type RefObject, useEffect, useRef, useState } from "react";
import { call, openSettings } from "./session.ts";
import { NA, setState, useStore } from "./store.ts";
import { getDraft, useDraft } from "./drafts.ts";
import type { captureAudio } from "./voice-audio.ts";
import { insertAtCursor } from "./draft-insertion.ts";

type Phase = "idle" | "asking" | "listening" | "transcribing";
type Dictation = { id: string; draftVersion: number };
export function Voice({ textarea }: { textarea: RefObject<HTMLTextAreaElement | null> }) {
  const settings = useStore((s) => s.settings);
  const conn = useStore((s) => s.conn);
  const draftVersion = useDraft(d => d.version);
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
      else if (e.code === "Space" && e.ctrlKey && e.shiftKey && !e.repeat) { e.preventDefault(); void toggle(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const label = phase === "listening" ? `Listening ${seconds}s` : phase === "transcribing" ? "Transcribing…" : phase === "asking" ? "Allow mic…" : "Dictate";
  const tip = unsupported ?? (!enabled ? "Connect whisper.cpp in Settings › General" : "Dictate (Ctrl+Shift+Space). Click again to stop. Esc cancels.");
  return <button type="button" className={`ctl voice ${phase}`} aria-label={phase === "listening" ? "Stop dictation" : "Dictate"} aria-pressed={phase === "listening"} aria-busy={phase === "transcribing" || phase === "asking"} aria-disabled={unsupported !== null || phase === "transcribing" || phase === "asking"} title={tip} onPointerDown={(e) => e.preventDefault()} onClick={() => void toggle()}>
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg>
    <span role="status">{label}</span>
  </button>;
}

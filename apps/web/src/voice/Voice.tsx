import { type RefObject, useEffect, useRef, useState } from "react";
import { call, openSettings } from "../lib/session/index.ts";
import { NA, getState, overChat, setState, useStore } from "../lib/store/store.ts";
import { getDraft, useDraft } from "../lib/store/drafts.ts";
import type { captureAudio } from "./voice-audio.ts";
import { insertAtCursor } from "../composer/draft-insertion.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { hush, setTalk, useLocalVoice, useTalk } from "./talk.ts";

type Phase = "idle" | "asking" | "listening" | "transcribing";
type Dictation = { id: string; draftVersion: number };
// why: a press shorter than this is a tap, not a talk, and nothing is sent.
const HOLD_MS = 300;
const HOLD_NOTE = "Hold the microphone or Space while you talk.";
const DOUBLE_CLICK_MS = 400;
const chatOnTop = (s: { view: Parameters<typeof overChat>[0]; panel: unknown }) => !overChat(s.view) && s.panel === null;

// why: `held` is the notice the shortcut shows while Stop has this square and the button is gone.
export function Voice({ textarea, held = null, send }: { textarea: RefObject<HTMLTextAreaElement | null>; held?: string | null; send?: () => void }) {
  const settings = useStore((s) => s.settings);
  const conn = useStore((s) => s.conn);
  const draftVersion = useDraft(d => d.version);
  // why: a dictation into a hidden composer would type unseen and take Esc from the screen on top.
  const covered = useStore((s) => !chatOnTop(s));
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
  // oxlint-disable-next-line gates/effect-needs-reason -- a recording holds the microphone: page hide, a new draft or connection, and unmount all end it
  useEffect(() => {
    const leave = () => cancel();
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); cancel(); };
  }, [enabled, conn, draftVersion]);
  // oxlint-disable-next-line gates/effect-needs-reason -- the cover comes from screens this folder does not own; stopping releases the microphone, which a render must not do
  useEffect(() => { if (covered) cancel(); }, [covered]);
  // why: the square was Stop's a moment ago; the rest of a double-click on Stop must not land here.
  const shownAt = useRef(-Infinity);
  const wasHeld = useRef(held !== null);
  // oxlint-disable-next-line gates/effect-needs-reason -- Stop showing ends a recording (the microphone) and stamps when the square came back, both outside render
  useEffect(() => {
    if (held !== null) cancel();
    else if (wasHeld.current) shownAt.current = performance.now();
    wasHeld.current = held !== null;
  }, [held]);
  // oxlint-disable-next-line gates/effect-needs-reason -- the clock of a recording, running only while listening and cleared when it ends
  useEffect(() => {
    if (phase !== "listening") return;
    const started = performance.now();
    // oxlint-disable-next-line gates/timer-needs-reason -- counts the recording's seconds and stops it at the 60-second cap
    const timer = setInterval(() => {
      const elapsed = Math.floor((performance.now() - started) / 1000);
      time(elapsed);
      if (elapsed >= 60) { cancel(); setState({ notice: "The clip reached 60 seconds. Try a shorter recording." }); }
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

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
      setState({ notice: inserted ? null : `Transcript kept. Copy it into your draft: ${text}` });
      // oxlint-disable-next-line gates/timer-needs-reason -- one task later, so the composer has drawn the inserted words before Send reads the draft
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
      // why: permission is asked on this press while the capture chunk loads; a late stream is released.
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
      release();
      if (!valid(current)) return;
      dictation.current = null;
      capture.current = null;
      state("idle");
      const name = e instanceof DOMException ? e.name : "";
      setState({ notice: name === "NotAllowedError" ? "Microphone permission was denied. Allow microphone access for Gates Local, then retry." : name === "NotFoundError" ? "No microphone found. Connect one, then retry." : recorderFailed ?"Dictation could not load. Reload Gates Local, then retry." : "The microphone could not start. Check that it is connected and available, then retry." });
    }
  };
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
  const spaceTalks = () => {
    const at = document.activeElement;
    return getDraft().text === "" && (at === textarea.current || at === document.body) && chatOnTop(getState());
  };
  // oxlint-disable-next-line gates/effect-needs-reason -- window key listeners for hold-to-talk, put back after each render so they stay last in the capture order, as they always have
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const plain = !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      if (e.key === "Escape" && phaseRef.current !== "idle") { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
      // why: a held Space repeats, and none of the repeats types a space.
      else if (e.code === "Space" && holding.current === "space") e.preventDefault();
      else if (talking && held === null && e.code === "Space" && plain && !e.repeat && phaseRef.current === "idle" && spaceTalks()) { e.preventDefault(); holdStart("space"); }
      else if (e.code === "Space" && e.ctrlKey && e.shiftKey && !e.repeat && chatOnTop(getState())) {
        e.preventDefault();
        if (held === null) void toggle();
        else setState({ notice: held });
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === "Space" && holding.current === "space") { e.preventDefault(); holdEnd(); } };
    // external: a browser sends the key-up of a held key to whichever window has focus by then, so a hold the window lost is never let go here.
    const away = () => { if (holding.current !== null) cancel(); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", away);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", away); };
  });
  const status = phase === "listening" ? "Listening" : phase === "transcribing" ? "Transcribing" : phase === "asking" ? "Waiting for microphone permission" : "";
  // why: the seconds stay out of the tip, as a tip that changes closes.
  const tip =talking ? (phase === "listening" ? "Listening · Esc"
    : phase === "transcribing" ? "Transcribing · Esc"
    : phase === "asking" ? "Allow the microphone · Esc"
    : "Hold to talk · Space")
    : phase === "listening" ? "Stop dictation · Ctrl Shift Space"
    : phase === "transcribing" ? "Transcribing · Esc"
    : phase === "asking" ? "Allow the microphone · Esc"
    : unsupported !== null || !enabled ? "Dictate" : "Dictate · Ctrl Shift Space";
  const name = talking ? (phase === "listening" ? "Talk, listening" : phase === "transcribing" ? "Talk, transcribing" : phase === "asking" ? "Talk, waiting for microphone permission" : "Talk")
    : phase === "listening" ? "Stop dictation" : phase === "transcribing" ? "Dictate, transcribing" : phase === "asking" ? "Dictate, waiting for microphone permission" : "Dictate";
  const click = (e?: { detail?: number }) => {
    // external: a browser counts the clicks of a pointer in `detail` (2 for the second of a double-click) and gives a keyboard press 0.
    const detail = e?.detail ?? 0;
    // why: in talk mode a pointer press was the hold itself; a keyboard press starts and then sends.
    if (talking && detail > 0) return;
    if (detail > 1 || (detail === 1 && performance.now() - shownAt.current < DOUBLE_CLICK_MS)) return;
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

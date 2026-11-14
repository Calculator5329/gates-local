// Talk mode (chat row 38, owner pick A, a try-out): hold the microphone or Space to talk, let go
// to send, and the reply is read aloud; the speaker icon turns the reading off. Off until turned
// on in Settings, remembered on this device. The reading uses a voice the device itself has
// (speechSynthesis voices marked localService); a voice that would speak through a cloud service is
// never used, and no voice is bundled yet.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getState, runningTurn, subscribe, turnOf } from "./store.ts";

export type TalkPrefs = { readonly on: boolean; readonly speak: boolean };
const KEY = "gates-local.talk";
let prefs: TalkPrefs | null = null;
const listeners = new Set<() => void>();

function stored(): TalkPrefs {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof v === "object" && v !== null) return { on: "on" in v && v.on === true, speak: !("speak" in v) || v.speak !== false };
  } catch { /* storage blocked: the defaults */ }
  return { on: false, speak: true };
}

export function talkPrefs(): TalkPrefs { return prefs ??= stored(); }

export function setTalk(patch: Partial<TalkPrefs>): void {
  prefs = { ...talkPrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* the choice holds for this session */ }
  for (const l of listeners) l();
}

const onTalk = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useTalk(): TalkPrefs { return useSyncExternalStore(onTalk, talkPrefs, talkPrefs); }

const CODE = /```[\s\S]*?(?:```|$)/g;
/** Where a sentence ends: its mark and any closing quote or bracket, before a space; or a line end. */
const END = /[.!?…]["')\]]*(?=\s)|\n/g;

/** A line without its Markdown line marks: a rule or table border says nothing, table cells read as a list. */
function lineWords(line: string): string {
  if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|?)+\s*$/.test(line) || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return "";
  const t = line.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)+/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
  return t.includes("|") ? t.replace(/\s*\|\s*/g, ", ") : t;
}

/** Inline marks gone, a link read as its words, a bare address not read; empty when nothing is left to say. */
function plain(s: string): string {
  const t = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1").replace(/\*+|~~/g, "").replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

function pieces(raw: string): string[] {
  return raw.replace(CODE, "\n").split("\n").flatMap((l) => lineWords(l).split(/(?<=[.!?…]["')\]]*)\s+/)).map(plain).filter((s) => s !== "");
}

/** Markdown as the words a voice should say: no code, marks or addresses. */
export function speakable(raw: string): string { return pieces(raw).join(" "); }

/**
 * The finished sentences of `text` after `from`, as plain words, and where the next read starts.
 * While the reply streams an unfinished sentence waits, and an open code block holds the read at its start.
 */
export function sentencesFrom(text: string, from: number, done: boolean): { said: string[]; next: number } {
  let end = text.length;
  if (!done) {
    end = from;
    for (const m of text.slice(from).matchAll(END)) end = from + m.index + m[0].length;
    const fences = [...text.slice(from, end).matchAll(/```/g)];
    const open = fences.length % 2 === 1 ? fences.at(-1) : undefined;
    if (open !== undefined) end = from + open.index;
  }
  return { said: pieces(text.slice(from, end)), next: end };
}

/** A voice this device speaks with itself, in the page's language when it has one; never a cloud voice. */
export function localVoice(): SpeechSynthesisVoice | null {
  const voices = typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices().filter((v) => v.localService);
  const lang = (typeof navigator === "undefined" ? "en" : navigator.language).split("-")[0] ?? "en";
  const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  return mine.find((v) => v.default) ?? mine[0] ?? voices.find((v) => v.default) ?? voices[0] ?? null;
}

/** The device's local voice, followed as the browser loads its list. */
export function useLocalVoice(): SpeechSynthesisVoice | null {
  const [voice, setVoice] = useState(localVoice);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const changed = () => setVoice(localVoice());
    speechSynthesis.addEventListener("voiceschanged", changed);
    return () => speechSynthesis.removeEventListener("voiceschanged", changed);
  }, []);
  return voice;
}

/** Where the words go: the device's voice, or a recording in a test. */
export type Speaker = { say(words: string): void; cancel(): void };
const speaking = new Set<Speaker>();
let hushes = 0;
/** Talking over the reply: the reading stops now, and the rest of that reply is not read. */
export function hush(): void {
  hushes++;
  for (const s of speaking) s.cancel();
}

/**
 * Reads the replies in the chat on screen to `out`, a sentence at a time, until the returned stop.
 * Thinking is never read. Stop on a reply silences it, sentences already handed over included.
 * Opening another chat stops the reading; a reply already under way there,
 * or when reading starts, is read from its next sentence. A new chat's first reply is read whole.
 */
export function startReading(out: Speaker): () => void {
  let threadId = getState().threadId;
  let gen: number | null = null;
  let text = "";
  let said = 0;
  let quiet = hushes;
  const say = (parts: string[]) => {
    if (quiet === hushes) for (const words of parts) out.say(words);
  };
  /** Join a reply under way from its next sentence. */
  const join = (thread: string | null) => {
    const live = runningTurn(getState(), thread);
    gen = live?.gen ?? null; text = live?.text ?? ""; said = sentencesFrom(text, 0, false).next;
  };
  const finish = () => {
    // the saved reply can carry words the last stream event did not
    const saved = threadId === null ? undefined : getState().messages[threadId]?.findLast((m) => m.role === "assistant");
    const full = saved !== undefined && saved.content.startsWith(text) ? saved.content : text;
    say(sentencesFrom(full, said, true).said);
    gen = null;
  };
  const check = () => {
    const s = getState();
    if (s.threadId !== threadId) {
      const fresh = threadId === null;
      threadId = s.threadId;
      if (!fresh) { out.cancel(); join(threadId); }
    }
    const live = runningTurn(s, threadId);
    if (live === undefined) {
      if (gen === null) return;
      const ended = turnOf(s, threadId);
      // Stop (chat row 42): what waits in the voice is pulled back and nothing more of it is read
      if (ended?.gen === gen && ended.end?.kind === "stopped") { out.cancel(); gen = null; }
      // saved or failed: whatever was written is read to its end
      else finish();
      return;
    }
    if (live.gen !== gen) {
      if (gen !== null) finish();
      gen = live.gen; text = ""; said = 0; quiet = hushes;
    }
    text = live.text;
    const next = sentencesFrom(text, said, false);
    said = next.next;
    say(next.said);
  };
  join(threadId);
  speaking.add(out);
  const stop = subscribe(check);
  return () => { stop(); speaking.delete(out); out.cancel(); };
}

/** The device's own voice: one utterance per sentence, nothing when it has no local voice. */
function deviceVoice(synth: SpeechSynthesis): Speaker {
  return {
    say(words) {
      const voice = localVoice();
      if (voice === null) return;
      const u = new SpeechSynthesisUtterance(words);
      u.voice = voice; u.lang = voice.lang;
      synth.speak(u);
    },
    cancel() { synth.cancel(); },
  };
}

/** Reads replies aloud while talk mode and its speaker are on. */
export function useReadAloud(): void {
  const { on, speak } = useTalk();
  useEffect(() => (on && speak && typeof speechSynthesis !== "undefined" ? startReading(deviceVoice(speechSynthesis)) : undefined), [on, speak]);
}

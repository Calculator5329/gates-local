import { useEffect, useState, useSyncExternalStore } from "react";
import { getState, runningTurn, subscribe, turnOf } from "../lib/store/store.ts";

export type TalkPrefs = { readonly on: boolean; readonly speak: boolean };
const KEY = "gates-local.talk";
// why: talk mode is a try-out, off until it is turned on in Settings.
const DEFAULTS: TalkPrefs = { on: false, speak: true };
let prefs: TalkPrefs | null = null;
const listeners = new Set<() => void>();

function stored(): TalkPrefs {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof v === "object" && v !== null) return { on: "on" in v && v.on === true, speak: !("speak" in v) || v.speak !== false };
    return DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function save(chosen: TalkPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(chosen));
  } catch {
    // why: with storage blocked the choice still holds for this session.
    return;
  }
}

export function talkPrefs(): TalkPrefs { return prefs ??= stored(); }

export function setTalk(patch: Partial<TalkPrefs>): void {
  prefs = { ...talkPrefs(), ...patch };
  save(prefs);
  for (const l of listeners) l();
}

const onTalk = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useTalk(): TalkPrefs { return useSyncExternalStore(onTalk, talkPrefs, talkPrefs); }

// why: a block still open while the reply streams runs to the end of the text.
const CODE_BLOCK = /```[\s\S]*?(?:```|$)/g;
const SENTENCE_END = /[.!?…]["')\]]*(?=\s)|\n/g;
const TABLE_BORDER = /^\s*\|?(?:\s*:?-{3,}:?\s*\|?)+\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING_OR_QUOTE_MARKS = /^\s{0,3}(?:#{1,6}\s+|>\s?)+/;
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/;

function lineWords(line: string): string {
  if (TABLE_BORDER.test(line) || RULE.test(line)) return "";
  const t = line.replace(HEADING_OR_QUOTE_MARKS, "").replace(LIST_MARK, "");
  return t.includes("|") ? t.replace(/\s*\|\s*/g, ", ") : t;
}

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_ADDRESS = /https?:\/\/\S+/g;

function plain(s: string): string {
  const t = s.replace(IMAGE, " ").replace(LINK, "$1").replace(BARE_ADDRESS, " ")
    .replace(/`([^`]*)`/g, "$1").replace(/\*+|~~/g, "").replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

function pieces(raw: string): string[] {
  return raw.replace(CODE_BLOCK, "\n").split("\n").flatMap((l) => lineWords(l).split(/(?<=[.!?…]["')\]]*)\s+/)).map(plain).filter((s) => s !== "");
}

export function speakable(markdown: string): string { return pieces(markdown).join(" "); }

export function sentencesFrom(text: string, from: number, done: boolean): { said: string[]; next: number } {
  let end = text.length;
  if (!done) {
    end = from;
    for (const m of text.slice(from).matchAll(SENTENCE_END)) end = from + m.index + m[0].length;
    const fences = [...text.slice(from, end).matchAll(/```/g)];
    const openCodeBlock = fences.length % 2 === 1 ? fences.at(-1) : undefined;
    if (openCodeBlock !== undefined) end = from + openCodeBlock.index;
  }
  return { said: pieces(text.slice(from, end)), next: end };
}

export function localVoice(): SpeechSynthesisVoice | null {
  const voices = typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices().filter((v) => v.localService);
  const lang = (typeof navigator === "undefined" ? "en" : navigator.language).split("-")[0] ?? "en";
  const mine = voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
  return mine.find((v) => v.default) ?? mine[0] ?? voices.find((v) => v.default) ?? voices[0] ?? null;
}

export function useLocalVoice(): SpeechSynthesisVoice | null {
  const [voice, setVoice] = useState(localVoice);
  // oxlint-disable-next-line gates/effect-needs-reason -- the browser's voices change event, followed while mounted
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const changed = () => setVoice(localVoice());
    speechSynthesis.addEventListener("voiceschanged", changed);
    return () => speechSynthesis.removeEventListener("voiceschanged", changed);
  }, []);
  return voice;
}

export type Speaker = { say(words: string): void; cancel(): void };
const speaking = new Set<Speaker>();
let hushes = 0;
// why: talking over a reply stops the reading now, and the rest of that reply is not read.
export function hush(): void {
  hushes++;
  for (const s of speaking) s.cancel();
}

export function startReading(out: Speaker): () => void {
  let threadId = getState().threadId;
  let gen: number | null = null;
  let text = "";
  let said = 0;
  let quiet = hushes;
  const say = (parts: string[]) => {
    if (quiet === hushes) for (const words of parts) out.say(words);
  };
  // why: a reply already under way is read from its next sentence, not from its start.
  const join = (thread: string | null) => {
    const live = runningTurn(getState(), thread);
    gen = live?.gen ?? null; text = live?.text ?? ""; said = sentencesFrom(text, 0, false).next;
  };
  const finish = () => {
    const saved = threadId === null ? undefined : getState().messages[threadId]?.findLast((m) => m.role === "assistant");
    // why: the saved reply can carry words the last stream event did not.
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
      // why: on Stop, what waits in the voice is pulled back and nothing more of the reply is read.
      if (ended?.gen === gen && ended.end?.kind === "stopped") { out.cancel(); gen = null; }
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

export function useReadAloud(): void {
  const { on, speak } = useTalk();
  // oxlint-disable-next-line gates/effect-needs-reason -- the reader subscribes to replies and the device's speech for as long as talk mode and the speaker are on
  useEffect(() => (on && speak && typeof speechSynthesis !== "undefined" ? startReading(deviceVoice(speechSynthesis)) : undefined), [on, speak]);
}

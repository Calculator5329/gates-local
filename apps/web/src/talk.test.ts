// Talk mode (chat row 38, owner pick A, a try-out): the reply is read aloud a whole sentence
// at a time while it streams, as plain words. Code, links' addresses and Markdown marks are
// never spoken, and a sentence is not read until it is finished.
import { afterEach, expect, it, vi } from "vitest";
import type { LiveTurn } from "./store.ts";
import { setState } from "./store.ts";
import { hush, localVoice, sentencesFrom, setTalk, speakable, startReading, talkPrefs } from "./talk.ts";

afterEach(() => { vi.unstubAllGlobals(); setState({ turns: {}, messages: {}, threadId: null }); });

/** A reply being written in `threadId`, with its words so far and its private thinking. */
const live = (threadId: string, gen: number, text: string): LiveTurn =>
  ({ gen, threadId, turnId: `turn-${gen}`, model: "m", startedAt: 1, thinking: "Private reasoning. Never read.", text, tools: [], pendingUser: null }) as LiveTurn;
/** What the device was asked to say, and how often it was told to stop. */
function speaker() {
  const heard: string[] = [];
  const out = { heard, cancels: 0, say: (words: string) => { heard.push(words); }, cancel: () => { out.cancels++; } };
  return out;
}

it("reads finished sentences while the reply streams, and the rest when it is done", () => {
  const text = "Tennessine was found in 2010 by a team in Dubna. It weighs 2.5 times";
  const first = sentencesFrom(text, 0, false);
  expect(first.said).toEqual(["Tennessine was found in 2010 by a team in Dubna."]);
  expect(sentencesFrom(text, first.next, false), "an unfinished sentence waits").toEqual({ said: [], next: first.next });
  expect(sentencesFrom(`${text} more than lead.`, first.next, true).said).toEqual(["It weighs 2.5 times more than lead."]);
});

it("never reads code, and waits at an open code block", () => {
  const streaming = "Run this:\n\n```ts\nconst a = 1;";
  const open = sentencesFrom(streaming, 0, false);
  expect(open.said).toEqual(["Run this:"]);
  expect(streaming.slice(open.next).startsWith("```"), "the next read starts at the block").toBe(true);
  expect(sentencesFrom(`${streaming}\n${"```"}\n\nThat prints one.`, open.next, true).said).toEqual(["That prints one."]);
});

it("reads Markdown as plain words: no marks, link text without its address, list items one by one", () => {
  const text = "## Answer\n**Bold** and [a link](https://example.com/x) with `code`.\n- First item\n- Second item\n1. Third\n> Quoted\n| a | b |\n| --- | --- |\n";
  expect(sentencesFrom(text, 0, true).said).toEqual(["Answer", "Bold and a link with code.", "First item", "Second item", "Third", "Quoted", "a, b"]);
  expect(speakable("See https://example.com/page for more"), "a bare address is not read out").toBe("See for more");
  expect(speakable("---"), "a rule says nothing").toBe("");
});

it("reads a streaming reply a sentence at a time and its last words when it is saved, never its thinking", () => {
  const out = speaker();
  setState({ threadId: "t", turns: {}, messages: {} });
  const stop = startReading(out);
  setState({ turns: { t: live("t", 1, "Tennessine was found in 2010. It is") } });
  expect(out.heard).toEqual(["Tennessine was found in 2010."]);
  setState({ turns: { t: live("t", 1, "Tennessine was found in 2010. It is element 117") } });
  expect(out.heard, "the unfinished sentence waits").toHaveLength(1);
  setState({ turns: {}, messages: { t: [{ id: "a", threadId: "t", role: "assistant", createdAt: 1, content: "Tennessine was found in 2010. It is element 117, a halogen." }] } });
  expect(out.heard).toEqual(["Tennessine was found in 2010.", "It is element 117, a halogen."]);
  stop();
  expect(out.cancels, "turning reading off stops the voice").toBe(1);
});

it("stops the rest of a reply when the person talks over it, and reads the next reply", () => {
  const out = speaker();
  setState({ threadId: "t", turns: {}, messages: {} });
  const stop = startReading(out);
  setState({ turns: { t: live("t", 1, "One. ") } });
  hush();
  setState({ turns: { t: live("t", 1, "One. Two. Three. ") } });
  setState({ turns: {} });
  setState({ turns: { t: live("t", 2, "The next answer. ") } });
  expect(out.heard).toEqual(["One.", "The next answer."]);
  stop();
});

// Chat row 42 (coordinator default, named to the owner): Stop on a reply also stops its reading,
// including the sentences already handed to the voice.
it("Stop on a reply silences it: the sentences waiting in the voice are pulled back and the rest is never read", () => {
  const waiting: string[] = [];
  const out = { say: (words: string) => { waiting.push(words); }, cancel: () => { waiting.length = 0; } };
  setState({ threadId: "t", turns: {}, messages: {} });
  const stop = startReading(out);
  setState({ turns: { t: live("t", 1, "One. Two. Thr") } });
  expect(waiting, "two sentences wait in the voice").toEqual(["One.", "Two."]);
  setState({ turns: { t: { ...live("t", 1, "One. Two. Three is unfinished"), end: { kind: "stopped", secs: 1 } } } });
  expect(waiting, "none left speaking after Stop").toEqual([]);
  setState({ turns: {}, messages: { t: [{ id: "a", threadId: "t", role: "assistant", createdAt: 1, content: "One. Two. Three is unfinished", interrupted: true }] } });
  expect(waiting, "the saved stopped reply is not read either").toEqual([]);
  setState({ turns: { t: live("t", 2, "The next answer. ") } });
  expect(waiting, "the next reply is read").toEqual(["The next answer."]);
  stop();
});

it("stops reading when another chat opens and joins its reply at the next sentence; a new chat's first reply is read whole", () => {
  const out = speaker();
  setState({ threadId: "a", turns: { a: live("a", 1, "In chat a. "), b: live("b", 2, "Already said in b. ") }, messages: {} });
  const stop = startReading(out);
  expect(out.heard, "a reply under way when reading starts is joined, not read from its start").toEqual([]);
  setState({ threadId: "b" });
  expect(out.cancels, "the other chat's voice stops").toBe(1);
  setState((s) => ({ turns: { ...s.turns, b: live("b", 2, "Already said in b. New in b. ") } }));
  expect(out.heard).toEqual(["New in b."]);
  setState({ threadId: null, turns: {} });
  setState({ threadId: "c", turns: { c: live("c", 3, "First words of a new chat. ") } });
  expect(out.heard).toEqual(["New in b.", "First words of a new chat."]);
  stop();
});

it("keeps talk mode off until it is turned on, remembers it, and works where storage throws", () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } });
  expect(talkPrefs()).toEqual({ on: false, speak: true });
  setTalk({ on: true });
  setTalk({ speak: false });
  expect(talkPrefs()).toEqual({ on: true, speak: false });
  expect(JSON.parse(saved.get("gates-local.talk") ?? "null")).toEqual({ on: true, speak: false });
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  setTalk({ speak: true });
  expect(talkPrefs(), "the choice holds for this session").toEqual({ on: true, speak: true });
});

/** A voice the browser lists: spoken by the device itself (`localService`) or through an online service. */
const voice = (name: string, lang: string, localService: boolean, isDefault = false) => ({ name, lang, localService, default: isDefault });

it("reads only with a voice the device speaks itself, never one that goes through an online service", () => {
  const voices = (...list: ReturnType<typeof voice>[]) => vi.stubGlobal("speechSynthesis", { getVoices: () => list });
  vi.stubGlobal("navigator", { language: "en-US" });
  voices(voice("Online English", "en-US", false, true), voice("Local French", "fr-FR", true), voice("Local English", "en-GB", true));
  expect(localVoice()?.name, "the page's language, from the device's own voices").toBe("Local English");
  voices(voice("Online English", "en-US", false, true), voice("Local French", "fr-FR", true));
  expect(localVoice()?.name, "another language before any online voice").toBe("Local French");
  voices(voice("Online English", "en-US", false, true));
  expect(localVoice(), "no voice at all when every voice is online").toBeNull();
});

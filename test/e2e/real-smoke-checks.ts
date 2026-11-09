// Shared by the real journey and local, network-free failure probes.
import { doesNotMatch, match } from "node:assert/strict";
import { randomInt } from "node:crypto";

export const REAL_SMOKE_URL = "http://127.0.0.1:16195";

/** Refuse before any request; only the wrapper's dedicated endpoint is allowed. */
export function requireRealSmokeUrl(value: string | undefined): string {
  if (value !== REAL_SMOKE_URL) throw new Error(`Real smoke refuses this endpoint; only ${REAL_SMOKE_URL}, started by real-smoke-run.ts, is allowed.`);
  return value;
}

/** Six random syllables make a copyable word with 80^6 possible spellings. */
export function randomContextWord(): string {
  const consonants = "bdfghjklmnprstvz";
  const vowels = "aeiou";
  return Array.from({ length: 6 }, () => consonants[randomInt(consonants.length)]! + vowels[randomInt(vowels.length)]!).join("");
}

export function assertInterruptedCancellation(message: string): void {
  doesNotMatch(message, /as the reply finished/, "Stop must interrupt generation, not wait for its natural end");
}

/** An echo of the earlier prompt counts: it still proves history reached the model. */
export function assertContextCopied(answer: string, word: string): void {
  match(answer, new RegExp(`\\b${word}\\b`, "i"), "real model must copy the random word from the earlier user message");
}

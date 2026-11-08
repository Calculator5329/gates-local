// The client half of the chat-pick rule. The rule itself runs on the server
// (apps/server/src/runtime/pick.ts) and its answer rides on models.list as
// ModelInfo.pick, so the first run and the composer start on the same model
// in the same render as the runtime dot. This file only reads it.
import type { ModelInfo } from "@gates-local/contracts";
import { k } from "./format.ts";

type Caps = Pick<ModelInfo, "capabilities">;

/** Ollama lists "completion" for every model that can chat; embedding models lack it. */
export const canChat = (m: Caps): boolean => m.capabilities.includes("completion");
export const canThink = (m: Caps): boolean => m.capabilities.includes("thinking");
export const canSeeImages = (m: Caps): boolean => m.capabilities.includes("vision");

export const chatModels = (models: readonly ModelInfo[]): ModelInfo[] => models.filter(canChat);

/** The model the server picked, if any model can chat. */
export const pickedModel = (models: readonly ModelInfo[] | undefined): ModelInfo | undefined => models?.find((m) => m.pick !== undefined && canChat(m));

/** What to do with the composer's model: keep it, switch to another, or clear it (nothing can chat). */
export type ModelDecision = { kind: "keep" } | { kind: "set"; model: string } | { kind: "clear" };

/** A model that may be the selection: it can chat, or it is installed and not described yet. */
export const choosable = (m: Caps): boolean => canChat(m) || m.capabilities.includes("unknown");

const keep: ModelDecision = { kind: "keep" };
const canChatAs = (models: readonly ModelInfo[], name: string | undefined) => name !== undefined && models.some((m) => m.name === name && canChat(m));

/**
 * `chosen` is the model the user picked, kept apart from `current` so a list
 * that briefly lacks it (the runtime restarting) does not erase it (MP2-03).
 * While it is installed and can chat, or is installed and not described yet,
 * it is the selection; sendableModel still holds sends until it can chat.
 * Otherwise the selection is the app's: the server's pick, which it follows as
 * the pick changes (an incomplete survey recovering, a new default: MP-02,
 * MP-05), else a current model that can chat, else the first chat model; it is
 * cleared when no model can chat, so an embedding model never stays selected.
 * A list not fetched yet keeps it.
 */
export function modelChoice(models: readonly ModelInfo[] | undefined, current: string | undefined, chosen: string | undefined): ModelDecision {
  if (models === undefined) return keep;
  const mine = models.find((m) => m.name === chosen);
  const appChoice = pickedModel(models)?.name ?? (canChatAs(models, current) ? current : chatModels(models)[0]?.name);
  const next = mine !== undefined && choosable(mine) ? mine.name : appChoice;
  if (next === undefined) return { kind: "clear" };
  return next === current ? keep : { kind: "set", model: next };
}

/**
 * Order for model-list answers: a ticket per models.refresh call or
 * models.changed push. An answer applies only while its ticket is the newest,
 * so an older call that lands late never overwrites a newer list (MP2-02).
 */
export function newestOnly(): { next(): number; current(ticket: number): boolean } {
  let issued = 0;
  return { next: () => ++issued, current: (ticket) => ticket === issued };
}

/** The model a message would go to: the current one only if it can chat. */
export const sendableModel = (models: readonly ModelInfo[] | undefined, current: string | undefined): string | undefined =>
  models !== undefined && canChatAs(models, current) ? current : undefined;

const unreported = (m: Caps): boolean => m.capabilities.includes("unreported");

/**
 * Why sends are held when a download would not help, in one line; undefined
 * otherwise. An Ollama that does not report capabilities (server
 * UNREPORTED_CAPABILITIES: /api/show without the field) leaves every model
 * unknown, and another download would be unknown too. The missing field is
 * all that is known, not the version's age, so the line claims nothing about
 * the version.
 */
export function chatBlockedReason(models: readonly ModelInfo[] | undefined, current: string | undefined): string | undefined {
  if (models === undefined || sendableModel(models, current) !== undefined) return undefined;
  if (!models.some(canChat) && models.some(unreported)) return "This Ollama doesn't say which models can chat. Updating Ollama fixes this.";
  if (models.some((m) => m.name === current && m.capabilities.includes("unknown"))) return "Checking what this model can do; you can send once Ollama answers.";
  return undefined;
}

/** The download that will become the first chat model, while no installed model can chat. */
export function firstChatPull(models: readonly ModelInfo[] | undefined, pulls: Readonly<Record<string, { name: string; state: string }>>): string | undefined {
  if ((models ?? []).some(canChat)) return undefined;
  return Object.values(pulls).find((p) => p.state === "downloading" || p.state === "queued" || p.state === "verifying")?.name;
}

/** Why an installed model is not a chat choice, for its Settings row: an embedding model, or one Ollama has not described yet. */
export const notForChat = (m: Caps | undefined): { label: string; tip: string } =>
  m !== undefined && unreported(m)
    ? { label: "Ollama doesn't say", tip: "This Ollama doesn't say what a model can do, so Gates Local cannot tell a chat model from an embedding model. Updating Ollama fixes this." }
    : m?.capabilities.includes("unknown")
      ? { label: "Checking what this model can do", tip: "Ollama has not said what this model can do yet; Gates Local asks again and offers it for chat once it knows." }
      : { label: "Embedding model, not for chat", tip: "Turns text into vectors for search; it cannot answer a chat." };

/** The rule in words, for the Recommended tooltip. It says what pick.ts does. */
export function pickRuleText(numCtx: number, cpu = false): string {
  return `Your default model if it runs at ${k(numCtx)} of context. Otherwise the first model that ${cpu ? "fits in system memory" : "fits your GPU"} at ${k(numCtx)}, checking Gates Local's recommended models in order, then your others from largest; if none fits, the first that runs partly in system memory. Embedding models are left out.`;
}

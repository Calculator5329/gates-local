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

const keep: ModelDecision = { kind: "keep" };
const canChatAs = (models: readonly ModelInfo[], name: string | undefined) => name !== undefined && models.some((m) => m.name === name && canChat(m));

/**
 * Keep a current model that can chat. Otherwise switch to the server's pick
 * (or the first chat model), and clear the selection when no model can chat,
 * so an embedding model never stays selected. A list not fetched yet keeps it.
 */
export function modelChoice(models: readonly ModelInfo[] | undefined, current: string | undefined): ModelDecision {
  if (models === undefined || canChatAs(models, current)) return keep;
  const next = (pickedModel(models) ?? chatModels(models)[0])?.name;
  return next === undefined ? { kind: "clear" } : { kind: "set", model: next };
}

/** A new chat starts on the server's current pick (the default may have changed); without one, as modelChoice. */
export function newChatChoice(models: readonly ModelInfo[] | undefined, current: string | undefined): ModelDecision {
  const picked = pickedModel(models)?.name;
  return picked === undefined || picked === current ? modelChoice(models, current) : { kind: "set", model: picked };
}

/** The model a message would go to: the current one only if it can chat. */
export const sendableModel = (models: readonly ModelInfo[] | undefined, current: string | undefined): string | undefined =>
  models !== undefined && canChatAs(models, current) ? current : undefined;

/** The download that will become the first chat model, while no installed model can chat. */
export function firstChatPull(models: readonly ModelInfo[] | undefined, pulls: Readonly<Record<string, { name: string; state: string }>>): string | undefined {
  if ((models ?? []).some(canChat)) return undefined;
  return Object.values(pulls).find((p) => p.state === "downloading" || p.state === "queued" || p.state === "verifying")?.name;
}

/** Why an installed model is not a chat choice, for its Settings row: an embedding model, or one Ollama has not described yet. */
export const notForChat = (m: Caps | undefined): { label: string; tip: string } =>
  m?.capabilities.includes("unknown")
    ? { label: "Checking what this model can do", tip: "Ollama has not said what this model can do yet; Gates Local asks again and offers it for chat once it knows." }
    : { label: "Embedding model, not for chat", tip: "Turns text into vectors for search; it cannot answer a chat." };

/** The rule in words, for the Recommended tooltip. It says what pick.ts does. */
export function pickRuleText(numCtx: number): string {
  return `Your default model if it runs at ${k(numCtx)} of context. Otherwise the first model that fits your GPU at ${k(numCtx)}, checking Gates Local's recommended models in order, then your others from largest; if none fits, the first that runs partly in system memory. Embedding models are left out.`;
}

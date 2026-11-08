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

/** The model to switch to, or undefined when the current one stays (or no model can chat). */
export function modelChoice(models: readonly ModelInfo[] | undefined, current: string | undefined): string | undefined {
  const list = models ?? [];
  if (current !== undefined && list.some((m) => m.name === current && canChat(m))) return undefined;
  return (pickedModel(list) ?? chatModels(list)[0])?.name;
}

/** The rule in words, for the Recommended tooltip. It says what pick.ts does. */
export function pickRuleText(numCtx: number): string {
  return `Your default model if it runs at ${k(numCtx)} of context. Otherwise the first model that fits your GPU at ${k(numCtx)}, checking Gates Local's recommended models in order, then your others from largest; if none fits, the first that runs partly in system memory. Embedding models are left out.`;
}

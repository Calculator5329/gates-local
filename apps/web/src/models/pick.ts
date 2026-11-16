import type { ModelInfo } from "@gates-local/contracts";

type Caps = Pick<ModelInfo, "capabilities">;

// external: Ollama's /api/show lists completion for chat models, not for embedding models
export const canChat = (m: Caps): boolean => m.capabilities.includes("completion");
export const canThink = (m: Caps): boolean => m.capabilities.includes("thinking");
export const canSeeImages = (m: Caps): boolean => m.capabilities.includes("vision");

export const chatModels = (models: readonly ModelInfo[]): ModelInfo[] => models.filter(canChat);

export const pickedModel = (models: readonly ModelInfo[] | undefined): ModelInfo | undefined => models?.find((m) => m.pick !== undefined && canChat(m));

export type ModelDecision = { kind: "keep" } | { kind: "set"; model: string } | { kind: "clear" };

export const choosable = (m: Caps): boolean => canChat(m) || m.capabilities.includes("unknown");

const keep: ModelDecision = { kind: "keep" };
const canChatAs = (models: readonly ModelInfo[], name: string | undefined) => name !== undefined && models.some((m) => m.name === name && canChat(m));

export function modelChoice(models: readonly ModelInfo[] | undefined, current: string | undefined, chosen: string | undefined): ModelDecision {
  if (models === undefined) return keep;
  const mine = models.find((m) => m.name === chosen);
  const appChoice = pickedModel(models)?.name ?? (canChatAs(models, current) ? current : chatModels(models)[0]?.name);
  const next = mine !== undefined && choosable(mine) ? mine.name : appChoice;
  if (next === undefined) return { kind: "clear" };
  return next === current ? keep : { kind: "set", model: next };
}

export const sendableModel = (models: readonly ModelInfo[] | undefined, current: string | undefined): string | undefined =>
  models !== undefined && canChatAs(models, current) ? current : undefined;

const unreported = (m: Caps): boolean => m.capabilities.includes("unreported");

// external: an older Ollama answers /api/show without capabilities
export function chatBlockedReason(models: readonly ModelInfo[] | undefined, current: string | undefined): string | undefined {
  if (models === undefined || sendableModel(models, current) !== undefined) return undefined;
  if (!models.some(canChat) && models.some(unreported)) return "This Ollama doesn't say which models can chat. Updating Ollama fixes this.";
  if (models.some((m) => m.name === current && m.capabilities.includes("unknown"))) return "Checking what this model can do; you can send once Ollama answers.";
  return undefined;
}

export const awaitingInstall = (p: { readonly state: string }): boolean => p.state === "queued" || p.state === "downloading" || p.state === "verifying" || p.state === "done";

export const modelNameKey = (name: string): string => name.replace(/:latest$/, "");

export const pendingDownload = (p: { readonly name: string; readonly state: string }, models: readonly Pick<ModelInfo, "name">[] | undefined): boolean =>
  awaitingInstall(p) && !(models ?? []).some(m => m.name === p.name || (p.state === "done" && modelNameKey(m.name) === modelNameKey(p.name)));

export function firstChatPull(models: readonly ModelInfo[] | undefined, pulls: Readonly<Record<string, { name: string; state: string }>>): string | undefined {
  if ((models ?? []).some(canChat)) return undefined;
  return Object.values(pulls).find(awaitingInstall)?.name;
}

export const notForChat = (m: Caps | undefined): { label: string } =>
  m !== undefined && unreported(m)
    ? { label: "Ollama doesn't say" }
    : m?.capabilities.includes("unknown")
      ? { label: "Checking what this model can do" }
      : { label: "Embedding model, not for chat" };

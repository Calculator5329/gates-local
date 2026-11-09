import { MODEL_CONTROL_BOUNDS, type ModelControl, type ModelSettings, type Settings } from "@gates-local/contracts";
import { canonicalTag } from "../runtime/recommended.ts";

export type TurnSettings = ModelSettings;

/** Legacy files may predate the limits. Keep their prompts, clamp numeric values, omit non-finite inputs. */
export function boundedModelSettings(settings: ModelSettings): ModelSettings {
  const numeric: Partial<Record<ModelControl, number>> = {};
  for (const key of Object.keys(MODEL_CONTROL_BOUNDS) as ModelControl[]) {
    const value = settings[key];
    if (value === undefined || !Number.isFinite(value)) continue;
    if ((key === "num_predict" && (value === -2 || value === -1)) || (key === "keep_alive" && value === -1)) { numeric[key] = value; continue; }
    const bounds = MODEL_CONTROL_BOUNDS[key];
    const clamped = Math.max(bounds.min, Math.min(bounds.max, value));
    numeric[key] = bounds.integer ? Math.trunc(clamped) : clamped;
  }
  return { ...(settings.systemPrompt === undefined ? {} : { systemPrompt: settings.systemPrompt }), ...numeric };
}

/** Snapshot at chat.send, before admission waits. Missing values remain missing for Ollama to default. */
export function turnSettings(settings: Settings | undefined, model: string): TurnSettings {
  const local = settings?.modelSettings?.[canonicalTag(model)] ?? settings?.modelSettings?.[model];
  const systemPrompt = local?.systemPrompt ?? settings?.systemPrompt;
  return boundedModelSettings({ ...local, ...(systemPrompt === undefined ? {} : { systemPrompt }) });
}

/** Explicit allowlist: context and GPU placement always belong to the existing fit/load path. */
export function ollamaSettings(settings: TurnSettings | undefined, numCtx: number) {
  const { systemPrompt: _prompt, keep_alive, ...options } = boundedModelSettings(settings ?? {});
  return { options: { ...options, num_ctx: numCtx }, ...(keep_alive === undefined ? {} : { keep_alive }) };
}

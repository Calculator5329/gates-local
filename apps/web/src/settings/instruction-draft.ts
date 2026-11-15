import type { ModelControl, ModelSettings, ModelSettingsPatch } from "@gates-local/contracts";

export type ControlKey = ModelControl;
export type ControlDraft = Partial<Record<ControlKey, { value: string | null; original: number | null }>>;

export function controlValues(saved: ModelSettings, draft: ControlDraft): Record<ControlKey, string | null> {
  const value = (key: ControlKey) => draft[key] === undefined ? saved[key] === undefined ? null : String(saved[key]) : draft[key].value;
  return { temperature: value("temperature"), top_p: value("top_p"), top_k: value("top_k"), repeat_penalty: value("repeat_penalty"), seed: value("seed"), num_predict: value("num_predict"), keep_alive: value("keep_alive") };
}

export function editControl(saved: ModelSettings, draft: ControlDraft, key: ControlKey, value: string | null): ControlDraft {
  const previous = draft[key];
  const original = previous === undefined ? saved[key] ?? null : previous.original;
  const reverted = value === null ? original === null : value.trim() !== "" && Number(value) === original;
  if (reverted) {
    const { [key]: _reverted, ...rest } = draft;
    return rest;
  }
  return { ...draft, [key]: { value, original } };
}

export function controlPatch(draft: ControlDraft): ModelSettingsPatch {
  return Object.fromEntries(Object.entries(draft).map(([key, edit]) => [key, edit.value === null ? null : Number(edit.value)]));
}

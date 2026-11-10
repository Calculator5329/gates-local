// Prepare the first picker view without importing or mounting its presentation.
// Called only on intent to open (hover, focus, press), never at idle: a session
// that never opens the picker makes no checks for it.
import { CONTEXT_SIZES, ctxFor } from "./format.ts";
import { chatModels } from "./pick.ts";
import { activeEntry, pickerEntries } from "./picker-models.ts";
import { ensureFit } from "./session.ts";
import { fitsAboutToChange } from "./session/fit.ts";
import { NA, chatReady, getState } from "./store.ts";

/**
 * ensureFit owns freshness and in-flight dedupe; warming never authorizes a pick.
 * Nothing is warmed while a reply runs or a model loads: either one ends by
 * invalidating every report, so the opening would check them all again.
 */
export function warmPickerFits(): void {
  const s = getState();
  if (!chatReady(s) || !s.hydrationSettled || s.view !== "new" && s.view !== "thread") return;
  if (fitsAboutToChange(s)) return;
  const installed = chatModels(s.models ?? []);
  for (const model of installed) ensureFit(model.name, ctxFor(s.numCtx, installed, model.name));
  // The first view has no search, filter, highlight or pending choice.
  const active = activeEntry(pickerEntries(s.models, s.pulls, s.catalog === NA ? undefined : s.catalog, s.model), s.model);
  if (!active) return;
  const max = active.info?.maxContext;
  for (const size of CONTEXT_SIZES) if (max === undefined || size <= max) ensureFit(active.tag, size);
}

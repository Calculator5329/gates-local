// Which Ollama holds one model at a time (the app's own, RuntimeStatus.holdsOne), asked by its
// address. Every planner reads it here (planWith), so the fit table, a send's plan and a preload
// agree without each caller passing it. The runtime services register one answer per running app
// and take it back on close; a test passes FitDeps.holdsOne instead.

type Answer = (baseUrl: string) => boolean;
const answers = new Set<Answer>();

/** Register `answer` (true for the address of an Ollama that holds one model); returns its removal. */
export function answerHoldsOne(answer: Answer): () => void {
  answers.add(answer);
  return () => void answers.delete(answer);
}

/** The Ollama at `baseUrl` replaces the model it holds when another loads: no model runs beside another. */
export function holdsOneAt(baseUrl: string): boolean {
  for (const answer of answers) if (answer(baseUrl)) return true;
  return false;
}

type Answer = (baseUrl: string) => boolean;
// why: one answer per running app, true for the address of an Ollama that holds one model.
const answers = new Set<Answer>();

export function answerHoldsOne(answer: Answer): () => void {
  answers.add(answer);
  return () => void answers.delete(answer);
}

export function holdsOneAt(baseUrl: string): boolean {
  for (const answer of answers) if (answer(baseUrl)) return true;
  return false;
}

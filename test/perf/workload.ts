/** The archived fake repeats each prompt in eight reply blocks. Keep its cadence. */
export function parallelPrompt(label: string): string {
  return `${label} ${"keep these fixture words streaming ".repeat(16)}`.trim();
}

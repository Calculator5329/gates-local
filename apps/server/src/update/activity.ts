export const interruptedWork = (w: { imports: readonly string[]; turns: number; downloads: readonly string[]; imageJobs: number }): string[] => [
  ...w.imports,
  ...(w.turns === 0 ? [] : [`${w.turns} running ${w.turns === 1 ? "reply" : "replies"} (including other windows)`]),
  ...w.downloads.map((name) => `model download: ${name}`),
  ...(w.imageJobs > 0 ? [`${w.imageJobs} image generation jobs (queued or running)`] : []),
];

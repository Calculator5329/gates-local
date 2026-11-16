import { withTimeout } from "../lib/ui/kit/async.ts";

interface Reads {
  readonly readImports: () => Promise<unknown>;
  readonly readFolder: () => Promise<unknown>;
  readonly readSetup?: () => Promise<unknown>;
}

export function createSettingsReads({ readImports, readFolder, readSetup }: Reads) {
  let waiting: Promise<void> | null = null;
  let reading = false;
  let late = false;
  let finish: (() => void) | null = null;

  return {
    begin(): void {
      late = false;
      if (waiting !== null) return;
      waiting = new Promise<void>((resolve) => {
        finish = () => {
          waiting = null;
          finish = null;
          resolve();
        };
      });
    },
    async read(): Promise<void> {
      reading = true;
      try {
        await Promise.allSettled([
          readImports(),
          readFolder(),
          readSetup?.(),
        ]);
      } finally {
        reading = false;
        finish?.();
      }
    },
    end(): void {
      if (!reading) finish?.();
    },
    ready(ms = 1000): Promise<void> | null {
      if (waiting === null || late) return null;
      const current = waiting;
      return withTimeout(current, ms, () => { if (waiting === current) late = true; });
    },
  };
}

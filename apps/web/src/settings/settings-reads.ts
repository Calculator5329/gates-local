// Settings is whole on its first frame (docs/design.md): what it shows that is
// cheap to read is read before it can open. Each hydrate reads the sample
// database list and the data folder once its second batch (GPU, catalog,
// sources, image and update status) is in, and what Set up images would fetch;
// Settings waits for that, up to a bound, so a slow server shows placeholders
// instead of a dead key.

interface Reads {
  /** The samples and imports, put in the store by the read itself; their pushes keep them current. */
  readonly readImports: () => Promise<unknown>;
  /** The data folder, put in the store by the read itself. */
  readonly readFolder: () => Promise<unknown>;
  /** What Set up images would fetch, put in the store by the read itself: its row draws no guess first. */
  readonly readSetup?: () => Promise<unknown>;
}

export function createSettingsReads({ readImports, readFolder, readSetup }: Reads) {
  let waiting: Promise<void> | null = null;
  let reading = false;
  // A read outlived the bound: later opens show placeholders at once instead
  // of each waiting the bound again, until the next hydrate begins.
  let late = false;
  let finish: (() => void) | null = null;

  return {
    /** A hydrate began: Settings opens once its reads are in. */
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
    /** The second batch is in: read the rest, then let Settings open. */
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
    /** The hydrate ended without reaching its reads (a failure or a drop). */
    end(): void {
      if (!reading) finish?.();
    },
    /** Null when nothing is on its way (or it already outlived the bound); else resolves once the reads are in, or after `ms`. */
    ready(ms = 1000): Promise<void> | null {
      if (waiting === null || late) return null;
      const current = waiting;
      return Promise.race([current, new Promise<void>((resolve) => setTimeout(() => { if (waiting === current) late = true; resolve(); }, ms))]);
    },
  };
}

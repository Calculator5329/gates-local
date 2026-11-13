// Model downloads through Ollama's POST /api/pull, one at a time; the rest
// wait as "queued". Progress pushes go out at most 4 times a second (state
// changes always go out) with bytesPerSecond smoothed. Cancel aborts the
// request; Ollama keeps the blobs it already has, so pulling the same model
// again resumes. A bad name or a full disk ends in "error" with Ollama's
// message in plain words.
import type { PullProgress } from "@gates-local/contracts";

export const PULL_PUSH_INTERVAL_MS = 250;
/** Weight of the newest rate sample in the smoothed bytesPerSecond. */
const RATE_SMOOTHING = 0.3;

export interface PullManager {
  /** Start or queue a download; a name already queued or downloading returns its progress. */
  pull(name: string): PullProgress;
  /** Withdraw a queued or running download. False when there is none. */
  cancel(name: string): boolean;
  /** Queued and running downloads, in order. */
  pending(): readonly PullProgress[];
  /** Abort everything (a runtime switch, server shutdown); every job ends in a "cancelled" push. */
  stop(): void;
}

export const PULL_STOPPED_MESSAGE = "Download stopped because the runtime changed.";

export interface PullManagerOptions {
  admit?(): void;
  baseUrl: () => string | undefined;
  push: (progress: PullProgress) => void;
  /** After a download finishes: refresh the model list and the catalog. */
  onDone?: (name: string) => void | Promise<void>;
  /**
   * The whole download's size, from the curated list at once or from the registry a moment later.
   * Ollama names one file at a time, so the sum of what it has named is not the model's size until
   * the last file starts. With this set, no total goes out until the whole size is known.
   */
  sizeOf?: (name: string, signal: AbortSignal) => number | undefined | Promise<number | undefined>;
  now?: () => number;
  intervalMs?: number;
  log?: (line: string) => void;
}

interface Job {
  name: string;
  progress: PullProgress;
  controller: AbortController;
  layers: Map<string, { total: number; completed: number }>;
  /** The whole download, when sizeOf knew it. */
  size?: number;
  lastPushAt: number;
  /** A held-back progress push, sent when the interval is up if no newer line comes first. */
  trailing?: ReturnType<typeof setTimeout>;
  rateAt: number;
  rateBytes: number;
  rate?: number;
  /** Set by stop(): the cancelled push says why. */
  stopped?: boolean;
}

/** Ollama's error text, in words a person can act on. */
export function plainPullError(name: string, raw: string): string {
  const text = raw.trim();
  if (/no space left|disk full|not enough space/i.test(text)) {
    return `Not enough disk space to download ${name}. Free some space and download it again; the part already downloaded is kept.`;
  }
  if (/file does not exist|not found|manifest unknown|invalid model name|invalid reference/i.test(text)) {
    return `Ollama has no model named "${name}". Check the name in the Ollama library.`;
  }
  if (/connection refused|ECONNREFUSED|fetch failed|network|timeout|no such host|dial tcp/i.test(text)) {
    return `Could not reach the Ollama library to download ${name}. Check the network and download it again; the part already downloaded is kept.`;
  }
  return `Downloading ${name} failed: ${text}`;
}

const bytes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

export function createPullManager(options: PullManagerOptions): PullManager {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? PULL_PUSH_INTERVAL_MS;
  const log = options.log ?? (() => undefined);
  const queue: Job[] = [];
  let running: Job | undefined;

  const send = (job: Job) => {
    clearTimeout(job.trailing);
    job.trailing = undefined;
    job.lastPushAt = now();
    try {
      options.push(job.progress);
    } catch (e) {
      log(`models.pull push failed: ${(e as Error).message}`);
    }
  };

  const setState = (job: Job, next: Partial<PullProgress> & Pick<PullProgress, "state">) => {
    const { bytesPerSecond: _rate, message: _message, ...rest } = job.progress;
    job.progress = { ...rest, ...next };
    send(job);
  };

  const sums = (job: Job) => {
    let listed = 0;
    let completed = 0;
    for (const l of job.layers.values()) {
      listed += l.total;
      completed += l.completed;
    }
    return { listed, completed };
  };

  const sized = (job: Job, size: number | undefined) => {
    if (size === undefined || !Number.isFinite(size) || size <= 0 || running !== job) return;
    job.size = Math.round(size);
    if (job.progress.state === "downloading" && job.layers.size > 0) progressed(job);
  };

  const progressed = (job: Job, flush = false) => {
    const { listed, completed } = sums(job);
    // what Ollama has named so far is a floor, never the answer, until the whole size is known
    const total = options.sizeOf === undefined ? listed : job.size === undefined ? 0 : Math.max(job.size, listed);
    const t = now();
    if (!flush && t - job.lastPushAt < interval && job.progress.state === "downloading") {
      const { totalBytes: _total, ...held } = job.progress;
      job.progress = { ...held, completedBytes: completed, ...(total > 0 ? { totalBytes: total } : {}) };
      // Ollama can go quiet mid-layer; the latest numbers still reach the client.
      job.trailing ??= setTimeout(() => {
        job.trailing = undefined;
        if (job.progress.state === "downloading") progressed(job, true);
      }, interval - (t - job.lastPushAt));
      job.trailing.unref?.();
      return;
    }
    const dt = (t - job.rateAt) / 1000;
    if (dt > 0) {
      const sample = Math.max(0, completed - job.rateBytes) / dt;
      job.rate = job.rate === undefined ? sample : RATE_SMOOTHING * sample + (1 - RATE_SMOOTHING) * job.rate;
    }
    job.rateAt = t;
    job.rateBytes = completed;
    job.progress = {
      name: job.name,
      state: "downloading",
      completedBytes: completed,
      ...(total > 0 ? { totalBytes: total } : {}),
      ...(job.rate === undefined ? {} : { bytesPerSecond: Math.round(job.rate) }),
    };
    send(job);
  };

  const handleLine = (job: Job, line: Record<string, unknown>): "continue" | "done" => {
    if (typeof line["error"] === "string") throw new PullFailure(line["error"]);
    const status = typeof line["status"] === "string" ? line["status"] : "";
    const digest = typeof line["digest"] === "string" ? line["digest"] : undefined;
    const total = bytes(line["total"]);
    if (digest !== undefined && total !== undefined) {
      job.layers.set(digest, { total, completed: Math.min(total, bytes(line["completed"]) ?? 0) });
      progressed(job);
    } else if (status === "success") {
      return "done";
    } else if (/verifying|writing manifest|removing/i.test(status) && job.progress.state !== "verifying") {
      setState(job, { state: "verifying", completedBytes: job.progress.completedBytes, ...(job.progress.totalBytes ? { totalBytes: job.progress.totalBytes } : {}) });
    }
    return "continue";
  };

  const run = async (job: Job) => {
    const baseUrl = options.baseUrl();
    if (baseUrl === undefined) throw new PullFailure("Ollama is not running, so nothing can be downloaded.", true);
    job.rateAt = now();
    setState(job, { state: "downloading", completedBytes: 0 });
    try {
      const size = options.sizeOf?.(job.name, job.controller.signal);
      if (typeof size === "number" || size === undefined) sized(job, size);
      else size.then((n) => sized(job, n)).catch(() => undefined);
    } catch {
      // no size: the row shows what has arrived, without a total
    }
    const res = await fetch(new URL("/api/pull", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: job.name, stream: true }),
      signal: job.controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch {
        // keep the raw text
      }
      throw new PullFailure(message || `HTTP ${res.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (text === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue;
        }
        if (typeof parsed === "object" && parsed !== null && handleLine(job, parsed as Record<string, unknown>) === "done") return;
      }
    }
    const tail = buffer.trim();
    if (tail !== "") {
      const parsed = JSON.parse(tail) as unknown;
      if (typeof parsed === "object" && parsed !== null && handleLine(job, parsed as Record<string, unknown>) === "done") return;
    }
    throw new PullFailure("the download stream ended before Ollama said it was done");
  };

  const next = () => {
    if (running !== undefined) return;
    const job = queue.shift();
    if (job === undefined) return;
    running = job;
    run(job)
      .then(async () => {
        // done: every file has been named, so their sum is the true size
        const total = sums(job).listed || job.progress.totalBytes || job.progress.completedBytes;
        setState(job, { state: "done", completedBytes: total, ...(total > 0 ? { totalBytes: total } : {}) });
        try {
          await options.onDone?.(job.name);
        } catch (e) {
          log(`refresh after downloading ${job.name} failed: ${(e as Error).message}`);
        }
      })
      .catch((e: unknown) => {
        if (job.controller.signal.aborted) {
          setState(job, { state: "cancelled", completedBytes: job.progress.completedBytes, message: job.stopped ? PULL_STOPPED_MESSAGE : "Download cancelled." });
          return;
        }
        const message = e instanceof PullFailure && e.plain ? e.message : plainPullError(job.name, e instanceof Error ? e.message : String(e));
        setState(job, { state: "error", completedBytes: job.progress.completedBytes, message });
      })
      .finally(() => {
        running = undefined;
        next();
      });
  };

  const find = (name: string) => (running?.name === name ? running : queue.find((j) => j.name === name));

  return {
    pull(name) {
      options.admit?.();
      const existing = find(name);
      if (existing) return existing.progress;
      const job: Job = {
        name,
        progress: { name, state: "queued", completedBytes: 0 },
        controller: new AbortController(),
        layers: new Map(),
        lastPushAt: 0,
        rateAt: 0,
        rateBytes: 0,
      };
      queue.push(job);
      if (running !== undefined) send(job);
      next();
      return job.progress;
    },
    cancel(name) {
      const job = find(name);
      if (job === undefined) return false;
      if (job === running) {
        job.controller.abort();
        return true;
      }
      queue.splice(queue.indexOf(job), 1);
      setState(job, { state: "cancelled", completedBytes: 0, message: "Download cancelled." });
      return true;
    },
    pending: () => [...(running ? [running.progress] : []), ...queue.map((j) => j.progress)],
    stop() {
      for (const j of queue.splice(0)) {
        j.controller.abort();
        setState(j, { state: "cancelled", completedBytes: j.progress.completedBytes, message: PULL_STOPPED_MESSAGE });
      }
      // The running job's catch pushes its own "cancelled" once the abort lands.
      if (running) {
        running.stopped = true;
        running.controller.abort();
      }
    },
  };
}

class PullFailure extends Error {
  /** True when the message is already in plain words. */
  readonly plain: boolean;
  constructor(message: string, plain = false) {
    super(message);
    this.name = "PullFailure";
    this.plain = plain;
  }
}

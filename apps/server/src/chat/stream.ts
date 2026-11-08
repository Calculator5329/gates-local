// One streamed turn against Ollama POST /api/chat. Every request carries an
// explicit options.num_ctx, the size the fit check settled on for this model.
// What does not fit that window is dropped oldest first (chat/window.ts).
//
// Nothing persists here: the caller owns the thread store and feeds the
// deltas to its turn buffer. Ends with exactly one done or one error event.
import { Schema as S } from "effect";
import type { ChatErrorCode, ChatEvent, Message, TurnMessage } from "./types.ts";
import { fitToWindow } from "./window.ts";

export interface StreamTurnInput {
  baseUrl: string;
  model: string;
  messages: readonly TurnMessage[];
  numCtx: number;
  /** Ollama's think flag; omitted from the request when undefined. */
  think?: boolean;
  signal?: AbortSignal;
  /** Stamped on the done message; the caller's thread. */
  threadId?: string;
  newId?: () => string;
  now?: () => number;
  fetch?: typeof fetch;
}

const ChatChunk = S.Struct({
  model: S.optional(S.String),
  message: S.optional(
    S.Struct({
      role: S.optional(S.String),
      content: S.optional(S.String),
      thinking: S.optional(S.String),
    }),
  ),
  done: S.optional(S.Boolean),
  done_reason: S.optional(S.String),
  total_duration: S.optional(S.Number),
  prompt_eval_duration: S.optional(S.Number),
  eval_duration: S.optional(S.Number),
  prompt_eval_count: S.optional(S.Number),
  eval_count: S.optional(S.Number),
  error: S.optional(S.String),
});
type ChatChunk = typeof ChatChunk.Type;
const decodeChunk = S.decodeUnknownSync(ChatChunk);

/** The exact /api/chat request body. Exported so tests and callers can see it. */
export function chatRequestBody(input: Pick<StreamTurnInput, "model" | "messages" | "numCtx" | "think">): Record<string, unknown> {
  return {
    model: input.model,
    messages: input.messages.map(({ role, content }) => ({ role, content })),
    stream: true,
    ...(input.think === undefined ? {} : { think: input.think }),
    options: { num_ctx: input.numCtx },
  };
}

const fail = (code: ChatErrorCode, message: string): ChatEvent => ({ type: "error", code, message });

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

function parseLine(line: string): ChatChunk | { bad: string } {
  try {
    return decodeChunk(JSON.parse(line));
  } catch (error) {
    return { bad: `${describe(error)} in line ${JSON.stringify(line.slice(0, 200))}` };
  }
}

export async function* streamTurn(input: StreamTurnInput): AsyncGenerator<ChatEvent, void, undefined> {
  if (!Number.isInteger(input.numCtx) || input.numCtx < 1) {
    yield fail("num-ctx-invalid", `num_ctx ${input.numCtx} is not a size; no request sent.`);
    return;
  }
  const windowed = fitToWindow(input.messages, input.numCtx);
  if (!windowed.ok) {
    yield fail("context-too-small", windowed.message);
    return;
  }
  const { signal } = input;
  if (signal?.aborted) {
    yield fail("cancelled", "cancelled before the request was sent");
    return;
  }

  const url = new URL("/api/chat", input.baseUrl);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatRequestBody({ ...input, messages: windowed.messages })),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (isAbort(error, signal)) yield fail("cancelled", "cancelled before the reply started");
    else yield fail("connection-failed", `${url.href}: ${describe(error)}`);
    return;
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // the status is enough
    }
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // not JSON; keep the raw text
    }
    yield fail(response.status === 404 ? "model-not-found" : "http-error", `HTTP ${response.status}: ${detail}`);
    return;
  }
  if (!response.body) {
    yield fail("malformed-stream", "HTTP 200 with no body");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let thinking = "";
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (isAbort(error, signal)) yield fail("cancelled", "cancelled mid-stream; no done event");
        else yield fail("stream-error", `stream broke: ${describe(error)}`);
        return;
      }
      if (chunk.done) buffer += decoder.decode();
      else buffer += decoder.decode(chunk.value, { stream: true });

      const lines = buffer.split("\n");
      buffer = chunk.done ? "" : (lines.pop() ?? "");
      for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;
        const parsed = parseLine(line);
        if ("bad" in parsed) {
          yield fail("malformed-stream", parsed.bad);
          return;
        }
        if (parsed.error !== undefined) {
          yield fail("stream-error", parsed.error);
          return;
        }
        const think = parsed.message?.thinking;
        if (think) {
          thinking += think;
          yield { type: "thinking", text: think };
        }
        const text = parsed.message?.content;
        if (text) {
          content += text;
          yield { type: "delta", text };
        }
        if (parsed.done === true) {
          const message: Message = {
            id: (input.newId ?? (() => crypto.randomUUID()))(),
            threadId: input.threadId ?? "",
            role: "assistant",
            content,
            ...(thinking ? { thinking } : {}),
            model: parsed.model ?? input.model,
            createdAt: (input.now ?? Date.now)(),
            stats: {
              ...(parsed.prompt_eval_count === undefined ? {} : { promptTokens: parsed.prompt_eval_count }),
              ...(parsed.eval_count === undefined ? {} : { completionTokens: parsed.eval_count }),
              ...(parsed.total_duration === undefined ? {} : { durationMs: parsed.total_duration / 1e6 }),
              // Decode time alone: speed is eval_count over this, never over total_duration (load and prompt included).
              ...(parsed.eval_duration === undefined ? {} : { evalDurationMs: parsed.eval_duration / 1e6 }),
              ...(parsed.prompt_eval_duration === undefined ? {} : { promptEvalDurationMs: parsed.prompt_eval_duration / 1e6 }),
              numCtx: input.numCtx,
            },
          };
          yield { type: "done", message, stopReason: parsed.done_reason ?? "stop" };
          return;
        }
      }
      if (chunk.done) {
        yield fail("stream-ended-early", "the stream closed without a done line");
        return;
      }
    }
  } finally {
    // Also runs when the consumer stops early (break, return): release the
    // socket either way. Cancelling an ended body is a no-op.
    reader.cancel().catch(() => undefined);
  }
}

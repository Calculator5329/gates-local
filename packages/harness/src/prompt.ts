/** The image tool queues at most this many pictures in one turn; its result says how many went and why the rest did not. */
export const MAX_IMAGES_PER_TURN = 10;

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
export type ToolDefinition = ReturnType<typeof def>;
/**
 * `image` is offered only when the turn asked for it and image generation is wired; `shell` (Linux)
 * only when its sandbox probe passed on this machine (`shell: false` leaves it out). `read: false`
 * leaves read out too, for Measure's shell-only comparison; the app always offers read.
 */
export function toolDefinitions(platform: NodeJS.Platform = process.platform, options: { image?: boolean; shell?: boolean; read?: boolean } = {}): ToolDefinition[] {
  const string = { type: "string" };
  const number = { type: "integer", minimum: 1 };
  return [
    ...(options.read === false ? [] : [def("read", "List a Library folder or read a file. Use /library/<source id>/<relative path>.", { path: string, limit: number, offset: { type: "integer", minimum: 0 } }, ["path"])]),
    ...(platform === "win32"
      ? [def("sql", "Read rows from a SQLite snapshot. source is the SQLite source id from the Library list. No writes or PRAGMA statements.", { source: string, query: string, limit: number }, ["source", "query"])]
      : options.shell === false ? []
      : [def("shell", "Run a Linux shell command with no home, network or file locks. SQLite snapshots: sqlite3 /data/<source id>.db, with a dot command in quotes (sqlite3 /data/<source id>.db \".schema elements\"); files: /library/<source id>.", { command: string, timeoutMs: number }, ["command"])]),
    ...(options.image ? [def("image", `Queue images, one per prompt: write a separate, distinct prompt for each picture asked for. They are made in order after your reply ends and appear in this chat on their own. At most ${MAX_IMAGES_PER_TURN} per message.`, { prompts: { type: "array", items: string, minItems: 1 } }, ["prompts"])] : []),
  ];
}

/** Estimated token count uses a conservative 3 characters/token; not a tokenizer measurement. */
export function toolBlock(definitions: readonly ToolDefinition[] = toolDefinitions()): string {
  // why: the example names a tool the model was given; without read it is the shell.
  const example = definitions.some(d => d.function.name === "read") ? '{"name":"read","arguments":{"path":"/library/id"}}' : '{"name":"shell","arguments":{"command":"ls /library/id"}}';
  return `Use tools only when needed. Call with <tool_call>${example}</tool_call>. Wait for the result before answering. Never put calls in thinking.\n${JSON.stringify(definitions)}`;
}

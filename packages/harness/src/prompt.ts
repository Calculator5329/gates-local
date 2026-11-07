function def(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
export function toolDefinitions(platform: NodeJS.Platform = process.platform) {
  const string = { type: "string" };
  const number = { type: "integer", minimum: 1 };
  return [
    def("read", "List a Library folder or read a file. Use /library/<source id>/<relative path>.", { path: string, limit: number, offset: { type: "integer", minimum: 0 } }, ["path"]),
    platform === "win32"
      ? def("sql", "Read rows from a SQLite snapshot. No writes or PRAGMA statements.", { source: string, query: string, limit: number }, ["source", "query"])
      : def("shell", "Run a Linux shell command with no home or network. SQLite snapshots: /data/<source id>.db; files: /library/<source id>.", { command: string, timeoutMs: number }, ["command"]),
    def("image", "Generate an image when image generation is set up.", { prompt: string }, ["prompt"]),
  ];
}

/** Estimated token count uses a conservative 3 characters/token; not a tokenizer measurement. */
export function toolBlock(platform: NodeJS.Platform = process.platform): string {
  return `Use tools only when needed. Call with <tool_call>{"name":"read","arguments":{"path":"/library/id"}}</tool_call>. Wait for the result before answering. Never put calls in thinking.\n${JSON.stringify(toolDefinitions(platform))}`;
}

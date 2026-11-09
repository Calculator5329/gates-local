// The direct page protocol used by apps/desktop/scripts/smoke.ts. Electron's
// browser endpoint need not implement Playwright's full Chromium attachment.
export class NativeCdp {
  readonly #ws: WebSocket;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #id = 0;
  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", event => {
      const message: unknown = JSON.parse(String(event.data));
      if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if ("error" in message) pending?.reject(new Error("Native DevTools command was refused"));
      else pending?.resolve("result" in message ? message.result : undefined);
    });
    ws.addEventListener("close", () => { for (const pending of this.#pending.values()) pending.reject(new Error("Native DevTools closed")); this.#pending.clear(); });
  }
  static async connect(url: string): Promise<NativeCdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("Cannot connect native DevTools")), { once: true }); });
    return new NativeCdp(ws);
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.#id;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Native DevTools timed out: ${method}`)); }, 20_000);
      this.#pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<unknown> {
    const response = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (typeof response !== "object" || response === null || "exceptionDetails" in response || !("result" in response)) throw new Error("Native renderer evaluation failed");
    const result = response.result;
    if (typeof result !== "object" || result === null || !("value" in result)) throw new Error("Native renderer returned no value");
    return result.value;
  }
  close() { this.#ws.close(); }
}

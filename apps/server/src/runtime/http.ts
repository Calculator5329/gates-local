// Minimal loopback GET with a hard timeout. node:http rather than fetch so
// connection errors keep their errno code (ECONNREFUSED vs a hung listener).
import http from "node:http";

export type GetResult =
  | { kind: "response"; status: number; contentType: string; body: string }
  | { kind: "refused" }
  | { kind: "timeout" }
  | { kind: "error"; code: string; message: string };

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** `signal` ends the request early with an ABORT_ERR error result. */
export function httpGet(url: string, timeoutMs: number, signal?: AbortSignal): Promise<GetResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GetResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => {
      req.destroy();
      done({ kind: "error", code: "ABORT_ERR", message: `GET ${url} was aborted` });
    };
    const req = http.get(url, { headers: { accept: "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          done({ kind: "error", code: "EBODYTOOLARGE", message: `response from ${url} exceeded ${MAX_BODY_BYTES} bytes` });
          return;
        }
        chunks.push(c);
      });
      res.on("end", () =>
        done({
          kind: "response",
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", (e: NodeJS.ErrnoException) => done({ kind: "error", code: e.code ?? "EUNKNOWN", message: e.message }));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done({ kind: "timeout" });
    }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNREFUSED") done({ kind: "refused" });
      else done({ kind: "error", code: e.code ?? "EUNKNOWN", message: e.message });
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

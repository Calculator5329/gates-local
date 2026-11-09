import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { httpGet } from "./http.ts";

it("accepts 8 MiB, then settles and closes an oversized chunked response", async () => {
  const limit = 8 * 1024 * 1024;
  let closed: Promise<unknown> | undefined;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/at-limit") { res.end("a".repeat(limit)); return; }
    closed = once(res, "close");
    res.write("a".repeat(limit));
    res.write("b");
    // Leave it open: only the client ceiling may end this response.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const allowed = await httpGet(`${url}/at-limit`, 2000);
    expect(allowed.kind).toBe("response");
    if (allowed.kind === "response") expect(allowed.body.length).toBe(limit);
    expect(await httpGet(`${url}/over-limit`, 2000)).toMatchObject({ kind: "error", code: "EBODYTOOLARGE" });
    expect(closed).toBeDefined();
    await closed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

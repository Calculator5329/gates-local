import { spawn } from "node:child_process";
import { expect, it } from "vitest";

it.each([false, true])("an upgraded fake peer reset is expected, but unrelated socket errors still fail (unexpected=%s)", async unexpected => {
  // Isolate the unhandled Socket error so it proves the worker-crash boundary
  // without terminating the unit runner. Use a real TCP reset, not a timer.
  const source = `
    import { createConnection, Socket } from "node:net";
    import { once } from "node:events";
    import { fakeComfy } from ${JSON.stringify(new URL("./fake-comfy.ts", import.meta.url).href)};
    let observed;
    const reset = new Promise(resolve => { observed = resolve; });
    const emit = Socket.prototype.emit;
    Socket.prototype.emit = function(name, ...args) {
      if (name === "error" && args[0]?.code === "ECONNRESET") {
        observed();
        if (${unexpected}) args[0] = Object.assign(new Error("Unexpected peer fault"), { code: "EIO" });
      }
      return emit.call(this, name, ...args);
    };
    const fake = await fakeComfy();
    const address = new URL(fake.url);
    const peer = createConnection({ host: address.hostname, port: Number(address.port) });
    await once(peer, "connect");
    peer.write(["GET /ws HTTP/1.1", "Host: " + address.host, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\\r\\n"));
    await once(peer, "data");
    peer.resetAndDestroy();
    await reset;
    const response = await fetch(fake.url + "/system_stats");
    if (!response.ok) throw new Error("Fake stopped answering after reset");
    await response.text();
    await fake.close();
    console.log("still answers");
  `;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  expect(result.code, result.stderr).toBe(unexpected ? 1 : 0);
  if (unexpected) expect(result.stderr).toContain("EIO");
  else expect(result.stdout).toContain("still answers");
});

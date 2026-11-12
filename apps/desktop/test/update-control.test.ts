import { expect, it } from "vitest";
import { startWsServer } from "../../server/src/ws/server.ts";
import { withUpdateControl } from "../src/update-control.ts";
import { launchApprovedUpdate } from "../src/update-launch.ts";

it("AU-01 main validates over the real authenticated wire and releases only its transferred capability", async () => {
  const targetCommit = "a".repeat(40);
  const seen: unknown[] = [];
  const server = await startWsServer({ port: 0, token: "test-update-control", allowedOrigins: [], handlers: {
    "update.commit": (request) => { seen.push(request); return { accepted: true, release: request.release }; },
    "update.cancel": ({ reservation }) => { seen.push(reservation); return { cancelled: true }; },
  } });
  try {
    const result = await withUpdateControl(`ws://127.0.0.1:${server.port}/?token=test-update-control`, (control) => launchApprovedUpdate({ reservation: "renderer-reservation", target: targetCommit }, control, async (approved) => {
      expect(approved).toBe(targetCommit);
      return { ok: false, message: "Simulated spawn failure" };
    }));
    expect(result).toEqual({ ok: false, message: "Simulated spawn failure" });
    expect(seen).toEqual([{ reservation: "renderer-reservation", target: targetCommit, release: expect.any(String) }, expect.any(String), "renderer-reservation"]);
    expect(seen[1]).not.toBe("renderer-reservation");
  } finally { await server.close(); }
});

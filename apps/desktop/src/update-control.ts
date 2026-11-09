import { createClient, WireError } from "@gates-local/contracts";
import type { UpdateControl } from "./update-launch.ts";

async function connectUpdateClient(url: string) {
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The app server did not answer the update approval.")), 5_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not contact the app server to approve the update.")); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("The app server closed before approving the update.")); }, { once: true });
    });
    return createClient(socket);
  } catch (error) { socket.close(); throw error; }
}

/** Authenticated supervised-server connection, independent of the renderer's state. */
export async function withUpdateControl<T>(url: string, run: (control: UpdateControl) => Promise<T>): Promise<T> {
  const client = await connectUpdateClient(url);
  try {
    return await run({
      commit: (request) => client.call("update.commit", request),
      cancel: async (reservation) => {
        try { return await client.call("update.cancel", { reservation }); }
        catch (error) {
          if (!(error instanceof WireError) || error.code !== "closed") throw error;
          // Cancellation is idempotent. A lost commit reply still has to
          // release main's known capability through a fresh connection.
          const recovery = await connectUpdateClient(url);
          try { return await recovery.call("update.cancel", { reservation }); }
          finally { recovery.close(); }
        }
      },
    });
  } finally { client.close(); }
}

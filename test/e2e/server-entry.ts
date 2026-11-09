import path from "node:path";
import { statSync } from "node:fs";

/** Entry selection shared by stack startup and its configuration tests. */
export function e2eServerEntry(root: string): string {
  const fixture = path.join(root, "test/e2e/library-server.ts");
  try { if (statSync(fixture).isFile()) return fixture; } catch { /* Refuse below, never use production transports. */ }
  throw new Error("The offline E2E Library fixture is missing or unreadable. Refusing to start a production import server.");
}

// Classify whatever listens at a base URL: Ollama, something else, or nothing.
import { httpGet } from "./http.ts";
import { VersionResponse, decode, parseJson } from "./schemas.ts";

export type ProbeResult =
  | { kind: "ollama"; version: string }
  | { kind: "wrong-service"; detail: string }
  | { kind: "none" };

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

export function portOf(baseUrl: string): string {
  const u = new URL(baseUrl);
  return u.port || (u.protocol === "https:" ? "443" : "80");
}

/**
 * Ollama answers `GET /api/version` with `{"version": "..."}` and `GET /`
 * with "Ollama is running". Both must hold before the port counts as Ollama.
 */
export async function probe(baseUrl: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const port = portOf(baseUrl);
  const where = `port ${port} (${baseUrl})`;
  const v = await httpGet(new URL("/api/version", baseUrl).href, timeoutMs);
  if (v.kind === "refused") return { kind: "none" };
  if (v.kind === "timeout") {
    return { kind: "wrong-service", detail: `Something holds ${where} but did not answer within ${timeoutMs} ms; not starting a server there.` };
  }
  if (v.kind === "error") {
    return { kind: "wrong-service", detail: `Something on ${where} broke the connection (${v.code}); it is not a working Ollama.` };
  }
  const json = parseJson(v.body);
  const decoded = json.ok ? decode(VersionResponse, json.value) : undefined;
  if (v.status !== 200 || !decoded?.ok) {
    const snippet = v.body.slice(0, 80).replace(/\s+/g, " ").trim();
    return {
      kind: "wrong-service",
      detail: `A service on ${where} is not Ollama: GET /api/version gave HTTP ${v.status}${snippet ? ` "${snippet}"` : ""}.`,
    };
  }
  const root = await httpGet(new URL("/", baseUrl).href, timeoutMs);
  if (root.kind !== "response" || !root.body.includes("Ollama is running")) {
    return { kind: "wrong-service", detail: `A service on ${where} answers /api/version but GET / does not say "Ollama is running".` };
  }
  return { kind: "ollama", version: decoded.value.version };
}

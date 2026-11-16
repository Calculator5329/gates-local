// external: Ollama's pull stream names one file at a time, so its running total starts as one file.
export const OLLAMA_REGISTRY = "https://registry.ollama.ai";
const MANIFEST_TYPES = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json";

export function manifestUrl(name: string, registry: string = OLLAMA_REGISTRY): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return undefined;
  const at = trimmed.lastIndexOf(":");
  const tagged = at > trimmed.lastIndexOf("/");
  const repo = tagged ? trimmed.slice(0, at) : trimmed;
  const tag = tagged ? trimmed.slice(at + 1) : "latest";
  const parts = repo.split("/");
  if (tag === "" || parts.some((p) => p === "")) return undefined;
  if (parts.length === 3 && parts[0]!.includes(".")) return `https://${parts[0]}/v2/${parts[1]}/${parts[2]}/manifests/${tag}`;
  if (parts.length === 2) return `${registry}/v2/${parts[0]}/${parts[1]}/manifests/${tag}`;
  if (parts.length === 1) return `${registry}/v2/library/${parts[0]}/manifests/${tag}`;
  return undefined;
}

export function manifestBytes(manifest: unknown): number | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const { layers, config } = manifest as { layers?: unknown; config?: unknown };
  if (!Array.isArray(layers) || layers.length === 0) return undefined;
  let total = 0;
  for (const part of [...layers, config]) {
    const size = typeof part === "object" && part !== null ? (part as { size?: unknown }).size : undefined;
    if (typeof size === "number" && Number.isFinite(size) && size >= 0) total += size;
  }
  return total > 0 ? Math.round(total) : undefined;
}

export interface RegistrySizeOptions {
  readonly registry?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export type RegistryLookup = { readonly kind: "size"; readonly bytes: number } | { readonly kind: "missing" } | { readonly kind: "unreadable" };

export async function registryLookup(name: string, signal: AbortSignal, options: RegistrySizeOptions = {}): Promise<RegistryLookup> {
  const url = manifestUrl(name, options.registry);
  if (url === undefined) return { kind: "missing" };
  try {
    const res = await (options.fetch ?? fetch)(url, {
      headers: { accept: MANIFEST_TYPES },
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 5000)]),
    });
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "unreadable" };
    const bytes = manifestBytes(await res.json());
    return bytes === undefined ? { kind: "unreadable" } : { kind: "size", bytes };
  } catch {
    return { kind: "unreadable" };
  }
}

export async function registrySize(name: string, signal: AbortSignal, options: RegistrySizeOptions = {}): Promise<number | undefined> {
  const found = await registryLookup(name, signal, options);
  return found.kind === "size" ? found.bytes : undefined;
}

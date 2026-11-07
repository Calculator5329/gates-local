// Byte formatting for fit messages: exact bytes plus decimal GB, the unit
// Ollama and download pages use.

export function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function formatBytes(bytes: number): string {
  return `${Math.round(bytes).toLocaleString("en-US")} bytes (${formatGb(bytes)})`;
}

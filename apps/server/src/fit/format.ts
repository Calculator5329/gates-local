// external: Ollama and download pages state a size in decimal GB, so a figure here reads the same as theirs.
const BYTES_PER_DECIMAL_GB = 1e9;

export function formatGb(bytes: number): string {
  return `${(bytes / BYTES_PER_DECIMAL_GB).toFixed(2)} GB`;
}

export function formatBytes(bytes: number): string {
  return `${Math.round(bytes).toLocaleString("en-US")} bytes (${formatGb(bytes)})`;
}

import type { InstallManifest } from "./schemas.ts";

// external: Ollama's tar.zst frames carry no content size, so unpackedBytes is pinned.
export const PINNED_OLLAMA: InstallManifest = {
  version: "0.40.15",
  url: "https://github.com/ollama/ollama/releases/download/v0.40.15/ollama-linux-amd64.tar.zst",
  sha256: "628c018404a4206493efd38e46251c154ede5141b8b8dc85c659b3b027c47379",
  sizeBytes: 1543547172,
  unpackedBytes: 2528731874,
  format: "tar.zst",
  verified: true,
  source: "GitHub release API asset digest, read 2026-11-07",
};

// external: Ollama's Windows ZIP has ollama.exe at its top level and lib\ollama\ beside it.
export const PINNED_OLLAMA_WINDOWS: InstallManifest = {
  version: "0.40.15",
  url: "https://github.com/ollama/ollama/releases/download/v0.40.15/ollama-windows-amd64.zip",
  sha256: "9ca74a7ab66ec86870b1eecac7df160df08dc4e3a291ab5d2d59bcf9310221c6",
  sizeBytes: 1614941966,
  unpackedBytes: 2263717391,
  format: "zip",
  verified: true,
  source: "GitHub release API asset digest, read 2026-11-07",
};

export function pinnedOllamaFor(platform: NodeJS.Platform, arch: string): InstallManifest | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "linux") return PINNED_OLLAMA;
  if (platform === "win32") return PINNED_OLLAMA_WINDOWS;
  return undefined;
}

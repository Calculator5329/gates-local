// The pinned Ollama release the app installs into its own folder (D1).
import type { InstallManifest } from "./schemas.ts";

/**
 * Linux amd64 asset of Ollama v0.40.15 (published 2026-11-03). URL, size and
 * sha256 were read on 2026-11-07 from the GitHub release API
 * (api.github.com/repos/ollama/ollama/releases/latest, asset
 * `ollama-linux-amd64.tar.zst`, field `digest`). Bump all four together.
 */
export const PINNED_OLLAMA: InstallManifest = {
  version: "0.40.15",
  url: "https://github.com/ollama/ollama/releases/download/v0.40.15/ollama-linux-amd64.tar.zst",
  sha256: "628c018404a4206493efd38e46251c154ede5141b8b8dc85c659b3b027c47379",
  sizeBytes: 1543547172,
  format: "tar.zst",
  verified: true,
  source: "GitHub release API asset digest, read 2026-11-07",
};

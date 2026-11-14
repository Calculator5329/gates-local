// The pinned Ollama release the app installs into its own folder (D1).
import type { InstallManifest } from "./schemas.ts";

/**
 * Linux amd64 asset of Ollama v0.40.15 (published 2026-11-03). URL, size and
 * sha256 were read on 2026-11-07 from the GitHub release API
 * (api.github.com/repos/ollama/ollama/releases/latest, asset
 * `ollama-linux-amd64.tar.zst`, field `digest`). Bump all of them together.
 *
 * unpackedBytes: the sum of the archive's file sizes (`zstd -dc | tar -tv`, 80 files), read
 * 2026-11-14. It is larger than the download because the archive is compressed, and it holds the
 * CUDA 12 and 13 libraries in every copy. zstd frames here carry no content
 * size, so it cannot be read from the archive's header and is pinned like the size.
 */
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

/**
 * Windows amd64 asset of the same release. URL, size and sha256 were read
 * on 2026-11-07 from the GitHub release API
 * (api.github.com/repos/ollama/ollama/releases/tags/v0.40.15, asset
 * `ollama-windows-amd64.zip`, fields `size` and `digest`). The ZIP holds
 * ollama.exe at its top level and lib\ollama\ beside it. Bump with the
 * Linux entry.
 *
 * unpackedBytes: the sum of the uncompressed sizes in the ZIP's central directory (80 entries),
 * read 2026-11-14 with a range request for the archive's last 4 MiB.
 */
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

/** The pinned release for this platform, or undefined where the app has none to install. */
export function pinnedOllamaFor(platform: NodeJS.Platform, arch: string): InstallManifest | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "linux") return PINNED_OLLAMA;
  if (platform === "win32") return PINNED_OLLAMA_WINDOWS;
  return undefined;
}

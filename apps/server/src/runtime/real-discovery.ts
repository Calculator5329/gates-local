// One real, read-only discovery run against this machine (not part of vitest):
//   node apps/server/src/runtime/real-discovery.ts
// Only GETs /, /api/version, /api/tags and /api/ps. discover() never starts,
// installs, pulls, loads or stops anything; installs are off as well.
import { listLoaded, listModels } from "./models.ts";
import { detectModelsDir, findModelsDirs } from "./paths.ts";
import { createOllamaRuntime } from "./runtime.ts";

const runtime = createOllamaRuntime({ allowInstall: false });
const status = await runtime.discover();
console.log("RuntimeStatus:", JSON.stringify(status));
console.log("Model stores found:", JSON.stringify(findModelsDirs()));
console.log("Store an app-owned server would use:", JSON.stringify(detectModelsDir() ?? null));
const url = runtime.baseUrl();
if (url) {
  const models = await listModels(url);
  const loaded = await listLoaded(url);
  console.log(`Models: ${models.length}`);
  for (const m of models) console.log(`  ${m.name}  ${(m.sizeBytes / 1e9).toFixed(1)} GB  ${m.parameterSize ?? "?"} ${m.quantization ?? ""}`);
  console.log(`Loaded now (/api/ps): ${loaded.length}${loaded.map((l) => ` ${l.name} vram=${(l.sizeVramBytes / 1e9).toFixed(1)}GB`).join("")}`);
}

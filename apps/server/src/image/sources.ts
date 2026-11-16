// external: ComfyUI serves its templates under /templates and saved workflows under /userdata
import { convertWorkflow, WorkflowRefusal, type ObjectInfo } from "./convert.ts";
import { GROUPS, type KnownWorkflow, type ModelSource } from "./presets.ts";

export type ComfyGet = (route: string) => Promise<unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const array = (v: unknown): readonly unknown[] => Array.isArray(v) ? v : [];

export function modelSources(file: unknown): Record<string, ModelSource> {
  if (!isObject(file)) return {};
  const nodes = [...array(file["nodes"]), ...array(isObject(file["definitions"]) ? file["definitions"]["subgraphs"] : undefined).flatMap((g) => isObject(g) ? array(g["nodes"]) : [])];
  const out: Record<string, ModelSource> = {};
  for (const node of nodes) {
    const models = isObject(node) && isObject(node["properties"]) ? array(node["properties"]["models"]) : [];
    for (const m of models) {
      if (!isObject(m) || typeof m["name"] !== "string" || out[m["name"]] !== undefined) continue;
      out[m["name"]] = { ...typeof m["directory"] === "string" ? { directory: m["directory"] } : {}, ...typeof m["url"] === "string" ? { url: m["url"] } : {} };
    }
  }
  return out;
}

export function keepWorkflow(id: string, name: string, group: string, file: unknown, info: ObjectInfo): KnownWorkflow {
  const sources = modelSources(file);
  try { return { id, name, group, graph: convertWorkflow(file, info), sources }; }
  catch (error) { return { id, name, group, why: error instanceof WorkflowRefusal ? error.message : "It is not a workflow file ComfyUI saves.", sources }; }
}

async function each<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...await Promise.all(items.slice(i, i + limit).map(read)));
  return out;
}

const STRUCK = /krea[-_]?2|qwen[-_]?image[-_]?2[-_]1/i;

export async function readTemplates(get: ComfyGet, info: ObjectInfo): Promise<KnownWorkflow[] | undefined> {
  let index: unknown;
  try { index = await get("/templates/index.json"); } catch { return undefined; }
  const entries = new Map<string, string>();
  for (const category of array(index)) {
    for (const t of isObject(category) ? array(category["templates"]) : []) {
      if (!isObject(t) || typeof t["name"] !== "string" || entries.has(t["name"])) continue;
      const io = isObject(t["io"]) ? t["io"] : {};
      if (t["mediaType"] !== "image" || t["openSource"] === false || array(io["inputs"]).length > 0 || STRUCK.test(t["name"])) continue;
      entries.set(t["name"], typeof t["title"] === "string" ? t["title"] : t["name"]);
    }
  }
  const read = await each([...entries], 6, async ([name, title]) => {
    try { return keepWorkflow(`template:${name}`, title, GROUPS.templates, await get(`/templates/${encodeURIComponent(name)}.json`), info); }
    catch { return undefined; }
  });
  return read.filter((w) => w !== undefined);
}

export async function readSaved(get: ComfyGet, info: ObjectInfo): Promise<KnownWorkflow[] | undefined> {
  let names: unknown;
  try { names = await get("/userdata?dir=workflows&recurse=true&split=false&full_info=false"); } catch { return undefined; }
  const files = array(names).filter((n): n is string => typeof n === "string" && n.toLowerCase().endsWith(".json"));
  const read = await each(files, 6, async (name) => {
    try { return keepWorkflow(`saved:${name}`, name.replace(/\.json$/i, ""), GROUPS.saved, await get(`/userdata/${encodeURIComponent(`workflows/${name}`)}`), info); }
    catch { return undefined; }
  });
  return read.filter((w) => w !== undefined);
}

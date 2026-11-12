// Image mode fills in four things in any workflow: the prompt, the picture's size, the seed, and
// which node's picture comes back. They are found by the shape of the API graph (convert.ts),
// never by node ids or names:
// - output: the one Save Image or Preview Image node;
// - prompt: the text on the way into a sampler's `positive` input (or a BasicGuider's
//   `conditioning`), followed back through conditioning nodes; a text box that feeds it
//   (a Primitive node's `value`) is filled in instead;
// - size: the one empty-latent node's width and height, or the Primitive numbers they read. Any
//   other node that repeats the same width and height as plain numbers (Flux2Scheduler) is kept
//   in step;
// - seed: the one `seed` or `noise_seed` value, or the Primitive number it reads.
// Anything missing, doubled, or worked out by another node is refused in words (WorkflowRefusal),
// and the picker lists the workflow greyed out with that reason.
import { WorkflowRefusal, type ApiGraph, type ApiNode } from "./convert.ts";

export interface Target { readonly node: string; readonly input: string }
export interface Controls {
  readonly prompt: Target;
  /** First the latent's (or its Primitive's) input, then any node that repeats it. */
  readonly width: readonly Target[];
  readonly height: readonly Target[];
  readonly seed: Target;
  /** The empty-latent node; its batch size is set to one. */
  readonly latent: string;
  /** The node whose picture is fetched. */
  readonly output: string;
  /** The size the file itself was saved with. */
  readonly size: { readonly width: number; readonly height: number };
}
export interface ControlValues { readonly prompt: string; readonly width: number; readonly height: number; readonly seed: number }

const IMAGE_OUTPUTS = new Set(["SaveImage", "PreviewImage"]);
const TEXT_INPUTS = ["text", "prompt"];
const SEED_INPUTS = ["seed", "noise_seed"];
const isRef = (v: unknown): v is readonly [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";
const byId = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
const nodes = (ids: readonly string[]) => ids.length === 2 ? `${ids[0]} and ${ids[1]}` : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
const keyOf = (t: Target) => `${t.node}\u0000${t.input}`;
const refuse = (message: string): never => { throw new WorkflowRefusal(message); };

/** A plain value, or the `value` of a Primitive node it reads; `made` names the class when another kind of node makes it. */
function resolve(graph: ApiGraph, node: string, input: string, kind: "string" | "number"): { target: Target; value: unknown } | { made: string } {
  const v = graph[node]!.inputs[input];
  if (!isRef(v)) return { target: { node, input }, value: v };
  const source: ApiNode | undefined = graph[v[0]];
  if (source !== undefined && source.class_type.startsWith("Primitive") && typeof source.inputs["value"] === kind) return { target: { node: v[0], input: "value" }, value: source.inputs["value"] };
  return { made: source?.class_type ?? "a missing node" };
}

function findOutput(graph: ApiGraph): string {
  const outputs = Object.keys(graph).filter((id) => IMAGE_OUTPUTS.has(graph[id]!.class_type)).toSorted(byId);
  if (outputs.length === 0) refuse("It saves no picture: there is no Save Image or Preview Image node.");
  if (outputs.length > 1) refuse(`It saves ${outputs.length} pictures (nodes ${nodes(outputs)}); Image mode takes one.`);
  return outputs[0]!;
}

function findPrompt(graph: ApiGraph): Target {
  const found = new Map<string, Target>();
  const seen = new Set<string>();
  const walk = (id: string) => {
    const node = graph[id];
    if (node === undefined || seen.has(id)) return;
    seen.add(id);
    const text = TEXT_INPUTS.find((name) => name in node.inputs);
    if (text !== undefined) {
      const r = resolve(graph, id, text, "string");
      if ("made" in r) refuse(`Its prompt is made by another node (${r.made}), so Image mode cannot fill it in.`);
      else found.set(keyOf(r.target), r.target);
      return;
    }
    for (const [name, v] of Object.entries(node.inputs)) if (name.includes("conditioning") && isRef(v)) walk(v[0]);
  };
  for (const node of Object.values(graph)) {
    const start = node.inputs["positive"] ?? (node.class_type === "BasicGuider" ? node.inputs["conditioning"] : undefined);
    if (isRef(start)) walk(start[0]);
  }
  const targets = [...found.values()].toSorted((a, b) => byId(a.node, b.node));
  if (targets.length === 0) refuse("It has no prompt box: no text reaches a sampler's positive input.");
  if (targets.length > 1) refuse(`It has ${targets.length} prompt boxes (nodes ${nodes(targets.map((t) => t.node))}); Image mode fills in one.`);
  return targets[0]!;
}

function findSize(graph: ApiGraph): Pick<Controls, "width" | "height" | "latent" | "size"> {
  const latents = Object.keys(graph).filter((id) => /^Empty.*Latent/.test(graph[id]!.class_type) && "width" in graph[id]!.inputs && "height" in graph[id]!.inputs).toSorted(byId);
  if (latents.length === 0) refuse("It has no empty latent node, so Image mode cannot set the picture's size.");
  if (latents.length > 1) refuse(`It has ${latents.length} empty latent nodes (nodes ${nodes(latents)}); Image mode sizes one.`);
  const latent = latents[0]!;
  const w = resolve(graph, latent, "width", "number"), h = resolve(graph, latent, "height", "number");
  if ("made" in w || "made" in h) return refuse(`Its size is made by another node (${"made" in w ? w.made : (h as { made: string }).made}), so Image mode cannot set it.`);
  if (typeof w.value !== "number" || typeof h.value !== "number") return refuse("Its size is not a number, so Image mode cannot set it.");
  if (w.target.node === h.target.node && w.target.input === h.target.input) refuse("Its width and height are one number, so Image mode cannot set them apart.");
  const width: Target[] = [w.target], height: Target[] = [h.target];
  for (const id of Object.keys(graph).toSorted(byId)) {
    const inputs = graph[id]!.inputs;
    if (id === latent || inputs["width"] !== w.value || inputs["height"] !== h.value) continue;
    width.push({ node: id, input: "width" }); height.push({ node: id, input: "height" });
  }
  return { width, height, latent, size: { width: w.value, height: h.value } };
}

function findSeed(graph: ApiGraph): Target {
  const found = new Map<string, Target>();
  for (const id of Object.keys(graph).toSorted(byId)) {
    for (const input of SEED_INPUTS) {
      if (!(input in graph[id]!.inputs)) continue;
      const r = resolve(graph, id, input, "number");
      if ("made" in r) refuse(`Its seed is made by another node (${r.made}), so Image mode cannot set it.`);
      else found.set(keyOf(r.target), r.target);
    }
  }
  const targets = [...found.values()];
  if (targets.length === 0) refuse("It has no seed, so every picture would come out the same.");
  if (targets.length > 1) refuse(`It has ${targets.length} seeds (nodes ${nodes(targets.map((t) => t.node))}); Image mode sets one.`);
  return targets[0]!;
}

/** Where Image mode writes its prompt, size and seed in this graph, and which node it reads the picture from. Throws WorkflowRefusal. */
export function findControls(graph: ApiGraph): Controls {
  const output = findOutput(graph);
  if (Object.values(graph).some((n) => n.class_type.startsWith("LoadImage"))) refuse("It starts from a picture (Load Image); Image mode makes pictures from words only.");
  const prompt = findPrompt(graph);
  const size = findSize(graph);
  const seed = findSeed(graph);
  return { prompt, ...size, seed, output };
}

/** A copy of `graph` with the prompt, size and seed written in and a batch of one. The graph passed in is left as it was. */
export function applyControls(graph: ApiGraph, controls: Controls, values: ControlValues): ApiGraph {
  const out = structuredClone(graph);
  const set = (t: Target, value: unknown) => { out[t.node]!.inputs[t.input] = value; };
  set(controls.prompt, values.prompt);
  for (const t of controls.width) set(t, values.width);
  for (const t of controls.height) set(t, values.height);
  set(controls.seed, values.seed);
  if ("batch_size" in out[controls.latent]!.inputs) out[controls.latent]!.inputs["batch_size"] = 1;
  return out;
}

// ComfyUI saves a workflow in its editor format: `nodes` and `links`, with reusable subgraphs under
// `definitions.subgraphs` and editor-only nodes (notes, reroutes, text boxes). Its /prompt route
// runs only the API format: one entry per node to run, `{ class_type, inputs }`, with every link
// written as [node id, output slot]. This file turns the first into the second.
//
// Written for this repository from the file format and ComfyUI's /object_info answer (MIT, like
// the rest of it). No code from ComfyUI's GPL-3.0 frontend was read or copied.
//
// What it does, in order:
// - Each subgraph instance is opened in place. Its inner nodes get the id `<instance>:<inner>`
//   (nested: `20:4:9`). An instance input feeds the inner links that start at the subgraph's
//   input node (id -10), matched by name; an inner link that ends at the output node (id -20)
//   is what the instance's output gives.
// - Saved widget values (`widgets_values`) become named inputs in /object_info's input order.
//   A seed-like input (`control_after_generate`) is followed by its control word ("randomize"),
//   and an upload combo by its upload value, neither of which the API takes. A value of the
//   wrong kind means the list is shifted; that workflow is refused, never sent shifted. So are
//   values left over at the end, and a widget kind this file cannot read (a dynamic combo, which
//   brings inputs of its own, or a colour), named in the reason.
// - A value set on a subgraph instance wins over the inner node's own. Newer files list those
//   values in `properties.proxyWidgets` ([inner node id, widget name], same index as the value).
//   Older files have no such list: the instance's `widgets_values` then hold one value for each
//   subgraph input that has no socket on the instance, or a socket marked as a widget, in the
//   subgraph's input order (a seed again followed by its control word). A list that does not fit
//   that rule is refused.
// - Notes, Markdown notes and Reroutes are dropped; a reroute passes its input on. A multiline
//   text box (PrimitiveStringMultiline, or the editor's old PrimitiveNode) is dropped and its text
//   written into the input it feeds.
// - A bypassed node (mode 4) passes each output's matching input through; a muted one (mode 2)
//   gives nothing. Either one on a subgraph instance covers everything inside it.
// - A switch (ComfySwitchNode) whose setting is fixed in the file (its own value, or one set on its
//   subgraph's instance) passes on the input it selects, as ComfyUI runs only that branch. One set
//   by another node stays a node.
// - Only nodes an output node (`output_node` in /object_info) reads from are kept, so a branch
//   switched off in the editor needs neither its files nor its node classes. A node of a class
//   ComfyUI does not list that reads from others and that nothing reads from is kept too, as it
//   may be the output; it is then refused by name.

export type ObjectInfo = Readonly<Record<string, unknown>>;
export type ApiNode = { class_type: string; inputs: Record<string, unknown> };
export type ApiGraph = Record<string, ApiNode>;

/** A workflow this app cannot run, with the reason in words for the picker. */
export class WorkflowRefusal extends Error {
  override readonly name = "WorkflowRefusal";
}

const MUTED = 2;
const BYPASSED = 4;
/** An inner link from the subgraph's input node; one to its output node (-20) is found from `outputs[].linkIds`. */
const SUBGRAPH_IN = -10;
const DROPPED = new Set(["Note", "MarkdownNote", "Reroute", "PrimitiveStringMultiline", "PrimitiveNode"]);
/** Text boxes whose value goes into the input they feed. */
const INLINED = new Set(["PrimitiveStringMultiline", "PrimitiveNode"]);
const CONTROL_WORDS = new Set(["fixed", "increment", "decrement", "randomize"]);
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
/** Widget kinds that hold a saved value this file cannot turn into API inputs (a dynamic combo brings inputs of its own). */
const UNREAD_WIDGETS = new Set(["COMFY_DYNAMICCOMBO_V3", "COLOR"]);

interface Link { readonly origin: number; readonly originSlot: number }
interface UiInput { readonly name: string; readonly type?: string; readonly link?: number | null; readonly widget?: { readonly name: string } }
interface UiOutput { readonly type?: string }
interface UiNode {
  readonly id: number;
  readonly type: string;
  readonly mode: number;
  readonly inputs: readonly UiInput[];
  readonly outputs: readonly UiOutput[];
  readonly values: readonly unknown[] | Readonly<Record<string, unknown>>;
  readonly properties: Readonly<Record<string, unknown>>;
}
interface Definition {
  readonly name: string;
  readonly inputs: readonly { readonly name: string; readonly type?: string }[];
  readonly outputs: readonly { readonly linkIds: readonly number[] }[];
  readonly nodes: readonly UiNode[];
  readonly links: ReadonlyMap<number, Link>;
}
/** One graph level: the root, or one subgraph instance opened in place. */
interface Scope {
  readonly path: string;
  readonly nodes: ReadonlyMap<number, UiNode>;
  readonly links: ReadonlyMap<number, Link>;
  readonly inside?: { readonly definition: Definition; readonly instance: UiNode; readonly parent: Scope };
}
type Source = { readonly ref: readonly [string, number] } | { readonly value: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const notWorkflow = () => new WorkflowRefusal("Not a ComfyUI workflow.");

function readNode(raw: unknown): UiNode {
  if (!isObject(raw) || typeof raw["id"] !== "number" || typeof raw["type"] !== "string") throw notWorkflow();
  const inputs = Array.isArray(raw["inputs"]) ? raw["inputs"].filter(isObject).map((i): UiInput => ({
    name: typeof i["name"] === "string" ? i["name"] : "",
    ...typeof i["type"] === "string" ? { type: i["type"] } : {},
    link: typeof i["link"] === "number" ? i["link"] : null,
    ...isObject(i["widget"]) && typeof i["widget"]["name"] === "string" ? { widget: { name: i["widget"]["name"] } } : {},
  })) : [];
  const outputs = Array.isArray(raw["outputs"]) ? raw["outputs"].map((o): UiOutput => isObject(o) && typeof o["type"] === "string" ? { type: o["type"] } : {}) : [];
  const values = raw["widgets_values"];
  return {
    id: raw["id"], type: raw["type"], mode: typeof raw["mode"] === "number" ? raw["mode"] : 0, inputs, outputs,
    values: Array.isArray(values) || isObject(values) ? values : [],
    properties: isObject(raw["properties"]) ? raw["properties"] : {},
  };
}

/** Root links are arrays `[id, origin, originSlot, target, targetSlot, type]`; subgraph links are objects. Either is read in either place. */
function readLinks(raw: unknown): Map<number, Link> {
  const out = new Map<number, Link>();
  for (const l of Array.isArray(raw) ? raw : []) {
    if (Array.isArray(l) && typeof l[0] === "number" && typeof l[1] === "number" && typeof l[2] === "number") out.set(l[0], { origin: l[1], originSlot: l[2] });
    else if (isObject(l) && typeof l["id"] === "number" && typeof l["origin_id"] === "number" && typeof l["origin_slot"] === "number") out.set(l["id"], { origin: l["origin_id"], originSlot: l["origin_slot"] });
  }
  return out;
}

function readDefinitions(workflow: Record<string, unknown>): Map<string, Definition> {
  const out = new Map<string, Definition>();
  const list = isObject(workflow["definitions"]) ? workflow["definitions"]["subgraphs"] : undefined;
  for (const d of Array.isArray(list) ? list : []) {
    if (!isObject(d) || typeof d["id"] !== "string" || !Array.isArray(d["nodes"])) continue;
    out.set(d["id"], {
      name: typeof d["name"] === "string" && d["name"] !== "" ? d["name"] : "A subgraph",
      inputs: Array.isArray(d["inputs"]) ? d["inputs"].map((i) => ({
        name: isObject(i) && typeof i["name"] === "string" ? i["name"] : "",
        ...isObject(i) && typeof i["type"] === "string" ? { type: i["type"] } : {},
      })) : [],
      outputs: Array.isArray(d["outputs"]) ? d["outputs"].map((o) => ({ linkIds: isObject(o) && Array.isArray(o["linkIds"]) ? o["linkIds"].filter((n): n is number => typeof n === "number") : [] })) : [],
      nodes: d["nodes"].map(readNode),
      links: readLinks(d["links"]),
    });
  }
  return out;
}

/** True for a file already in API format: every entry names a class and has inputs. */
function isApiGraph(raw: Record<string, unknown>): boolean {
  const entries = Object.values(raw);
  return entries.length > 0 && entries.every((e) => isObject(e) && typeof e["class_type"] === "string" && isObject(e["inputs"]));
}

interface WidgetSpec { readonly name: string; readonly kind: string; readonly control: boolean; readonly upload: boolean; readonly fallback: unknown }

/**
 * The inputs a node class shows as widgets, in /object_info's order: required, then optional.
 * Throws when one is of a kind whose saved value cannot be read (UNREAD_WIDGETS).
 */
function widgetSpecs(node: UiNode, spec: Record<string, unknown>): WidgetSpec[] {
  const input = isObject(spec["input"]) ? spec["input"] : {};
  const order = isObject(spec["input_order"]) ? spec["input_order"] : {};
  const out: WidgetSpec[] = [];
  for (const group of ["required", "optional"] as const) {
    const defs = isObject(input[group]) ? input[group] : {};
    const names = Array.isArray(order[group]) ? order[group].filter((n): n is string => typeof n === "string") : Object.keys(defs);
    for (const name of names) {
      const def = defs[name];
      if (!Array.isArray(def)) continue;
      const opts = isObject(def[1]) ? def[1] : {};
      const kind = Array.isArray(def[0]) ? "COMBO" : typeof def[0] === "string" ? def[0] : "";
      if (UNREAD_WIDGETS.has(kind)) {
        throw new WorkflowRefusal(`${node.type} has a setting this app cannot read yet: ${name} (${kind}).`);
      }
      if (!WIDGET_TYPES.has(kind) || opts["forceInput"] === true) continue;
      const choices = Array.isArray(def[0]) ? def[0] : Array.isArray(opts["options"]) ? opts["options"] : [];
      out.push({
        name, kind,
        control: opts["control_after_generate"] !== undefined && opts["control_after_generate"] !== false,
        upload: opts["image_upload"] === true || opts["video_upload"] === true || opts["audio_upload"] === true,
        fallback: opts["default"] ?? (kind === "COMBO" ? choices[0] : undefined),
      });
    }
  }
  return out;
}

const fitsKind = (kind: string, v: unknown) =>
  kind === "INT" || kind === "FLOAT" ? typeof v === "number" : kind === "BOOLEAN" ? typeof v === "boolean" : kind === "STRING" ? typeof v === "string" : typeof v === "string" || typeof v === "number";

/**
 * A node's saved widget values by input name. Throws when they do not line up with the class's
 * inputs: a value of the wrong kind, or values left over once every input has one. A class with
 * no widgets at all keeps nothing it runs on in its values (a preview's shown text), so they are
 * not read.
 */
function widgetValues(node: UiNode, spec: Record<string, unknown>): Record<string, unknown> {
  const specs = widgetSpecs(node, spec);
  const out: Record<string, unknown> = {};
  if (!Array.isArray(node.values)) {
    const byName = node.values as Readonly<Record<string, unknown>>;
    for (const s of specs) {
      const v = byName[s.name] ?? s.fallback;
      if (v !== undefined) out[s.name] = v;
    }
    return out;
  }
  const values = node.values;
  let i = 0;
  for (const s of specs) {
    if (i >= values.length) {
      if (s.fallback !== undefined) out[s.name] = s.fallback;
      continue;
    }
    const v = values[i++];
    if (!fitsKind(s.kind, v)) throw new WorkflowRefusal(`${node.type}'s saved values do not match the inputs ComfyUI lists for it (${s.name}).`);
    out[s.name] = v;
    // the control word after a seed, and an upload combo's upload value, are editor state
    if (s.control && typeof values[i] === "string" && CONTROL_WORDS.has(values[i] as string)) i++;
    else if (s.upload && i < values.length) i++;
  }
  if (specs.length > 0 && i < values.length) throw new WorkflowRefusal(`${node.type}'s saved values do not match the inputs ComfyUI lists for it (${values.length - i} left over).`);
  return out;
}

interface Promoted { readonly byInput: ReadonlyMap<string, unknown>; readonly byWidget: ReadonlyMap<string, unknown> }

/**
 * The values an instance gives its subgraph's widgets. Two formats:
 * - newer: `properties.proxyWidgets` lists `[inner node id, widget]` (`-1` for a subgraph input),
 *   and `widgets_values` holds each one's value at the same place;
 * - older (no `proxyWidgets`): `widgets_values` holds a value for each subgraph input the instance
 *   shows as a widget, in the subgraph's input order: every input it has no socket for, and every
 *   socket marked as a widget (its value is used when nothing is linked to it). A seed may be
 *   followed by its control word. Throws when the values do not line up with those inputs.
 */
function promoted(instance: UiNode, definition: Definition): Promoted {
  const byInput = new Map<string, unknown>(), byWidget = new Map<string, unknown>();
  const proxies = instance.properties["proxyWidgets"];
  const values = instance.values;
  if (!Array.isArray(values) || values.length === 0) return { byInput, byWidget };
  if (!Array.isArray(proxies)) {
    const refuse = (why: string) => new WorkflowRefusal(`${definition.name}'s saved values do not match its inputs (${why}).`);
    let i = 0;
    for (const input of definition.inputs) {
      const socket = instance.inputs.find((s) => s.name === input.name);
      if (socket !== undefined && socket.widget === undefined) continue;
      const kind = input.type ?? "";
      if (!WIDGET_TYPES.has(kind)) throw refuse(`${input.name} is a ${kind || "socket of no kind"}`);
      if (i >= values.length) throw refuse(`no value for ${input.name}`);
      const value = values[i++];
      if (!fitsKind(kind, value)) throw refuse(input.name);
      byInput.set(input.name, value);
      if (kind === "INT" && typeof values[i] === "string" && CONTROL_WORDS.has(values[i] as string)) i++;
    }
    if (i < values.length) throw refuse(`${values.length - i} left over`);
    return { byInput, byWidget };
  }
  proxies.forEach((p, j) => {
    if (!Array.isArray(p) || typeof p[1] !== "string" || p[1] === "control_after_generate") return;
    const value: unknown = values[j];
    if (value === undefined || value === null) return;
    if (String(p[0]) === "-1") byInput.set(p[1], value);
    else byWidget.set(`${String(p[0])}:${p[1]}`, value);
  });
  return { byInput, byWidget };
}

/** An API input that is a link: [node id, output slot]. */
const isRef = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number";

/** Refuses, by name and once each, the classes `info` does not list. */
function refuseUnknown(classes: readonly string[], info: ObjectInfo): void {
  const missing = [...new Set(classes.filter((c) => !isObject(info[c])))];
  if (missing.length > 0) throw new WorkflowRefusal(`Needs a node this ComfyUI does not have: ${missing.toSorted().join(", ")} (a custom node, or one from a newer ComfyUI).`);
}

/**
 * The API graph for a workflow file in either format. Throws WorkflowRefusal, in words for the
 * picker, when the file is neither format, saves nothing, needs a node class `info` does not list,
 * or has widget values that do not line up.
 */
export function convertWorkflow(workflow: unknown, info: ObjectInfo): ApiGraph {
  if (!isObject(workflow)) throw notWorkflow();
  if (!Array.isArray(workflow["nodes"])) {
    if (!isApiGraph(workflow)) throw notWorkflow();
    const graph = structuredClone(workflow) as ApiGraph;
    refuseUnknown(Object.values(graph).map((n) => n.class_type), info);
    return graph;
  }
  const definitions = readDefinitions(workflow);
  const root: Scope = { path: "", nodes: new Map(workflow["nodes"].map(readNode).map((n) => [n.id, n])), links: readLinks(workflow["links"]) };
  let depth = 0;
  const guard = <T>(run: () => T): T => {
    if (++depth > 500) throw new WorkflowRefusal("Its links go round in a loop.");
    try { return run(); } finally { depth--; }
  };

  const promotions = new Map<UiNode, Promoted>();
  const promotedOf = (instance: UiNode, definition: Definition): Promoted => {
    let found = promotions.get(instance);
    if (found === undefined) promotions.set(instance, found = promoted(instance, definition));
    return found;
  };

  const open = (scope: Scope, instance: UiNode, definition: Definition): Scope =>
    ({ path: `${scope.path}${instance.id}:`, nodes: new Map(definition.nodes.map((n) => [n.id, n])), links: definition.links, inside: { definition, instance, parent: scope } });

  const fromLink = (scope: Scope, linkId: number | null | undefined): Source | undefined => {
    const link = linkId === null || linkId === undefined ? undefined : scope.links.get(linkId);
    if (link === undefined) return undefined;
    return guard(() => link.origin === SUBGRAPH_IN ? fromSubgraphInput(scope, link.originSlot) : fromOutput(scope, link.origin, link.originSlot));
  };

  /** What feeds the subgraph input at `slot` of the instance this scope opens: its link outside, else a promoted value. */
  const fromSubgraphInput = (scope: Scope, slot: number): Source | undefined => {
    if (scope.inside === undefined) return undefined;
    const { definition, instance, parent } = scope.inside;
    const name = definition.inputs[slot]?.name;
    const input = instance.inputs.find((i) => i.name === name) ?? (instance.inputs.length === definition.inputs.length ? instance.inputs[slot] : undefined);
    const linked = fromLink(parent, input?.link);
    if (linked !== undefined) return linked;
    const value = name === undefined ? undefined : promotedOf(instance, definition).byInput.get(name);
    return value === undefined ? undefined : { value };
  };

  const fromInput = (scope: Scope, node: UiNode, index: number): Source | undefined => fromLink(scope, node.inputs[index]?.link);

  /** A switch's setting when the file fixes it: what feeds it, a value set on its instance, else its own; undefined when a node computes it. */
  const switchOf = (scope: Scope, node: UiNode): boolean | undefined => {
    const fed = fromInput(scope, node, node.inputs.findIndex((i) => (i.widget?.name ?? i.name) === "switch"));
    if (fed !== undefined) return "value" in fed && typeof fed.value === "boolean" ? fed.value : undefined;
    const set = scope.inside === undefined ? undefined : promotedOf(scope.inside.instance, scope.inside.definition).byWidget.get(`${node.id}:switch`);
    const own = Array.isArray(node.values) ? node.values[0] : (node.values as Readonly<Record<string, unknown>>)["switch"];
    const value = set ?? own;
    return typeof value === "boolean" ? value : undefined;
  };

  /** What output `slot` of node `id` gives once subgraphs, reroutes, text boxes and bypasses are seen through. */
  const fromOutput = (scope: Scope, id: number, slot: number): Source | undefined => {
    const node = scope.nodes.get(id);
    if (node === undefined || node.mode === MUTED) return undefined;
    if (node.mode === BYPASSED) {
      const type = node.outputs[slot]?.type;
      const order = [slot, ...node.inputs.keys()].filter((i) => node.inputs[i] !== undefined && (type === undefined || node.inputs[i]!.type === type));
      for (const i of order) {
        const source = fromInput(scope, node, i);
        if (source !== undefined) return source;
      }
      return undefined;
    }
    const definition = definitions.get(node.type);
    if (definition !== undefined) {
      const inner = open(scope, node, definition);
      for (const linkId of definition.outputs[slot]?.linkIds ?? []) {
        const source = fromLink(inner, linkId);
        if (source !== undefined) return source;
      }
      return undefined;
    }
    if (node.type === "Reroute") return fromInput(scope, node, 0);
    const on = node.type === "ComfySwitchNode" ? switchOf(scope, node) : undefined;
    if (on !== undefined) return fromInput(scope, node, node.inputs.findIndex((i) => i.name === (on ? "on_true" : "on_false")));
    if (INLINED.has(node.type)) {
      const fed = node.inputs.findIndex((i) => (i.widget?.name ?? i.name) === "value" && i.link !== null);
      if (fed >= 0) return fromInput(scope, node, fed);
      const values = node.values;
      return { value: Array.isArray(values) ? values[0] : (values as Readonly<Record<string, unknown>>)["value"] };
    }
    return { ref: [`${scope.path}${node.id}`, slot] };
  };

  const graph: ApiGraph = {};
  const unknown = new Map<string, string>(); // api id -> class ComfyUI does not list
  const outputs: string[] = [];
  const emit = (scope: Scope, overrides: ReadonlyMap<string, unknown>) => {
    for (const node of scope.nodes.values()) {
      if (node.mode === MUTED || node.mode === BYPASSED || DROPPED.has(node.type)) continue;
      const definition = definitions.get(node.type);
      if (definition !== undefined) {
        emit(open(scope, node, definition), promotedOf(node, definition).byWidget);
        continue;
      }
      const id = `${scope.path}${node.id}`;
      const spec = info[node.type];
      const inputs: Record<string, unknown> = {};
      if (isObject(spec)) {
        Object.assign(inputs, widgetValues(node, spec));
        for (const [key, value] of overrides) {
          const [owner, widget] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
          if (owner === String(node.id) && widget in inputs) inputs[widget] = value;
        }
        if (spec["output_node"] === true) outputs.push(id);
      } else unknown.set(id, node.type);
      node.inputs.forEach((input, i) => {
        const source = fromInput(scope, node, i);
        if (source === undefined) return;
        inputs[input.widget?.name ?? input.name] = "ref" in source ? [...source.ref] : source.value;
      });
      graph[id] = { class_type: node.type, inputs };
    }
  };
  emit(root, new Map());

  // keep what an output reads from. A node of a class ComfyUI does not list, that reads from other
  // nodes and that nothing reads from, may be where the workflow saves its picture: it is kept, so
  // the refusal names it, rather than dropped.
  const read = new Set(Object.values(graph).flatMap((n) => Object.values(n.inputs).filter(isRef).map((v) => v[0])));
  const sinks = [...unknown.keys()].filter((id) => !read.has(id) && Object.values(graph[id]!.inputs).some(isRef));
  const kept = new Set<string>();
  const queue = [...outputs, ...sinks];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (kept.has(id) || graph[id] === undefined) continue;
    kept.add(id);
    for (const v of Object.values(graph[id].inputs)) if (isRef(v)) queue.push(v[0]);
  }
  refuseUnknown([...unknown].filter(([id]) => outputs.length === 0 || kept.has(id)).map(([, type]) => type), info);
  if (outputs.length === 0) throw new WorkflowRefusal("Saves no image: it has no output node.");
  return Object.fromEntries(Object.entries(graph).filter(([id]) => kept.has(id)));
}

// Writes TLA+ values as text, for the modules the models read their tables from.

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A name used as a TLA+ record field. Fails on a name TLA+ cannot hold as one. */
export function field(name: string): string {
  if (!NAME.test(name)) throw new Error(`"${name}" cannot be a TLA+ record field`);
  return name;
}

export const text = (s: string): string => `"${field(s)}"`;
export const bool = (b: boolean): string => (b ? "TRUE" : "FALSE");
export const set = (items: Iterable<string>): string => `{${[...items].toSorted().join(", ")}}`;
export const tuple = (items: readonly string[]): string => `<<${items.join(", ")}>>`;

/** A TLA+ record, which is also a function from its field names as strings. An empty one is the empty function. */
export function record(fields: Readonly<Record<string, string>>, between = ", "): string {
  const parts = Object.entries(fields).map(([k, v]) => `${field(k)} |-> ${v}`);
  return parts.length === 0 ? "<<>>" : `[${parts.join(between)}]`;
}

export function moduleText(name: string, from: string, extend: readonly string[], definitions: Readonly<Record<string, string>>): string {
  const body = Object.entries(definitions).map(([k, v]) => `${field(k)} ==\n  ${v}\n`);
  return [
    `---- MODULE ${name} ----`,
    `\\* Written by ${from} from the product code. Not kept in the repository: every run writes it again.`,
    ...(extend.length === 0 ? [] : [`EXTENDS ${extend.join(", ")}`]),
    "",
    ...body,
    "====",
    "",
  ].join("\n");
}

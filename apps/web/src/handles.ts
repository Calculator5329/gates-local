// Stable test identities (data-testid, area.component.element). A control drawn
// once per item (a model, a source, a thread) takes the item's key as its last
// part; this keeps that part in the identity grammar (lowercase kebab-case).

/** `qwen3.5:4b` -> `qwen3-5-4b`, for the last part of an item's identity. */
export const handleKey = (key: string | number): string =>
  String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "none";

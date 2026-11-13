// Where the finder writes: finder-report/ in the checkout (gitignored), or GL_FINDER_OUT.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FINDER_OUT = path.resolve(process.env["GL_FINDER_OUT"] ?? path.join(ROOT, "finder-report"));

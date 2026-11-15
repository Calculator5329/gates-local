// `pnpm feature-map`: writes docs/feature-map.md from test/feature-map.ts.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { PAGE, render } from "../test/feature-map-page.ts";

writeFileSync(path.join(import.meta.dirname, "..", PAGE), render());
console.log(`wrote ${PAGE}`);

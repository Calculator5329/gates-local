// Ports, paths and the per-run token the E2E stack, config and specs share.
// The token is made once in the Playwright main process and inherited by the
// stack and every worker through the environment, so it never lands on disk.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVER_PORT = 5286;
export const WEB_PORT = 5287;
export const FAKE_PORT = 5288;
export const CONTROL_PORT = 5289;

export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
export const CONTROL_URL = `http://127.0.0.1:${CONTROL_PORT}`;

/**
 * This checkout's own folder under ~/.cache/gates-local-e2e, named from its path
 * (~/projects/ai/gates-local gives "projects-ai-gates-local"), so two checkouts
 * never share E2E data or results.
 */
export const CHECKOUT_CACHE = path.join(homedir(), ".cache", "gates-local-e2e", checkoutKey(ROOT));

export function checkoutKey(root: string): string {
  const rel = path.relative(homedir(), root);
  const inHome = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  return (inHome ? rel : root).replaceAll(/[^A-Za-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "root";
}

/** Fresh data dirs go under here, one per stack reset. */
export const DATA_ROOT = process.env["GL_E2E_DATA_ROOT"] ?? path.join(CHECKOUT_CACHE, "e2e-data");
/** Traces and failure screenshots. */
export const RESULTS_DIR = process.env["GL_E2E_RESULTS"] ?? path.join(CHECKOUT_CACHE, "e2e-results");
/** Where `pnpm e2e:shots` writes its PNGs. */
export const SHOTS_DIR = process.env["GL_E2E_SHOTS_DIR"] ?? path.join(homedir(), ".cache/gates-local-design/rounds/app-1/shots");

process.env["GL_E2E_TOKEN"] ??= randomUUID();
export const TOKEN = process.env["GL_E2E_TOKEN"];

/** The client URL: the preview build with the server address in ?server=. */
export function appUrl(hash = ""): string {
  const server = `ws://127.0.0.1:${SERVER_PORT}/?token=${TOKEN}`;
  return `${WEB_ORIGIN}/?server=${encodeURIComponent(server)}${hash}`;
}

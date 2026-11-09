import { CLIENT_ORIGIN, originOf } from "./client-protocol.ts";

/** Microphone only, for our top-level client; camera and every other permission stay denied. */
export function allowsMicrophone(page: string, permission: string, requestingOrigin: string, media: readonly string[], mainFrame: boolean): boolean {
  return permission === "media" && mainFrame && originOf(page) === CLIENT_ORIGIN &&
    originOf(requestingOrigin) === CLIENT_ORIGIN && media.length === 1 && media[0] === "audio";
}

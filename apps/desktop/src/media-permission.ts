import { CLIENT_ORIGIN, originOf } from "./client-protocol.ts";

export function allowsMicrophone(page: string, permission: string, requestingOrigin: string, media: readonly string[], mainFrame: boolean): boolean {
  return permission === "media" && mainFrame && originOf(page) === CLIENT_ORIGIN &&
    originOf(requestingOrigin) === CLIENT_ORIGIN && media.length === 1 && media[0] === "audio";
}

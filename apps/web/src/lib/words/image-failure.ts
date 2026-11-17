export interface Failed {
  readonly message: string;
  readonly why?: string;
}

// why: the image module's own sentences, each turned into a reason and what to do next
const KNOWN: readonly (readonly [RegExp, string, string])[] = [
  [/without credentials or query parameters/i, "the ComfyUI address has a user name, password or query in it", "set a plain address in Settings › Images"],
  [/not ready yet|is still starting/i, "ComfyUI is still starting", "try again in a moment"],
  [/Start ComfyUI on this computer first/i, "ComfyUI isn't running on this computer", "start it first"],
  [/^Nothing of .* is downloading/i, "it had already ended", "nothing is left to stop"],
  [/already running; it finishes first/i, "another model is downloading", "wait for it to finish"],
  [/Not enough disk space/i, "the drive is short of space", "free some space, then download it again"],
  [/download stopped at/i, "the download stopped partway", "download it again to carry on"],
  [/is not the file expected|sha256|checksum/i, "the file couldn't be verified", "download it again"],
  [/answered \d{3}|did not say its size|redirected|sent more than|Hugging Face only/i, "the download site didn't answer as expected", "try again later"],
  [/has no download address/i, "a file has no download address", "put it in ComfyUI's model folders yourself"],
  [/where its models go|which folder/i, "ComfyUI hasn't said where its models go", "pick a folder for the image files"],
  [/Image generation is off|turned off/i, "image generation is off", "turn it on in Settings › Images"],
  [/shutting down/i, "Gates Local is shutting down", "try again once it restarts"],
];

export const said = (failed: Failed | null): string | null => failed?.message ?? null;

export function imageFailure(what: string, raw: string): Failed {
  const known = KNOWN.find(([pattern]) => pattern.test(raw));
  const [reason, todo] = known === undefined ? ["the image setup ran into a problem", "try again"] : [known[1], known[2]];
  return { message: `Couldn't ${what} because ${reason}; ${todo}.`, why: raw };
}

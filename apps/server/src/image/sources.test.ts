// Reading the workflows ComfyUI has through its own routes, answered here from the test fixtures.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comfyInfo, SDXL_FILES } from "../../test/comfy/info.ts";
import { modelSources, readSaved, readTemplates } from "./sources.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../test/comfy/${name}`, import.meta.url), "utf8"));
const info = comfyInfo(SDXL_FILES);

/** A ComfyUI that answers these routes and fails every other, recording each route asked. */
function comfy(routes: Record<string, unknown>) {
  const asked: string[] = [];
  const get = async (route: string) => {
    asked.push(route);
    if (!(route in routes)) throw new Error(`ComfyUI ${route} returned HTTP 404.`);
    return routes[route];
  };
  return { get, asked };
}

describe("ComfyUI's templates", () => {
  const templates = {
    "/templates/index.json": fixture("template-index.json"),
    "/templates/image_flux2_klein_text_to_image.json": fixture("templates/image_flux2_klein_text_to_image.json"),
    "/templates/image_sdxl_simple.json": fixture("templates/image_sdxl_simple.json"),
  };

  it("keeps the picture templates that start from words and run here, once each, by their title", async () => {
    const { get, asked } = comfy(templates);
    const read = await readTemplates(get, info);
    expect(read?.map((w) => [w.id, w.name, w.group])).toEqual([
      ["template:image_flux2_klein_text_to_image", "FLUX.2 [Klein] 4B: Text to Image", "ComfyUI templates"],
      ["template:image_sdxl_simple", "SDXL Simple", "ComfyUI templates"],
    ]);
    // never fetched: one that starts from a picture, a paid cloud model, a video; one listed but missing is dropped
    expect(asked.toSorted()).toEqual(["/templates/image_flux2_klein_text_to_image.json", "/templates/image_gone.json", "/templates/image_sdxl_simple.json", "/templates/index.json"]);
  });

  it("keeps each as the graph ComfyUI runs, or the reason it cannot run", async () => {
    const read = await readTemplates(comfy(templates).get, info);
    expect(read?.[1]?.graph).toEqual(fixture("api/image_sdxl_simple.json"));
    // a ComfyUI without one of Klein's node classes
    const without = structuredClone(info); delete without["EmptyFlux2LatentImage"];
    expect((await readTemplates(comfy(templates).get, without))?.[0]).toMatchObject({ why: expect.stringContaining("EmptyFlux2LatentImage") });
  });

  it("no template list (no templates package, or an older ComfyUI) is not an empty one", async () => {
    expect(await readTemplates(comfy({}).get, info)).toBeUndefined();
  });

  it("where each file comes from is read from the loaders' properties.models, inside subgraphs too", () => {
    expect(modelSources(fixture("templates/image_flux2_klein_text_to_image.json"))).toEqual({
      "flux-2-klein-base-4b.safetensors": { directory: "diffusion_models", url: "https://huggingface.co/Comfy-Org/flux2-klein/resolve/main/split_files/diffusion_models/flux-2-klein-base-4b.safetensors" },
      "flux-2-klein-4b.safetensors": { directory: "diffusion_models", url: "https://huggingface.co/Comfy-Org/flux2-klein/resolve/main/split_files/diffusion_models/flux-2-klein-4b.safetensors" },
      "qwen_3_4b.safetensors": { directory: "text_encoders", url: "https://huggingface.co/Comfy-Org/flux2-klein/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors" },
      "flux2-vae.safetensors": { directory: "vae", url: "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors" },
    });
  });
});

describe("the person's saved workflows", () => {
  const list = "/userdata?dir=workflows&recurse=true&split=false&full_info=false";

  it("keeps every saved .json by its name, subfolders included, and why one cannot run", async () => {
    const { get, asked } = comfy({
      [list]: ["portrait.json", "sub/pixel.json", "notes.txt", "broken.json"],
      "/userdata/workflows%2Fportrait.json": fixture("templates/image_sdxl_simple.json"),
      "/userdata/workflows%2Fsub%2Fpixel.json": fixture("api/image_sdxl_simple.json"),
      "/userdata/workflows%2Fbroken.json": { nodes: "not a list" },
    });
    const read = await readSaved(get, info);
    expect(read?.map((w) => [w.id, w.name, w.group, w.why])).toEqual([
      ["saved:portrait.json", "portrait", "Your workflows", undefined],
      ["saved:sub/pixel.json", "sub/pixel", "Your workflows", undefined],
      ["saved:broken.json", "broken", "Your workflows", "Not a ComfyUI workflow."],
    ]);
    expect(asked).not.toContain("/userdata/workflows%2Fnotes.txt");
  });

  it("no list is not an empty one", async () => {
    expect(await readSaved(comfy({}).get, info)).toBeUndefined();
  });
});

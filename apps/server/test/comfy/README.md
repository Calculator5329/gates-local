# ComfyUI fixtures

- `templates/image_flux2_klein_text_to_image.json`, `image_sdxl_simple.json` and
  `image_z_image_turbo.json` are ComfyUI's own workflow templates, copied byte for byte from the
  `comfyui-workflow-templates` package 0.11.106 (MIT, Comfy Org; `templates/LICENSE`). Klein and
  Z-Image use subgraphs; Klein also has a bypassed second branch and a multiline text box.
- `templates/image_minimax_h3_t2i.json` is the same package's MiniMax H3 template with the
  editor-only fields taken out (positions, sizes, notes, groups, `widgets_values_named`,
  `localized_name`); every node, link and value is kept. Its subgraph instance is in the older
  format, with no `proxyWidgets`: the instance's own values (30 steps, its prompt and seed) must
  win over the inner nodes' (8 steps, a red panda, seed 0).
- `templates/subgraph-case.json` was written for these tests: a subgraph nested in a subgraph,
  two instances of one subgraph, a value promoted onto an instance, a reroute, a note, a text box,
  a bypassed LoRA loader and a muted preview.
- `object-info.json` is the `/object_info` answer of ComfyUI 0.45.0 for the node classes these
  files use, read from a copy started for this on the CPU with no models, custom nodes or GPU.
  Its file lists are empty; tests that need files fill them in. The entries written on one line
  each (BasicGuider to SaveImageAdvanced) carry only the fields the converter reads, with
  tooltips and descriptions taken out and SaveImageAdvanced's format options cut to `png`.
- `api/*.json` are the API graphs each file should convert to. They were written by hand from
  the workflow file and `object-info.json`, not exported from ComfyUI's editor, so they show
  what this repository expects, not what ComfyUI's own converter gives. One choice in them: an
  input that is newer than the saved file (Z-Image's `ModelSamplingAuraFlow.sampling`) takes its
  default, as ComfyUI's editor shows it on loading such a file.

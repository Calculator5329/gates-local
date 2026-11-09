// Shared by the real-server streaming probe and the standalone reveal lab.
// A fake token is a whitespace-delimited piece, not a model/BPE token.
export const STREAM_REPLY = [
  "## A careful local model download",
  "",
  "Start with **free disk space** and the model's download size. Keep the context cache in mind before you press Download. A fast GPU cannot make up for a full disk.",
  "",
  "- Check the space on the destination drive.",
  "- Compare the download sizes in the table below.",
  "- Leave room for your documents and context cache.",
  "",
  "```sh",
  "df -h /",
  "du -sh ~/.ollama/models",
  ...Array.from({ length: 16 }, (_, i) => `printf 'Check ${i + 1}: leave enough free space for the model and its context cache\\n'`),
  "```",
  "",
  "| Model | Download | Context |",
  "| --- | --- | --- |",
  "| Gemma 4 12B | 8.1 GB | 16k |",
  "| Qwen 3.5 9B | 6.6 GB | 16k |",
  "",
  "> A download that fits on disk still needs a separate GPU memory check.",
  "",
  "## Why the check matters",
  "",
  ...Array.from({ length: 3 }, (_, i) => `Pass ${i + 1}. Read the available space, compare it with the download, and leave some breathing room. **Keep the original files** until the new model works. A smaller download can be the more useful choice when it lets you keep a larger context without spilling into system memory.\n`),
  // Deliberately crosses the renderer's 2,000-character safety valve while
  // emphasis is unfinished. This is where raw delimiters can flash.
  "Check free space before starting the download and keep the original model available ".repeat(23) + "**" + "a long emphasized warning about keeping space available ".repeat(9) + "**. Then compare the available space again.",
  "",
  "A final sentence ends the reply without an extra blank line.",
].join("\n");

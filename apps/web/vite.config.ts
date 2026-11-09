import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the packaged desktop app can load the build from file://
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // One gzip dictionary for the initial graph, another for deferred UI.
        // The first group captures only static dependencies of the entry.
        codeSplitting: { groups: [
          { name: "shell", tags: ["$initial"] },
          // The microphone control cannot pull Settings into startup, and the
          // actual audio capture code waits for the first microphone press.
          { name: "voice", test: /apps[\\/]web[\\/]src[\\/](?:Voice\.tsx|draft-insertion\.ts)$/ },
          { name: "voice-audio", test: /apps[\\/]web[\\/]src[\\/]voice-audio\.ts$/ },
          { name: "screens", test: /apps[\\/]web[\\/]src[\\/]/ },
        ] },
      },
    },
  },
});

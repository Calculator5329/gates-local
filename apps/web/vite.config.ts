import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the packaged desktop app can load the build from file://
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rolldownOptions: {
      // Unused schema factory arguments read plain exported values. Keeping
      // those unused reads retains date/network/cookie schemas the wire never uses.
      treeshake: { propertyReadSideEffects: false },
      output: {
        // One gzip dictionary for the initial graph, another for deferred UI.
        // The first group captures only static dependencies of the entry.
        codeSplitting: { groups: [
          { name: "shell", tags: ["$initial"] },
          // Settings warming must not pull the conversation renderer back into
          // startup. Its clipboard helper is shared through the startup group.
          { name: "conversation", includeDependenciesRecursively: false, test: /apps[\\/]web[\\/]src[\\/](?:Thread\.tsx|markdown\.tsx|paced\.ts|reveal\.ts|image-links\.ts|pages[\\/][\w-]+\.(?:tsx?|css))$/ },
          // Picker CSS stays with the pickers (the image picker shares it), outside idle-warmed screens.
          { name: "picker", includeDependenciesRecursively: false, test: /apps[\\/]web[\\/]src[\\/](?:(?:Image)?Picker\.tsx|(?:image-)?picker\.css)$/ },
          { name: "screens", test: /apps[\\/]web[\\/]src[\\/]/ },
        ] },
      },
    },
  },
});

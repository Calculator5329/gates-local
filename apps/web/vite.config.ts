import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the packaged desktop app can load the build from file://
export default defineConfig({ base: "./", plugins: [react()] });

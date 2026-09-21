import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localTestPort = 4173;

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: localTestPort, strictPort: true },
  preview: { port: localTestPort, strictPort: true },
});

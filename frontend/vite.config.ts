import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localTestPort = 4173;

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [react(), {
    name: "desktop-content-security-policy",
    transformIndexHtml() {
      // The desktop loads the built file; leave Vite's development HMR intact.
      if (command !== "build") return [];
      return [{ tag: "meta", attrs: {
        "http-equiv": "Content-Security-Policy",
        content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' file: data: blob: https: http:; media-src 'self' file: blob: https: http:; font-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      }, injectTo: "head-prepend" }];
    },
  }],
  build: {
    outDir: "dist", emptyOutDir: true, sourcemap: false,
    rollupOptions: { output: { manualChunks(id) {
      if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
    } } },
  },
  server: { port: localTestPort, strictPort: true },
  preview: { port: localTestPort, strictPort: true },
}));

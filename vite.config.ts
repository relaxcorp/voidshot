import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri drives the dev server, so fail loudly instead of hopping ports.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // WebView2 and modern WebKitGTK both handle esnext; no need to downlevel.
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pin: resolve(__dirname, "pin.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});

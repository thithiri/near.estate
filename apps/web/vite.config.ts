import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  plugins: [
    nodePolyfills({
      include: ["buffer", "util"],
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
});

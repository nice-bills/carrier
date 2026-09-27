// Browser preview of the app (served from app/index.html) on in-memory fakes (see ../demo.ts and
// src/demo/script.ts for the `?screen=` options). Not the shipping build:
// react-native is swapped for react-native-web and device modules never load.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here(".."),
  plugins: [react()],
  resolve: {
    extensions: [".web.tsx", ".web.ts", ".tsx", ".ts", ".mjs", ".js", ".jsx", ".json"],
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      { find: /^expo$/, replacement: here("./expo-stub.ts") },
      { find: /^expo-status-bar$/, replacement: here("./status-bar-stub.ts") },
    ],
  },
  define: { "process.env": {}, __DEV__: "false", global: "globalThis" },
  server: { fs: { allow: [here("../..")] }, port: 5199 },
  optimizeDeps: { include: ["react-native-web", "buffer", "@solana/web3.js", "tweetnacl"] },
});

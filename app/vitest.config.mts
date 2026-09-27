import { defineConfig } from "vitest/config";

// Pure-logic tests only: the pocket, the books, the wire messages and the demo
// device. Nothing here loads a native module; the pocket takes an in-memory
// store and phones are joined by function calls instead of radio.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});

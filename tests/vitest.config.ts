import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration tests run against a validator, so they are slow and are kept out
 * of the unit-test root. `anchor test` boots the validator and points here.
 *
 * `@carrier/protocol` is a workspace package whose entry point is TypeScript
 * source rather than a build artifact — deliberately, so the wire codec the
 * phones use is the exact code under test. Vite does not transform anything
 * under node_modules, and the workspace symlink lands there, so it is aliased
 * straight to source instead.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@carrier/protocol": fileURLToPath(
        new URL("../packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    // A cold validator plus airdrops and mint setup takes a while.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Settlement mutates one shared pouch, so ordering matters.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});

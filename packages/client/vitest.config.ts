import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Building long mesh chains re-verifies every signature at each handoff,
    // which is slow in pure JS. The e2e test (skipped without CARRIER_E2E_RPC)
    // waits on a live endpoint.
    testTimeout: 60_000,
  },
});

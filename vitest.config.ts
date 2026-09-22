import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Browser-side logic (hashing, IndexedDB, sync decisions) in Node.
        test: {
          name: "client",
          include: ["src/client/**/*.test.ts", "src/shared/**/*.test.ts"],
          environment: "node",
          setupFiles: ["fake-indexeddb/auto"],
        },
      },
      {
        // Worker + Durable Object tests inside workerd via Miniflare.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { SESSION_SECRET: "test-session-secret-0123456789abcdef" } },
          }),
        ],
        test: {
          name: "worker",
          include: ["src/worker/**/*.test.ts"],
        },
      },
    ],
  },
});

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
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "worker",
          include: ["src/worker/**/*.test.ts"],
        },
      },
    ],
  },
});

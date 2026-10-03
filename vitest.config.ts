import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fakeLink } from "./src/worker/testing/fakeLink.ts";

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
            miniflare: {
              bindings: {
                SESSION_SECRET: "test-session-secret-0123456789abcdef",
                // The player of anonymous key 0a0a0a0a-0000-4000-8000-00000000ad01 (see admin.test.ts).
                ADMIN_PLAYER_IDS: "181d9f3083935f607dcf771227485d0387bb01c37a1cee06bd76dcf09b93213c",
                // Access tokens in admin.test.ts are signed with a key made in the test.
                ACCESS_TEAM_DOMAIN: "pocket-test.cloudflareaccess.com",
                ACCESS_AUD: "test-access-aud",
              },
              // The link server runs containers; tests talk to an in-memory stand-in.
              serviceBindings: { LINK: fakeLink },
            },
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

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./src/tests/wrangler.jsonc" }
    })
  ],
  test: {
    include: ["src/tests/**/*.test.ts"]
  }
});

import path from "node:path";
import { defineConfig } from "vitest/config";

/** The eval calls the Claude API, so it runs only on demand: `pnpm --filter @browsermcp/mcp eval` */
export default defineConfig({
  // eval/ is outside tsconfig.json's include, so its `@/` paths are set here
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../src") } },
  test: {
    include: ["eval/**/*.eval.ts"],
    testTimeout: 60 * 60_000,
    hookTimeout: 60_000,
  },
});

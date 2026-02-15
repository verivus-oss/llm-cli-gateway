import { configDefaults, defineConfig } from "vitest/config";

const PG_TEST_GLOBS = ["src/__tests__/*-pg.test.ts", "src/__tests__/**/*-pg.test.ts"];
const excludePgTests = process.env.PG_TESTS !== "1";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 30000,
    include: ["src/__tests__/**/*.test.ts"],
    exclude: excludePgTests ? [...configDefaults.exclude, ...PG_TEST_GLOBS] : configDefaults.exclude,
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"]
    }
  }
});

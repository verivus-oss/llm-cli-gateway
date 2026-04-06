import { configDefaults, defineConfig } from "vitest/config";

const PG_TEST_GLOBS = ["src/__tests__/*-pg.test.ts", "src/__tests__/**/*-pg.test.ts"];
const INTEGRATION_TEST_GLOBS = ["src/__tests__/integration.test.ts"];
const excludePgTests = process.env.PG_TESTS !== "1";
const excludeIntegrationTests = process.env.INTEGRATION_TESTS !== "1";

const dynamicExcludes = [
  ...configDefaults.exclude,
  ...(excludePgTests ? PG_TEST_GLOBS : []),
  ...(excludeIntegrationTests ? INTEGRATION_TEST_GLOBS : []),
];

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 30000,
    include: ["src/__tests__/**/*.test.ts"],
    exclude: dynamicExcludes,
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70
      }
    }
  }
});

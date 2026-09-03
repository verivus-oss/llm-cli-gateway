import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import securityPlugin from "eslint-plugin-security";
import { CALLER_INFLUENCED_FS_MODULES } from "./scripts/fs-path-scope.mjs";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "**/*.test.ts",
      // Workflow-tool scripts, not standalone modules: they carry a top-level
      // `return` because the runtime wraps them in a function. ESLint can only
      // report that as a parse error, which is noise rather than a finding.
      "docs/plans/*.workflow.js",
      "docs/plans/*.workflow.mjs",
    ],
  },
  js.configs.recommended,
  {
    // `.github/scripts` runs in CI under Node and was linted by nothing: the
    // lint script scanned `src scripts` only, so 64 of the tree's `no-undef`
    // errors were this config gap rather than defects. One of these fetches
    // release secrets.
    files: [".github/scripts/**/*.{js,mjs}", "docs/plans/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
  },
  {
    // The published site's own JavaScript. It is deployed by direct upload, so
    // nothing else compiles or type-checks it.
    files: ["site/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        console: "readonly",
        document: "readonly",
        localStorage: "readonly",
        matchMedia: "readonly",
        navigator: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    plugins: {
      security: securityPlugin,
    },
    rules: {
      ...securityPlugin.configs["recommended-legacy"].rules,
      "no-var": "error",
      "prefer-const": "error",
      "security/detect-child-process": "off",
      // OFF by default, ON for the modules where a caller-supplied value can
      // reach a path. See scripts/fs-path-scope.mjs for the two provenance
      // classes and scripts/check-fs-path-scope.mjs for the check that keeps
      // them honest against the tree.
      "security/detect-non-literal-fs-filename": "off",
      // OFF everywhere, and this is a measurement rather than a preference.
      // Sampled hits were array indexing (`args[index]`), keys already bounded
      // by a union type (`UPSTREAM_CLI_CONTRACTS[cli]` where cli is CliType),
      // and own-key iteration (`rawSessions[sessionId]` straight out of
      // Object.entries). The one write with a derived key,
      // `pointers[canonicalPointerKey]` in session-manager, is guarded by a
      // canonicaliser that throws on a malformed key. The rule cannot see
      // types, so in this codebase it reports the type system's work as a
      // finding, 392 times.
      "security/detect-object-injection": "off",
    },
  },
  {
    files: ["scripts/**/*.test.mjs"],
    languageOptions: {
      globals: {
        afterEach: "readonly",
        beforeEach: "readonly",
        describe: "readonly",
        expect: "readonly",
        it: "readonly",
        vi: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        global: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      security: securityPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...securityPlugin.configs["recommended-legacy"].rules,
      // TypeScript resolves value and type namespaces, including NodeJS.Timeout.
      // Core no-undef does not understand TypeScript type-only names.
      "no-undef": "off",
      "no-console": ["error", { allow: ["error", "warn"] }],
      "prefer-const": "error",
      // s5: the detector for the defect class the async storage port creates.
      // Two hand-written censuses over the same code found 2 sites; these rules
      // found 66 more, including a fail-closed admission gate that had inverted
      // to fail-open, and seven conditions that had stopped being evaluated
      // because `!promise` is always false. `npm run check` runs lint, so this
      // is a ratchet rather than a convention.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "no-var": "error",
      "security/detect-child-process": "off",
      // The spread above re-enables the security preset for this glob, so both
      // rules are turned off here as well. The caller-influenced modules
      // re-enable the filesystem one in the last block of this file.
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",

      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/naming-convention": [
        "warn",
        {
          selector: "variable",
          modifiers: ["const"],
          format: ["camelCase", "UPPER_CASE", "snake_case"],
        },
      ],
    },
  },
  {
    files: CALLER_INFLUENCED_FS_MODULES,
    rules: {
      "security/detect-non-literal-fs-filename": "warn",
    },
  },
];

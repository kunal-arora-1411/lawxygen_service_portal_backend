// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The type-aware rules are the reason this project pins TypeScript to 6.0.3 rather than
 * taking 7.x: typescript-eslint does not support TS 7, and `no-floating-promises` /
 * `no-misused-promises` are what stop an unawaited write in a payment path from silently
 * doing nothing. On this codebase that is a money bug, not a style violation.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "src/db/migrations/**",
      // Linting the flat config with type-aware rules requires putting it in the
      // tsconfig project, where it does not belong. It is 30 lines of configuration.
      "eslint.config.mjs",
      // PM2's process file: CommonJS, loaded by PM2, never part of the build.
      "ecosystem.config.cjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // Tests assert against JSON response bodies and raw SQL rows, both of which are
    // inherently `any`. Typing every assertion target adds ceremony without catching
    // anything — the assertion itself is the check.
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // Scripts are run by a person at a terminal and their whole output is the point.
    // The structured logger is for the server, where something else reads the logs.
    files: ["scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
);

import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
  },
  fmt: {
    ignorePatterns: [
      ".astro/**",
      ".git/**",
      ".superpowers/**",
      ".wrangler/**",
      "dist/**",
      "node_modules/**",
      "src/generated/**",
      ".dev.vars",
      "pnpm-lock.yaml",
      "skills/**",
    ],
    sortPackageJson: { sortScripts: true },
  },
  lint: {
    ignorePatterns: [
      ".astro/**",
      ".superpowers/**",
      ".wrangler/**",
      "dist/**",
      "node_modules/**",
      "src/generated/**",
      "skills/**",
    ],
    rules: {
      curly: ["error", "all"],
      "typescript/await-thenable": "off",
      "typescript/no-base-to-string": "off",
      "typescript/unbound-method": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: {
      tasks: true, // Cache task definitions (default: true)
    },

    tasks: {
      format: {
        command: "vp fmt --write",
        input: [
          "**/package.json",
          "**/{src,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
          "!**/dist/**/*",
          "!**/node_modules/**/*",
        ],
      },

      lint: {
        command: "vp lint --fix --quiet",
        input: [
          "**/{src,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
          "!**/dist/**/*",
          "!**/node_modules/**/*",
        ],
      },

      check: {
        command: "vp check --fix",
        input: [
          "**/vite.config.ts",
          "**/package.json",
          "**/*.{ts,tsx,js,jsx,mjs,cjs,astro,css,toml,json,yaml}",
          "!**/dist/**/*",
          "!**/node_modules/**/*",
        ],
      },

      bundle: {
        command: "vp run -r bundle",
        input: ["**/*.ts", "!**/dist/**/*", "!**/node_modules/**/*"],
      },

      test: {
        command: "vp test",
        input: ["**/tests?/**/*.ts", "**/*.test.ts", "!**/dist/**/*", "!**/node_modules/**/*"],
      },
    },
  },
});

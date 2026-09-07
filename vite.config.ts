import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const solidityRoot = fileURLToPath(new URL("./solidity/", import.meta.url));
const solidityProjects = readdirSync(solidityRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`${solidityRoot}${entry.name}/foundry.toml`))
  .map((entry) => entry.name)
  .sort();

// A project opts into extra root-level checks by defining a `check:extra` script.
// vp inlines the filtered run as package tasks, so it executes in the project directory.
function checkExtra(project: string): string[] {
  const manifest = JSON.parse(readFileSync(`${solidityRoot}${project}/package.json`, "utf8")) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts?.["check:extra"]
    ? [`vp run --filter ./solidity/${project} check:extra`]
    : [];
}

export default defineConfig({
  // Pre-commit runs this on the staged files. Everything else is covered by the check task inputs.
  staged: {
    "*": "vp run check",
  },
  test: {
    globals: true,
    include: ["**/test/**/*.test.ts", "!**/solidity/**/*"],
  },
  fmt: {
    ignorePatterns: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
      "**/.astro/**",
      "**/.git/**",
      "**/.superpowers/**",
      "**/.wrangler/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/src/generated/**",
      "**/*generated*",
      "**/.dev.vars",
      "**/pnpm-lock.yaml",
      "skills/**",
      "!**/solidity/**/*",
    ],
    sortPackageJson: { sortScripts: true },
  },
  lint: {
    // Disabled until the anti-slop rules and existing findings have been reviewed.
    /*
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    ],
    */
    ignorePatterns: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
      "**/.astro/**",
      "**/.superpowers/**",
      "**/.wrangler/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/src/generated/**",
      "**/*generated*",
      "**/skills/**",
      "!**/solidity/**/*",
    ],
    rules: {
      /*
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      */
      curly: ["error", "all"],
      "typescript/await-thenable": "off",
      "typescript/no-base-to-string": "off",
      "typescript/unbound-method": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: {
      scripts: false, // scripts have side effects outside the tree; never replay them
      tasks: true, // Cache task definitions (default: true)
    },

    tasks: {
      // NOTE: just use `check` always
      // format: {
      //   command: "vp fmt --write",
      //   input: [
      //     "**/package.json",
      //     "**/{src,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      //     "!**/dist/**/*",
      //     "!**/node_modules/**/*",
      //   ],
      // },

      // NOTE: just use `check` always
      // lint: {
      //   command: "vp lint --fix --quiet",
      //   input: [
      //     "**/{src,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      //     "!**/dist/**/*",
      //     "!**/node_modules/**/*",
      //   ],
      // },

      check: {
        command: "vp check --fix",
        input: [
          "**/vite.config.ts",
          "**/package.json",
          "**/*.{ts,tsx,js,jsx,mjs,cjs,astro,css,toml,json}",
          "!**/dist/**/*",
          "!**/node_modules/**/*",
          "!**/solidity/**/*",
          "!**/src/generated/**",
          "!**/*generated*",
        ],
      },

      // bundle: {
      //   command: "vp run -r bundle",
      //   input: ["**/*.ts", "!**/dist/**/*", "!**/node_modules/**/*"],
      // },

      // Builds publishable packages in dependency order before publishing. A package that emits
      // or bundles declares a build script; packages without one are published as they are.
      build: {
        command:
          "if jq -es 'map(.scripts.build) | any' packages/*/package.json > /dev/null; then vp run --filter './packages/*' build; fi",
        input: ["packages/*/**", "!**/dist/**", "!**/node_modules/**", "!**/test/**"],
        output: ["packages/*/dist/**"],
      },

      test: {
        command: "vp test",
        input: [
          "**/tests?/**/*.ts",
          "**/*.test.ts",
          "!**/dist/**/*",
          "!**/node_modules/**/*",
          "!**/solidity/**/*",
          "!**/src/generated/**",
          "!**/*generated*",
        ],
      },

      "solidity:test": {
        command: solidityProjects.map((project) => `forge test --root solidity/${project}`),
        input: [{ auto: true }, "!**/out/**", "!**/cache/**", "!**/node_modules/**"],
        output: [],
      },

      "solidity:check": {
        command: solidityProjects.flatMap((project) => [
          [
            `forge fmt --root solidity/${project}`,
            `forge lint --deny warnings --root solidity/${project}`,
            `forge test --root solidity/${project}`,
            `forge build --root solidity/${project}`,
          ].join(" && "),
          ...checkExtra(project),
        ]),
        input: [{ auto: true }, "!**/out/**", "!**/cache/**", "!**/node_modules/**"],
        output: [],
      },
    },
  },
});

import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // The repository was formatted at 100 columns with trailing commas everywhere; keep that.
  printWidth: 100,
  trailingComma: "all",
  sortPackageJson: { sortScripts: true },
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
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
    "**/.superpowers/**",
    "**/.cloudflare/**",
    "**/preview/**",
    "**/src/generated/**",
    "**/*generated*",
    "**/.dev.vars",
    "skills/**",
    "**/solidity/**",
    "crates/**",
  ],
});

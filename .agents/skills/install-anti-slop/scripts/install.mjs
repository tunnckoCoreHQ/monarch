#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = realpathSync(resolve(skillRoot, "assets/anti-slop"));
const arguments_ = process.argv.slice(2);
const targetArgument = arguments_.find((argument) => !argument.startsWith("--"));
const target = resolve(process.cwd(), targetArgument ?? "tools/oxlint/anti-slop");
const force = arguments_.includes("--force");
const resolvedTarget = existsSync(target) ? realpathSync(target) : target;
const relativeTarget = relative(process.cwd(), resolvedTarget);

if (
  relativeTarget === "" ||
  relativeTarget === ".." ||
  relativeTarget.startsWith(`..${sep}`) ||
  isAbsolute(relativeTarget) ||
  resolvedTarget === source ||
  source.startsWith(`${resolvedTarget}${sep}`) ||
  resolvedTarget.startsWith(`${source}${sep}`)
) {
  console.error("The destination must be inside the current repository and separate from the bundled assets.");
  process.exit(1);
}

if (existsSync(target) && !force) {
  console.error(`Refusing to overwrite ${target}. Re-run with --force only after reviewing the existing files.`);
  process.exit(1);
}

if (force) {
  rmSync(target, { recursive: true, force: true });
}
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true, force });
console.log(`Copied the anti-slop plugin to ${target}`);
console.log(`Configure Oxlint with: ${target}/index.ts`);
